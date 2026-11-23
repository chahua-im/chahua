use diesel::prelude::*;

use super::*;

#[tokio::test]
async fn unauthenticated_ordinary_calls_are_rejected_before_scheduling() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let shared = SessionShared::new(TransportState::new());
    let (controls, _controls_rx) = mpsc::channel(CONTROL_QUEUE);
    let (results, _results_rx) = mpsc::channel(RESULT_QUEUE);
    let (guard_failures, _guard_rx) = mpsc::unbounded_channel();
    let admission = SessionAdmission {
        ordinary: Arc::new(Semaphore::new(0)),
        controls: Arc::new(Semaphore::new(0)),
    };
    let ordinary_admission = admission::Admission::new(0, 0, 0, 0);
    let mut execution = SessionExecution {
        shared,
        services: services.clone(),
        controls,
        guard_failures,
        results,
        admission,
        ordinary_admission,
        next_sync_seq: 0,
    };
    for method in ["users.getMe", "groups.create"] {
        for destination in [ResultDestination::Single, ResultDestination::Batch(0)] {
            for id in [Some(RpcId::String("request".into())), None] {
                let mut outstanding = HashSet::new();
                let scheduled = schedule_call(
                    RpcCall {
                        id: id.clone(),
                        method: method.into(),
                        params: None,
                    },
                    Instant::now(),
                    destination,
                    false,
                    &mut execution,
                    &mut outstanding,
                )
                .await;
                let ScheduledCall::Immediate(response) = scheduled else {
                    panic!("unauthenticated {method} must be rejected before task creation");
                };
                if let Some(id) = &id {
                    let response: Value =
                        serde_json::from_str(&response.expect("request response").text).unwrap();
                    assert_eq!(response["id"], "request");
                    assert_eq!(response["error"]["code"], 1001);
                    assert_eq!(
                        outstanding.contains(id),
                        matches!(destination, ResultDestination::Batch(_)),
                        "batch IDs remain reserved until the aggregate is queued",
                    );
                } else {
                    assert!(response.is_none(), "notifications must not receive replies");
                }
            }
        }
    }
}

pub(super) async fn open_with_admission(
    services: RpcServices,
    admission: Arc<admission::Admission>,
    label: &str,
) -> (
    RpcSessionInput,
    RpcSessionOutput,
    tokio::task::JoinHandle<()>,
) {
    let token = services
        .auth_token_service
        .issue_session(1, label, 0)
        .unwrap();
    let (input_rx, output_tx, mut dependencies, transport) = rpc_session_channels(services);
    dependencies.ordinary_admission = admission;
    let task = tokio::spawn(serve_rpc_session(input_rx, output_tx, dependencies));
    let RpcSessionTransport { input, mut output } = transport;
    input
        .send(
            json!({
                "jsonrpc":"2.0", "id":"open", "method":"session.open",
                "params":{"protocolVersion":1,"token":token,"appVersion":"rpc-admission-test"}
            })
            .to_string(),
        )
        .await
        .unwrap();
    let response = receive_json(&mut output).await;
    assert_eq!(response["id"], "open");
    assert_eq!(response["result"]["authenticated"], true);
    (input, output, task)
}

pub(super) async fn hold_capacity(admission: &Arc<admission::Admission>) -> admission::Permit {
    let connection = Arc::new(Semaphore::new(1));
    let metrics = Arc::new(crate::metrics::RpcAdmissionMetrics::new(
        &prometheus::Registry::new(),
    ));
    admission
        .request(
            1,
            &connection,
            tokio::time::Instant::now() + Duration::from_secs(60),
            &metrics,
        )
        .expect("capacity available")
        .wait()
        .await
}

pub(super) async fn barrier(input: &RpcSessionInput, output: &mut RpcSessionOutput) {
    input.send(json!({"jsonrpc":"2.0","id":"barrier","method":"session.ping","params":{"state":"inactive"}}).to_string()).await.unwrap();
    let response = receive_json(output).await;
    assert_eq!(response["id"], "barrier");
    assert!(response.get("result").is_some(), "{response}");
}

async fn group_count(services: &RpcServices, name: &str) -> i64 {
    crate::schema::groups::table
        .filter(crate::schema::groups::name.eq(name))
        .count()
        .get_result::<i64>(&mut services.db.get().unwrap())
        .unwrap()
}

#[tokio::test]
async fn waiting_read_does_not_block_control_and_succeeds_after_release() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let admission = admission::Admission::new(1, 1, 256, 64);
    let (input, mut output, task) =
        open_with_admission(services.clone(), admission.clone(), "admission-read").await;
    let held = hold_capacity(&admission).await;
    input
        .send(json!({"jsonrpc":"2.0","id":"read","method":"users.getMe"}).to_string())
        .await
        .unwrap();
    barrier(&input, &mut output).await;
    assert!(services
        .metrics
        .render()
        .unwrap()
        .contains("rpc_admission_queue_depth 1\n"));
    drop(held);
    let response = receive_json(&mut output).await;
    assert_eq!(response["id"], "read");
    assert!(response.get("result").is_some(), "{response}");
    assert!(response.get("error").is_none(), "{response}");
    let metrics = services.metrics.render().unwrap();
    assert!(metrics.contains("rpc_admission_queue_depth 0\n"));
    assert!(metrics.contains("rpc_admission_wait_duration_seconds_count{outcome=\"started\"} 1\n"));
    close_session(input, output, task).await;
}

#[tokio::test]
async fn expired_queued_mutation_reports_overload_without_executing() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let admission = admission::Admission::new(1, 1, 256, 64);
    let (input, mut output, task) =
        open_with_admission(services.clone(), admission.clone(), "admission-expiry").await;
    let held = hold_capacity(&admission).await;
    tokio::time::pause();
    let name = "expired queued mutation must not execute";
    input.send(json!({"jsonrpc":"2.0","id":"mutation","method":"groups.create","params":{"name":name}}).to_string()).await.unwrap();
    barrier(&input, &mut output).await;
    tokio::time::advance(Duration::from_secs(5)).await;
    let response = receive_json(&mut output).await;
    assert_eq!(response["id"], "mutation");
    assert_eq!(response["error"]["code"], 1429);
    drop(held);
    close_session(input, output, task).await;
    assert_eq!(group_count(&services, name).await, 0);
}

#[tokio::test]
async fn disconnect_cancels_queued_mutation_before_capacity_is_released() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let admission = admission::Admission::new(1, 1, 256, 64);
    let (input, mut output, task) =
        open_with_admission(services.clone(), admission.clone(), "admission-disconnect").await;
    let held = hold_capacity(&admission).await;
    let name = "disconnected queued mutation must not execute";
    input.send(json!({"jsonrpc":"2.0","id":"mutation","method":"groups.create","params":{"name":name}}).to_string()).await.unwrap();
    barrier(&input, &mut output).await;
    close_session(input, output, task).await;
    drop(held);
    // Acquiring the sole slot after the disconnected request ensures any
    // previously granted work has finished before inspecting the database.
    let probe = hold_capacity(&admission).await;
    assert_eq!(group_count(&services, name).await, 0);
    drop(probe);
}
