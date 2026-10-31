//! WebSocket handler: auth handshake, lifecycle-aware presence updates, ping/pong keepalive,
//! connection registry, 300s stale timeout.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::Json;
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::timeout;
use tracing::{debug, trace, warn};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::ws::{
    ClientWsMessage, OnlineClientConnectionResponse, ServerWsMessage, TicketResponse,
};
use crate::services::authentication::verify_session;
use crate::services::client_tracking::{
    record_header_activity, should_record_client_activity, ClientTrackingService,
};
use crate::services::presence::{
    parse_legacy_presence_watch, snapshot_after_pending_changes, PresenceChanges, PresenceWatch,
};
use crate::services::ws_registry;
use crate::utils::auth::BearerSession;
use crate::AppState;
use ws_registry::AppPresenceState;

#[utoipa::path(
    get,
    path = "/ticket",
    tag = "websocket",
    responses(
        (status = OK, body = TicketResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_ws_ticket(
    BearerSession(session): BearerSession,
    State(state): State<AppState>,
) -> Result<Json<TicketResponse>, crate::errors::AppError> {
    crate::services::api::ws::get_ws_ticket(&session, &state.auth_token_service).map(Json)
}

/// Lists the caller's current, fresh WebSocket connections.
#[utoipa::path(
    get,
    path = "/clients",
    tag = "websocket",
    responses(
        (status = OK, body = Vec<OnlineClientConnectionResponse>),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_online_clients(
    BearerSession(session): BearerSession,
    State(state): State<AppState>,
) -> Result<Json<Vec<OnlineClientConnectionResponse>>, crate::errors::AppError> {
    crate::services::api::ws::get_online_clients(
        &session,
        &state.ws_registry,
        &state.client_tracking,
    )
    .map(Json)
}

const PONG_JSON: &str = r#"{"type":"pong"}"#;
const PRESENCE_REFRESH_INTERVAL: Duration = Duration::from_secs(15);
const RPC_IO_TIMEOUT: Duration = Duration::from_secs(10);

fn record_active_ws_activity(
    activity_tasks: &mut tokio::task::JoinSet<()>,
    tracking: &Arc<ClientTrackingService>,
    uid: i32,
    client_id: &str,
    track_client: bool,
) {
    tracking.last_seen.record(uid, Utc::now().naive_utc());
    if track_client && activity_tasks.is_empty() {
        let tracking = tracking.clone();
        let client_id = client_id.to_owned();
        activity_tasks.spawn_blocking(move || {
            if let Err(error) = tracking.record_client_activity(uid, &client_id, None) {
                warn!(?error, uid, "failed to record ws activity");
            }
        });
    }
}

fn selects_rpc(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .as_object()
                .map(|object| object.contains_key("jsonrpc"))
        })
        .unwrap_or(false)
}

async fn load_legacy_header_activity(
    state: AppState,
    headers: HeaderMap,
) -> Result<(), crate::errors::AppError> {
    tokio::task::spawn_blocking(move || record_header_activity(&state, &headers))
        .await
        .map_err(|error| {
            warn!(?error, "legacy ws header activity task failed");
            crate::errors::AppError::Internal("Failed to record client activity")
        })?
}

async fn send_legacy_presence_snapshot(
    socket: &mut WebSocket,
    state: &AppState,
    uid: i32,
    watch: &PresenceWatch,
    changes: &mut PresenceChanges,
) -> bool {
    match snapshot_after_pending_changes(&state.presence_service, changes, uid, watch).await {
        Ok(payload) => match serde_json::to_string(&ServerWsMessage::PresenceSnapshot(payload)) {
            Ok(text) => socket.send(Message::Text(text.into())).await.is_ok(),
            Err(error) => {
                warn!(?error, "failed to serialize presence snapshot");
                true
            }
        },
        Err(error) => {
            warn!(?error, uid, "failed to load presence snapshot");
            true
        }
    }
}

/// Upgrades the connection to WebSocket and initiates auth handshake.
#[utoipa::path(
    get,
    path = "/",
    tag = "websocket",
    description = "WebSocket upgrade endpoint",
    responses(
        (status = 101, description = "Switching Protocols"),
    ),
)]
async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| handle_auth_and_socket(socket, state, headers))
}

async fn handle_auth_and_socket(mut socket: WebSocket, state: AppState, headers: HeaderMap) {
    // The selected protocol is fixed by the first complete text message. In particular,
    // malformed JSON remains a silent legacy-compatible negotiation failure.
    let first_text = match timeout(Duration::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => return,
    };

    if selects_rpc(&first_text) {
        handle_rpc_socket(socket, state, first_text.to_string()).await;
        return;
    }

    // Header authentication used to run in HTTP middleware before upgrade. It is
    // deliberately deferred until after legacy selection, so an RPC upgrade cannot
    // authenticate or track a header identity. A persistence error now has no HTTP
    // response channel; close before ticket verification or registry registration.
    let track_client = should_record_client_activity(&headers);
    if let Err(error) = load_legacy_header_activity(state.clone(), headers).await {
        warn!(?error, "legacy ws header activity rejected");
        return;
    }

    let Ok(ClientWsMessage::Auth { ticket }) = serde_json::from_str::<ClientWsMessage>(&first_text)
    else {
        return;
    };
    let session = match verify_session(
        &ticket,
        &state.auth_token_service,
        &state.token_generation,
        &state.db,
    ) {
        Ok(session) => session,
        Err(error) => {
            debug!(?error, "ws auth rejected (invalid ticket)");
            return;
        }
    };

    let uid = session.uid;
    let client_id = session.client_id;
    let registry = state.ws_registry.clone();
    let (entry, rx) = registry.register(uid, client_id);
    handle_socket(socket, state, uid, registry, entry, rx, track_client).await;
}

fn rpc_services(state: &AppState) -> crate::rpc::RpcServices {
    crate::rpc::RpcServices::new(crate::rpc::RpcServiceHandles {
        db: state.db.clone(),
        id_gen: state.id_gen.clone(),
        metrics: state.metrics.clone(),
        config: state.config.clone(),
        media: state.media.clone(),
        avatars: state.avatars.clone(),
        authz_service: state.authz_service.clone(),
        ws_registry: state.ws_registry.clone(),
        presence_service: state.presence_service.clone(),
        push_service: state.push_service.clone(),
        unread_service: state.unread_service.clone(),
        client_tracking: state.client_tracking.clone(),
        background_service: state.background_service.clone(),
        message_search: state.message_search.clone(),
        auth_token_service: state.auth_token_service.clone(),
        token_generation: state.token_generation.clone(),
    })
}

async fn handle_rpc_socket(socket: WebSocket, state: AppState, first_text: String) {
    let (input_rx, output_tx, dependencies, transport) =
        crate::rpc::session::rpc_session_channels(rpc_services(&state));
    let mut session_task = tokio::spawn(crate::rpc::session::serve_rpc_session(
        input_rx,
        output_tx,
        dependencies,
    ));
    let crate::rpc::session::RpcSessionTransport { input, mut output } = transport;

    if !matches!(
        timeout(RPC_IO_TIMEOUT, input.send(first_text)).await,
        Ok(Ok(()))
    ) {
        input.close();
        let _ = timeout(RPC_IO_TIMEOUT, &mut session_task).await;
        return;
    }

    let (mut writer, mut reader) = socket.split();
    loop {
        tokio::select! {
            incoming = reader.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if !matches!(
                        timeout(RPC_IO_TIMEOUT, input.send(text.to_string())).await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                }
                Some(Ok(Message::Binary(_))) => {
                    let _ = timeout(
                        RPC_IO_TIMEOUT,
                        writer.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                            code: 1003,
                            reason: "binary frames are not supported".into(),
                        }))),
                    ).await;
                    break;
                }
                Some(Ok(Message::Ping(payload))) => {
                    if !matches!(
                        timeout(RPC_IO_TIMEOUT, writer.send(Message::Pong(payload))).await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let _ = timeout(RPC_IO_TIMEOUT, writer.send(Message::Close(frame))).await;
                    break;
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Err(_)) | None => break,
            },
            outbound = output.recv() => match outbound {
                Some(frame) => {
                    let (text, lease) = frame.into_parts();
                    let sent = timeout(
                        RPC_IO_TIMEOUT,
                        writer.send(Message::Text(text.into())),
                    ).await;
                    drop(lease);
                    if !matches!(sent, Ok(Ok(()))) {
                        break;
                    }
                }
                None => break,
            },
        }
    }

    input.close();
    drop(output);
    let _ = timeout(RPC_IO_TIMEOUT, &mut session_task).await;
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    uid: i32,
    registry: Arc<ws_registry::ConnectionRegistry>,
    entry: Arc<ws_registry::ConnectionEntry>,
    mut rx: tokio::sync::mpsc::Receiver<Arc<ServerWsMessage>>,
    track_client: bool,
) {
    let conn_id = entry.conn_id;
    let started_at = Instant::now();
    let mut presence_changes = state.presence_service.subscribe_changes();
    let mut activity_tasks = tokio::task::JoinSet::new();
    let mut watch: Option<PresenceWatch> = None;
    let (unread_subscription, unread_receiver) = tokio::sync::watch::channel(None);
    let (unread_output, mut unread_messages) = tokio::sync::mpsc::channel(1);
    let unread_task = tokio::spawn(crate::services::unread::watch::run(
        state.db.clone(),
        state.unread_service.clone(),
        uid,
        entry.unread_changed.clone(),
        unread_receiver,
        unread_output,
    ));
    let mut unread_request_id = None;
    let (states_subscription, states_receiver) = tokio::sync::watch::channel(None);
    let (states_output, mut states_messages) = tokio::sync::mpsc::channel(1);
    let states_task = tokio::spawn(crate::services::unread::states::run(
        state.db.clone(),
        state.unread_service.clone(),
        uid,
        entry.states_changed.clone(),
        states_receiver,
        states_output,
    ));
    let mut states_request_id = None;
    let mut presence_refresh =
        tokio::time::interval_at(tokio::time::Instant::now(), PRESENCE_REFRESH_INTERVAL);
    loop {
        tokio::select! {
            Some(result) = activity_tasks.join_next(), if !activity_tasks.is_empty() => {
                if let Err(error) = result {
                    warn!(?error, uid, "ws activity task failed");
                }
            }
            // A live socket with a dropped event cannot safely skip foreground calibration.
            _ = entry.lagged.notified() => break,
            Some(message) = states_messages.recv() => {
                let request_id = match &message {
                    ServerWsMessage::ConversationStates(payload) => payload.request_id,
                    ServerWsMessage::ConversationStatesError(payload) => payload.request_id,
                    _ => unreachable!(),
                };
                if states_request_id != Some(request_id) { continue; }
                if let Ok(text) = serde_json::to_string(&message) {
                    if socket.send(Message::Text(text.into())).await.is_err() { break; }
                }
            }
            Some(message) = unread_messages.recv() => {
                let request_id = match &message {
                    ServerWsMessage::ConversationUnread(payload) => payload.request_id,
                    ServerWsMessage::ConversationUnreadError(payload) => payload.request_id,
                    _ => unreachable!(),
                };
                if unread_request_id != Some(request_id) { continue; }
                if let Ok(text) = serde_json::to_string(&message) {
                    if socket.send(Message::Text(text.into())).await.is_err() { break; }
                }
            }
            msg = rx.recv() => {
                match msg {
                    Some(ws_msg) => {
                        if let Ok(text) = serde_json::to_string(&*ws_msg) {
                            if socket.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    None => break,
                }
            }
            change = presence_changes.recv() => {
                let Some(watch) = watch.as_ref() else {
                    continue;
                };
                let relevant = !watch.user_ids.is_empty()
                    && change.map_or(true, |change| change.affects(uid, &watch.user_ids));
                if relevant && !send_legacy_presence_snapshot(&mut socket, &state, uid, watch, &mut presence_changes).await {
                    break;
                }
            }
            _ = presence_refresh.tick(), if watch.is_some() => {
                let Some(watch) = watch.as_ref() else {
                    continue;
                };
                if !send_legacy_presence_snapshot(&mut socket, &state, uid, watch, &mut presence_changes).await {
                    break;
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(message) = serde_json::from_str::<ClientWsMessage>(&text) else {
                            continue;
                        };
                        match message {
                            ClientWsMessage::Ping { state: ping_state } => {
                                let app_state = ping_state
                                    .map(AppPresenceState::from)
                                    .unwrap_or(AppPresenceState::Active);
                                entry.update_ping(app_state);
                                registry.refresh_metrics();
                                trace!("ws ping received uid={} conn_id={}", uid, conn_id);
                                if app_state == AppPresenceState::Active {
                                    record_active_ws_activity(
                                        &mut activity_tasks,
                                        &state.client_tracking,
                                        uid,
                                        &entry.client_id,
                                        track_client,
                                    );
                                }
                                if socket.send(Message::Text(PONG_JSON.into())).await.is_err() {
                                    break;
                                }
                            }
                            ClientWsMessage::AppState { state: app_state } => {
                                let app_state = app_state
                                    .map(AppPresenceState::from)
                                    .unwrap_or(AppPresenceState::Inactive);
                                entry.update_app_state(app_state);
                                registry.refresh_metrics();
                                trace!(
                                    "ws app_state received uid={} conn_id={} state={:?}",
                                    uid,
                                    conn_id,
                                    app_state
                                );
                                if app_state == AppPresenceState::Active {
                                    record_active_ws_activity(
                                        &mut activity_tasks,
                                        &state.client_tracking,
                                        uid,
                                        &entry.client_id,
                                        track_client,
                                    );
                                }
                            }
                            ClientWsMessage::WatchPresence { request_id, user_ids, chat_ids } => {
                                let Some(next_watch) = parse_legacy_presence_watch(request_id, user_ids, chat_ids) else {
                                    continue;
                                };
                                watch = next_watch;
                                presence_refresh = tokio::time::interval_at(
                                    tokio::time::Instant::now() + PRESENCE_REFRESH_INTERVAL,
                                    PRESENCE_REFRESH_INTERVAL,
                                );
                                if let Some(watch) = watch.as_ref() {
                                    if !send_legacy_presence_snapshot(&mut socket, &state, uid, watch, &mut presence_changes).await {
                                        break;
                                    }
                                }
                            }
                            ClientWsMessage::WatchConversationUnread { request_id, views, app_badge } => {
                                if crate::services::unread::validate_conversation_views(&views).is_err() {
                                    let error = ServerWsMessage::ConversationUnreadError(
                                        crate::dto::conversations::ConversationUnreadErrorPayload { request_id }
                                    );
                                    if socket.send(Message::Text(serde_json::to_string(&error).unwrap().into())).await.is_err() { break; }
                                    continue;
                                }
                                unread_request_id = Some(request_id);
                                unread_subscription.send_replace(if views.is_empty() && !app_badge { None } else {
                                    Some(crate::services::unread::watch::UnreadWatch {
                                        request_id,
                                        generation: 0,
                                        views,
                                        app_badge,
                                    })
                                });
                            }
                            ClientWsMessage::WatchConversationStates { request_id, conversations } => {
                                if !crate::services::unread::states::valid_scopes(&conversations) {
                                    let error = ServerWsMessage::ConversationStatesError(
                                        crate::dto::conversations::ConversationUnreadErrorPayload { request_id }
                                    );
                                    if socket.send(Message::Text(serde_json::to_string(&error).unwrap().into())).await.is_err() { break; }
                                    continue;
                                }
                                states_request_id = Some(request_id);
                                states_subscription.send_replace(if conversations.is_empty() { None } else {
                                    Some(crate::services::unread::states::StateWatch {
                                        request_id,
                                        generation: 0,
                                        conversations,
                                    })
                                });
                            }
                            ClientWsMessage::Auth { .. } | ClientWsMessage::Unknown => {}
                        }
                    }
                    Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
    unread_task.abort();
    states_task.abort();
    registry.remove_connection(uid, conn_id);
    state
        .metrics
        .ws
        .record_connection_duration(started_at.elapsed().as_secs_f64());
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(ws_handler))
        .routes(utoipa_axum::routes!(get_ws_ticket))
        .routes(utoipa_axum::routes!(get_online_clients))
}

#[cfg(test)]
mod rpc_tests;

#[cfg(test)]
mod tests {
    use super::selects_rpc;
    use crate::services::presence::parse_legacy_presence_watch;

    #[test]
    fn first_object_with_jsonrpc_selects_rpc_without_falling_back_to_legacy() {
        assert!(selects_rpc(
            r#"{"jsonrpc":"2.0","method":"session.open","id":"1"}"#
        ));
        assert!(selects_rpc(
            r#"{"jsonrpc":null,"type":"auth","ticket":"legacy"}"#
        ));
        assert!(!selects_rpc(r#"{"type":"auth","ticket":"legacy"}"#));
        assert!(!selects_rpc(r#"["jsonrpc"]"#));
        assert!(!selects_rpc(r#"{"jsonrpc""2.0"}"#));
    }

    #[test]
    fn legacy_presence_watch_replaces_with_empty_scope_without_publication() {
        assert!(matches!(
            parse_legacy_presence_watch(Some(4), Some(Vec::new()), Some(Vec::new())),
            Some(None)
        ));
    }

    #[test]
    fn legacy_presence_watch_rejects_scopes_above_protocol_bounds() {
        assert!(parse_legacy_presence_watch(Some(4), Some((0..101).collect()), None).is_none());
    }
}
