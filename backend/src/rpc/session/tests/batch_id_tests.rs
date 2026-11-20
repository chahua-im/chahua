use diesel::prelude::*;

use super::*;

async fn barrier(input: &RpcSessionInput, output: &mut RpcSessionOutput) {
    input.send(json!({"jsonrpc":"2.0","id":"barrier","method":"session.ping","params":{"state":"inactive"}}).to_string()).await.unwrap();
    assert_eq!(receive_json(output).await["id"], "barrier");
}

#[tokio::test]
async fn completed_batch_member_id_stays_outstanding_until_the_aggregate_is_queued() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "batch-id-lifetime", 0)
        .unwrap();
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;
    let held = services.db.get().unwrap();
    input.send(json!([
        {"jsonrpc":"2.0","id":"reuse","method":"session.ping","params":{"state":"inactive"}},
        {"jsonrpc":"2.0","id":"slow","method":"users.getMe"},
    ]).to_string()).await.unwrap();
    // This current-thread runtime observes the metric only after the fast
    // dispatch has queued its WorkResult. Its following barrier result is FIFO
    // behind that result, while the DB-backed batch member remains blocked.
    timeout(Duration::from_secs(5), async {
        while !services
            .metrics
            .render()
            .unwrap()
            .contains("api_requests_total{api=\"session.ping\",error_code=\"none\",status=\"200\",transport=\"rpc\"} 1\n")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fast batch member completed");
    barrier(&input, &mut output).await;
    // Keep the worker blocked long enough to verify its measured latency,
    // then close the session while that admitted work is still outstanding.
    tokio::time::sleep(Duration::from_millis(100)).await;
    input.send(json!({"jsonrpc":"2.0","id":"reuse","method":"groups.create","params":{"name":"must not execute reused batch ID"}}).to_string()).await.unwrap();
    let duplicate = receive_json(&mut output).await;
    assert_eq!(duplicate["id"], Value::Null);
    assert_eq!(duplicate["error"]["code"], -32600);
    drop(held);
    let metrics = timeout(Duration::from_secs(5), async {
        loop {
            let metrics = services.metrics.render().unwrap();
            if metrics.contains("api_requests_total{api=\"users.getMe\",error_code=\"none\",status=\"200\",transport=\"rpc\"} 1\n") {
                break metrics;
            }
            tokio::task::yield_now().await;
        }
    }).await.expect("disconnected worker records its outcome");
    let prefix =
        "api_request_duration_seconds_sum{api=\"users.getMe\",status=\"200\",transport=\"rpc\"} ";
    let duration = metrics
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .expect("worker latency is exported")
        .parse::<f64>()
        .unwrap();
    assert!(duration >= 0.1, "worker wait must be included: {duration}");
    close_session(input, output, task).await;
    let created = crate::schema::groups::table
        .filter(crate::schema::groups::name.eq("must not execute reused batch ID"))
        .count()
        .get_result::<i64>(&mut services.db.get().unwrap())
        .unwrap();
    assert_eq!(
        created, 0,
        "an ID buffered inside a pending batch cannot execute a second mutation"
    );
}

#[tokio::test]
async fn queued_batch_member_id_is_reserved_until_the_aggregate_is_queued() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let admission = admission::Admission::new(1, 1, 256, 64);
    let (input, mut output, task) = super::admission_tests::open_with_admission(
        services.clone(),
        admission.clone(),
        "queued-batch-id",
    )
    .await;
    let held = super::admission_tests::hold_capacity(&admission).await;
    input.send(json!([
        {"jsonrpc":"2.0","id":"queued-read","method":"users.getMe"},
        {"jsonrpc":"2.0","id":"batch-ping","method":"session.ping","params":{"state":"inactive"}}
    ]).to_string()).await.unwrap();
    barrier(&input, &mut output).await;
    drop(held);
    let aggregate = receive_json(&mut output).await;
    let members = aggregate
        .as_array()
        .expect("batch response is an aggregate");
    assert_eq!(members.len(), 2);
    for id in ["queued-read", "batch-ping"] {
        let member = members
            .iter()
            .find(|member| member["id"] == id)
            .expect("batch member");
        assert!(member.get("result").is_some(), "{member}");
        assert!(member.get("error").is_none(), "{member}");
    }
    let held = super::admission_tests::hold_capacity(&admission).await;
    input.send(json!([
        {"jsonrpc":"2.0","id":"queued-duplicate","method":"users.getMe"},
        {"jsonrpc":"2.0","id":"second-ping","method":"session.ping","params":{"state":"inactive"}}
    ]).to_string()).await.unwrap();
    barrier(&input, &mut output).await;
    input.send(json!({"jsonrpc":"2.0","id":"queued-duplicate","method":"groups.create","params":{"name":"queued duplicate must not execute"}}).to_string()).await.unwrap();
    let duplicate = receive_json(&mut output).await;
    assert_eq!(duplicate["id"], Value::Null);
    assert_eq!(duplicate["error"]["code"], -32600);
    drop(held);
    close_session(input, output, task).await;
    let created = crate::schema::groups::table
        .filter(crate::schema::groups::name.eq("queued duplicate must not execute"))
        .count()
        .get_result::<i64>(&mut services.db.get().unwrap())
        .unwrap();
    assert_eq!(created, 0);
}
