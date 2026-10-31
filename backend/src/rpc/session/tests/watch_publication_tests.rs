use std::sync::Arc;

use super::*;
use serde_json::Value;
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    task::JoinSet,
    time::{timeout, Duration},
};

use crate::{
    dto::{
        conversations::{ConversationRef, ConversationUnreadErrorPayload},
        ws::ServerWsMessage,
    },
    services::auth_token::{TokenVersion, VerifiedSession},
};

async fn bound_shared(
    services: &RpcServices,
) -> (
    Arc<SessionShared>,
    RpcOutputSink,
    mpsc::Receiver<String>,
    mpsc::Receiver<RpcFrameLease>,
) {
    let transport = TransportState::new();
    let shared = SessionShared::new(transport.clone());
    shared
        .bind(
            services,
            VerifiedSession {
                uid: 1,
                client_id: "watch-publication-test".into(),
                generation: 0,
                version: TokenVersion::V2,
            },
        )
        .await
        .expect("test session binds");
    shared.state.lock().await.activated = true;
    let (tx, output) = mpsc::channel(4);
    let (permits, output_permits) = mpsc::channel(4);
    (
        shared,
        RpcOutputSink {
            tx,
            permits,
            pair_lock: Arc::new(Mutex::new(())),
            budget: RpcByteBudget::new(),
            state: transport,
        },
        output,
        output_permits,
    )
}

fn unread_watch(request_id: u32) -> unread::watch::UnreadWatch {
    unread::watch::UnreadWatch {
        request_id,
        generation: 0,
        views: vec![],
        app_badge: true,
    }
}

fn unread_error(generation: u64, request_id: u32) -> unread::watch::UnreadWatchEvent {
    unread::watch::UnreadWatchEvent {
        generation,
        message: ServerWsMessage::ConversationUnreadError(ConversationUnreadErrorPayload {
            request_id,
        }),
    }
}

async fn unread_generation(shared: &SessionShared) -> u64 {
    shared
        .state
        .lock()
        .await
        .bound
        .as_ref()
        .expect("bound session")
        .unread_subscription
        .borrow()
        .as_ref()
        .expect("installed unread watch")
        .generation
}

async fn states_generation(shared: &SessionShared) -> u64 {
    shared
        .state
        .lock()
        .await
        .bound
        .as_ref()
        .expect("bound session")
        .states_subscription
        .borrow()
        .as_ref()
        .expect("installed state watch")
        .generation
}

#[tokio::test]
async fn held_unread_forwarding_discards_replaced_generation_and_delivers_current_watch() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let (shared, sink, mut output, mut output_permits) = bound_shared(&services).await;
    shared
        .replace_unread_watch(Some(unread_watch(1)))
        .await
        .expect("first watch installs");
    let old_generation = unread_generation(&shared).await;

    // This bounded channel is the real async boundary after the shared watch
    // service has produced an event but before session final publication runs.
    let (events_tx, events) = mpsc::channel(2);
    events_tx
        .send(unread_error(old_generation, 1))
        .await
        .expect("old event becomes ready");
    shared
        .replace_unread_watch(Some(unread_watch(2)))
        .await
        .expect("replacement acknowledges before forwarding resumes");
    let current_generation = unread_generation(&shared).await;
    events_tx
        .send(unread_error(current_generation, 2))
        .await
        .expect("current event becomes ready");
    drop(events_tx);

    forward_owned_events(events, shared.clone(), sink.clone()).await;
    let text = timeout(Duration::from_secs(1), output.recv())
        .await
        .expect("current watch event publishes")
        .expect("output remains open");
    let _lease = output_permits.recv().await.expect("output lease");
    let message: Value = serde_json::from_str(&text).expect("JSON-RPC event");
    assert_eq!(message["method"], "events.conversationUnreadError");
    assert_eq!(message["params"]["requestId"], 2);
    assert!(timeout(Duration::from_millis(25), output.recv())
        .await
        .is_err());
    shared.remove_registration(&services).await;
}

#[tokio::test]
async fn held_unread_forwarding_discards_cleared_watch_and_invalid_replacement_keeps_current() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let (shared, sink, mut output, _output_permits) = bound_shared(&services).await;
    shared
        .replace_unread_watch(Some(unread_watch(7)))
        .await
        .expect("valid watch installs");
    let old_generation = unread_generation(&shared).await;
    let (events_tx, events) = mpsc::channel(1);
    events_tx
        .send(unread_error(old_generation, 7))
        .await
        .expect("old event becomes ready");
    shared
        .replace_states_watch(Some(unread::states::StateWatch {
            request_id: 8,
            generation: 0,
            conversations: vec![ConversationRef {
                chat_id: 1,
                thread_id: None,
            }],
        }))
        .await
        .expect("valid state watch installs");
    let old_states_generation = states_generation(&shared).await;
    let mut activity_tasks = JoinSet::new();
    let (reply, response) = oneshot::channel();
    handle_control(
        RpcControlCommand::WatchStates {
            params: ConversationsWatchStatesParams {
                request_id: 9,
                conversations: vec![
                    ConversationRef {
                        chat_id: 1,
                        thread_id: None,
                    },
                    ConversationRef {
                        chat_id: 1,
                        thread_id: None,
                    },
                ],
            },
            reply,
        },
        &shared,
        &services,
        &mut activity_tasks,
    )
    .await;
    assert_eq!(
        response.await.expect("control response").unwrap_err().code,
        RpcErrorCode::InvalidParams
    );
    assert_eq!(states_generation(&shared).await, old_states_generation);
    shared
        .replace_unread_watch(None)
        .await
        .expect("clear acknowledges");
    drop(events_tx);
    forward_owned_events(events, shared.clone(), sink).await;
    assert!(
        !matches!(
            timeout(Duration::from_millis(25), output.recv()).await,
            Ok(Some(_))
        ),
        "cleared watches cannot publish an obsolete event"
    );
    shared.remove_registration(&services).await;
}
