use super::*;
use super::{
    batches::{flush_batch, BatchAssembly},
    controls::{generation_checks, handle_control},
    execution::{
        schedule_call, ResultDestination, ScheduledCall, SessionAdmission, SessionExecution,
    },
    io::{RpcOutputSink, TransportState},
    publishers::forward_owned_events,
    response::{prepare_recorded, prepare_response},
    state::SessionShared,
};
use crate::{
    rpc::{
        protocol::{RpcCall, RpcId, RpcResponse},
        AppState,
    },
    services::{auth_token::VerifiedSession, unread},
};
use serde_json::json;
use serde_json::Value;
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, Semaphore},
    time::{timeout, Instant},
};
// In-memory driver for tests; production drives RpcSession directly from the socket task.
pub(super) struct RpcSessionInput {
    tx: mpsc::Sender<String>,
    state: Arc<TransportState>,
}
impl RpcSessionInput {
    pub(super) async fn send(&self, text: String) -> Result<(), RpcIoError> {
        if self.state.is_closed() {
            return Err(RpcIoError::Closed);
        }
        let mut close = self.state.close_subscription();
        let slot = tokio::select! {
            slot = self.tx.reserve() => slot.map_err(|_| RpcIoError::Closed)?,
            () = self.state.wait_closed(&mut close) => return Err(RpcIoError::Closed),
        };
        if self.state.is_closed() {
            return Err(RpcIoError::Closed);
        }
        slot.send(text);
        Ok(())
    }
    pub(super) fn close(&self) {
        self.state.close();
    }
}
pub(super) struct RpcSessionTransport {
    pub(super) input: RpcSessionInput,
    pub(super) output: RpcSessionOutput,
}
pub(super) struct RpcSessionDeps {
    services: AppState,
    ordinary_admission: Arc<admission::Admission>,
    state: Arc<TransportState>,
}
pub(super) fn rpc_session_channels(
    services: AppState,
) -> (
    mpsc::Receiver<String>,
    mpsc::Sender<String>,
    RpcSessionDeps,
    RpcSessionTransport,
) {
    let state = TransportState::new();
    let (tx, input) = mpsc::channel(16);
    let (output, rx) = mpsc::channel(OUTPUT_QUEUE);
    let deps = RpcSessionDeps {
        services,
        ordinary_admission: execution::GLOBAL_ADMISSION.clone(),
        state: state.clone(),
    };
    (
        input,
        output,
        deps,
        RpcSessionTransport {
            input: RpcSessionInput { tx, state },
            output: RpcSessionOutput { rx },
        },
    )
}
pub(super) async fn serve_rpc_session(
    mut input: mpsc::Receiver<String>,
    output: mpsc::Sender<String>,
    deps: RpcSessionDeps,
) {
    let mut engine = RpcSession::with_channels(
        deps.services,
        deps.ordinary_admission,
        deps.state.clone(),
        output,
    );
    loop {
        if deps.state.is_closed() {
            break;
        }
        tokio::select! {
            event = engine.next_event() => {
                if engine.handle_event(event).await.is_break() {break;}
            }
            text = input.recv(), if engine.accepts_input() => {
                let Some(text) = text else { break; };
                if engine.handle_text(text).await.is_break() {break;}
            }
        }
    }
    engine.shutdown().await;
}

async fn receive_json(output: &mut RpcSessionOutput) -> Value {
    timeout(Duration::from_secs(5), async {
        loop {
            let text = output.recv().await.expect("RPC output remains open");
            let message: Value = serde_json::from_str(&text).expect("valid JSON-RPC message");
            if message["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("events."))
            {
                continue;
            }
            return message;
        }
    })
    .await
    .expect("RPC protocol response deadline")
}

async fn open_authenticated(
    services: AppState,
    token: String,
) -> (
    RpcSessionInput,
    RpcSessionOutput,
    tokio::task::JoinHandle<()>,
) {
    let (input_rx, output_tx, dependencies, transport) = rpc_session_channels(services);
    let task = tokio::spawn(serve_rpc_session(input_rx, output_tx, dependencies));
    let RpcSessionTransport { input, mut output } = transport;
    input
        .send(
            json!({
                "jsonrpc": "2.0",
                "id": "open",
                "method": "session.open",
                "params": {
                    "protocolVersion": 1,
                    "token": token,
                    "appVersion": "rpc-session-test",
                },
            })
            .to_string(),
        )
        .await
        .expect("session input accepts handshake");
    let response = receive_json(&mut output).await;
    assert_eq!(response["id"], "open");
    assert_eq!(response["result"]["authenticated"], true);
    (input, output, task)
}

async fn close_session(
    input: RpcSessionInput,
    output: RpcSessionOutput,
    task: tokio::task::JoinHandle<()>,
) {
    input.close();
    drop(input);
    drop(output);
    timeout(Duration::from_secs(5), task)
        .await
        .expect("RPC session cleanup deadline")
        .expect("RPC session completes successfully");
}

#[tokio::test]
async fn oversized_response_records_payload_too_large() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let oversized = RpcResponse::success(RpcId::Null, Value::String("x".repeat(MAX_FRAME_BYTES)));
    let prepared = prepare_recorded(
        &services,
        "session.ping",
        Instant::now(),
        Some(oversized),
        None,
    )
    .unwrap()
    .unwrap();
    assert!(!prepared.success);
    let response: Value = serde_json::from_str(&prepared.text).unwrap();
    assert_eq!(response["error"]["code"], 1013);
    let metrics = services.metrics.render().unwrap();
    assert!(metrics.contains("api_requests_total{api=\"session.ping\",error_code=\"1013\",status=\"413\",transport=\"rpc\"} 1\n"));
}

#[tokio::test]
async fn batch_calls_notifications_and_errors_are_counted_individually() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
        .unwrap();
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;
    input
        .send(
            json!([
                {"jsonrpc":"2.0","id":"ok","method":"session.ping","params":{}},
                {"jsonrpc":"2.0","method":"session.ping","params":{}},
                {"jsonrpc":"2.0","id":"bad","method":"session.ping","params":[]},
                {"jsonrpc":"2.0","id":"unknown","method":"arbitrary.unregistered"},
                {"jsonrpc":"2.0","id":"peer-response","result":null}
            ])
            .to_string(),
        )
        .await
        .unwrap();
    let response = receive_json(&mut output).await;
    assert_eq!(response.as_array().unwrap().len(), 3);
    timeout(Duration::from_secs(5), async {
        loop {
            let metrics = services.metrics.render().unwrap();
            if metrics.contains("api_requests_total{api=\"session.ping\",error_code=\"none\",status=\"200\",transport=\"rpc\"} 2\n")
                && metrics.contains("api_requests_total{api=\"session.ping\",error_code=\"-32602\",status=\"400\",transport=\"rpc\"} 1\n")
                && metrics.contains("api_requests_total{api=\"unknown\",error_code=\"-32601\",status=\"404\",transport=\"rpc\"} 1\n") {
                assert!(!metrics.contains("arbitrary.unregistered"));
                break;
            }
            tokio::task::yield_now().await;
        }
    }).await.expect("all batch calls recorded");
    close_session(input, output, task).await;
}

#[tokio::test]
async fn authenticated_session_verifies_once_across_operations_and_refresh() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
        .unwrap();
    let (input, mut output, task) = open_authenticated(services.clone(), token.clone()).await;
    assert_eq!(services.auth_token_service.verifier_invocations(), 1);

    for id in 0..10 {
        input
            .send(
                json!({
                    "jsonrpc": "2.0",
                    "id": format!("ping-{id}"),
                    "method": "session.ping",
                    "params": {},
                })
                .to_string(),
            )
            .await
            .unwrap();
        let response = receive_json(&mut output).await;
        assert_eq!(response["id"], format!("ping-{id}"));
        assert_eq!(response["result"], Value::Null);
    }
    for id in 0..10 {
        input
            .send(
                json!({
                    "jsonrpc": "2.0",
                    "id": format!("me-{id}"),
                    "method": "users.getMe",
                    "params": {},
                })
                .to_string(),
            )
            .await
            .unwrap();
        let response = receive_json(&mut output).await;
        assert_eq!(response["id"], format!("me-{id}"));
        assert_eq!(response["result"]["uid"], 1);
    }
    input
        .send(
            json!({
                "jsonrpc": "2.0",
                "id": "refresh",
                "method": "auth.refresh",
                "params": {},
            })
            .to_string(),
        )
        .await
        .unwrap();
    assert!(receive_json(&mut output).await["result"]["token"].is_string());
    assert_eq!(services.auth_token_service.verifier_invocations(), 1);
    close_session(input, output, task).await;

    let (input, output, task) = open_authenticated(services.clone(), token).await;
    assert_eq!(services.auth_token_service.verifier_invocations(), 2);
    close_session(input, output, task).await;
}

#[tokio::test]
async fn in_memory_session_keeps_protocol_errors_and_duplicate_ids_transport_neutral() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
        .unwrap();
    let (input, mut output, task) = open_authenticated(services, token).await;

    input.send("{".into()).await.unwrap();
    assert_eq!(receive_json(&mut output).await["error"]["code"], -32700);

    input
        .send(
            json!([
                {
                    "jsonrpc": "2.0",
                    "id": "ping",
                    "method": "session.ping",
                    "params": {},
                },
                {
                    "jsonrpc": "2.0",
                    "id": "missing",
                    "method": "unknown.operation",
                    "params": {},
                },
                {
                    "jsonrpc": "2.0",
                    "method": "session.setAppState",
                    "params": {},
                },
            ])
            .to_string(),
        )
        .await
        .unwrap();
    let batch = receive_json(&mut output).await;
    let responses = batch.as_array().expect("batch response");
    assert_eq!(responses.len(), 2);
    assert!(responses
        .iter()
        .any(|response| response["id"] == "ping" && response.get("result").is_some()));
    assert!(responses
        .iter()
        .any(|response| response["id"] == "missing" && response["error"]["code"] == -32601));

    input
        .send(
            json!([
                {
                    "jsonrpc": "2.0",
                    "id": "duplicate",
                    "method": "session.ping",
                    "params": {},
                },
                {
                    "jsonrpc": "2.0",
                    "id": "duplicate",
                    "method": "session.ping",
                    "params": {},
                },
            ])
            .to_string(),
        )
        .await
        .unwrap();
    let duplicate = receive_json(&mut output).await;
    assert_eq!(duplicate["id"], Value::Null);
    assert_eq!(duplicate["error"]["code"], -32600);
    close_session(input, output, task).await;
}

#[tokio::test]
async fn revocation_rejects_the_correlated_call_before_session_invalidation() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
        .unwrap();
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;
    {
        let mut connection = services.db.get().unwrap();
        services.token_generation.bump(&mut connection, 1).unwrap();
    }

    input
        .send(
            json!({
                "jsonrpc": "2.0",
                "id": "after-revocation",
                "method": "session.ping",
                "params": {},
            })
            .to_string(),
        )
        .await
        .unwrap();
    let rejected = receive_json(&mut output).await;
    assert_eq!(rejected["id"], "after-revocation");
    assert_eq!(rejected["error"]["code"], 1001);
    let invalidated = receive_json(&mut output).await;
    assert_eq!(invalidated["method"], "session.invalidated");
    assert_eq!(invalidated["params"]["reason"], "revoked");
    close_session(input, output, task).await;
}

#[test]
fn response_size_limit_includes_the_json_envelope() {
    let envelope = serde_json::to_string(&RpcResponse::success(
        RpcId::String("size".into()),
        Value::String(String::new()),
    ))
    .unwrap()
    .len();
    for extra in [0, 1] {
        let response = prepare_response(RpcResponse::success(
            RpcId::String("size".into()),
            Value::String("x".repeat(MAX_FRAME_BYTES - envelope + extra)),
        ))
        .unwrap();
        let wire: Value = serde_json::from_str(&response.text).unwrap();
        assert_eq!(wire["id"], "size");
        if extra == 0 {
            assert_eq!(response.text.len(), MAX_FRAME_BYTES);
            assert!(wire.get("result").is_some());
        } else {
            assert_eq!(wire["error"]["code"], 1013);
        }
    }
}

#[tokio::test]
async fn oversized_batch_does_not_publish_a_partial_response() {
    let mut batch = BatchAssembly::new();
    for id in ["a", "b"] {
        let response = prepare_response(RpcResponse::success(
            RpcId::String(id.into()),
            Value::String("x".repeat(MAX_FRAME_BYTES / 2)),
        ))
        .unwrap();
        batch.push(response, false);
    }
    let (tx, mut output) = mpsc::channel(1);
    let sink = RpcOutputSink {
        tx,
        state: TransportState::new(),
    };
    assert!(matches!(
        flush_batch(batch, &sink).await,
        Err(RpcIoError::FrameTooLarge)
    ));
    assert!(output.try_recv().is_err());
}

mod activity_tests;

mod transport_tests;

mod watch_publication_tests;

mod protocol_tests;

mod batch_id_tests;

mod admission_tests;
