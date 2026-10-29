//! WebSocket handler: auth handshake, lifecycle-aware presence updates, ping/pong keepalive,
//! connection registry, 300s stale timeout.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::Json;
use chrono::Utc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::timeout;
use tracing::{debug, trace, warn};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::ws::{
    ClientWsMessage, OnlineClientConnectionResponse, OnlineClientStatus, ServerWsMessage,
    TicketResponse,
};
use crate::services::client_tracking::{should_record_client_activity, ClientTrackingService};
use crate::services::presence::{take_pending_changes, PresenceChanges};
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
) -> Result<Json<TicketResponse>, (axum::http::StatusCode, &'static str)> {
    let ticket = state
        .auth_token_service
        .issue_legacy_session(session.uid, &session.client_id, session.generation)
        .map_err(crate::services::auth_token::AuthTokenError::into_rejection)?;

    Ok(Json(TicketResponse { ticket }))
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
) -> Result<Json<Vec<OnlineClientConnectionResponse>>, (axum::http::StatusCode, &'static str)> {
    let connections = state.ws_registry.online_connections(session.uid);
    let mut client_ids = connections
        .iter()
        .map(|connection| connection.client_id.clone())
        .collect::<Vec<_>>();
    client_ids.sort_unstable();
    client_ids.dedup();
    let app_versions = state.client_tracking.last_app_versions(&client_ids)?;

    Ok(Json(
        connections
            .into_iter()
            .map(|connection| OnlineClientConnectionResponse {
                connection_id: connection.connection_id,
                last_app_version: app_versions.get(&connection.client_id).cloned().flatten(),
                client_id: connection.client_id,
                status: match connection.app_state {
                    AppPresenceState::Active => OnlineClientStatus::Active,
                    AppPresenceState::Inactive => OnlineClientStatus::Inactive,
                },
            })
            .collect(),
    ))
}

#[derive(Clone)]
struct PresenceWatch {
    request_id: Option<u64>,
    user_ids: Vec<i32>,
    chat_ids: Vec<i64>,
}

impl From<OnlineClientStatus> for AppPresenceState {
    fn from(value: OnlineClientStatus) -> Self {
        match value {
            OnlineClientStatus::Active => AppPresenceState::Active,
            OnlineClientStatus::Inactive => AppPresenceState::Inactive,
        }
    }
}

const PONG_JSON: &str = r#"{"type":"pong"}"#;

const MAX_WATCHED_USERS: usize = 100;
const MAX_WATCHED_GROUPS: usize = 4;
const PRESENCE_REFRESH_INTERVAL: Duration = Duration::from_secs(15);

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

fn parse_presence_watch(
    request_id: Option<u64>,
    user_ids: Option<Vec<i32>>,
    chat_ids: Option<Vec<String>>,
) -> Option<Option<PresenceWatch>> {
    let user_ids = user_ids.unwrap_or_default();
    let chat_ids = chat_ids.unwrap_or_default();
    if user_ids.len() > MAX_WATCHED_USERS || chat_ids.len() > MAX_WATCHED_GROUPS {
        return None;
    }

    let mut parsed_chat_ids = Vec::with_capacity(chat_ids.len());
    for chat_id in chat_ids {
        let Ok(chat_id) = chat_id.parse::<i64>() else {
            continue;
        };
        if chat_id > 0 {
            parsed_chat_ids.push(chat_id);
        }
    }

    if user_ids.is_empty() && parsed_chat_ids.is_empty() {
        Some(None)
    } else {
        Some(Some(PresenceWatch {
            request_id,
            user_ids,
            chat_ids: parsed_chat_ids,
        }))
    }
}

async fn send_presence_snapshot(
    socket: &mut WebSocket,
    state: &AppState,
    uid: i32,
    watch: &PresenceWatch,
    changes: &mut PresenceChanges,
) -> bool {
    loop {
        // The query below includes all changes already committed before it starts.
        take_pending_changes(changes, uid, &watch.user_ids);
        let result = state
            .presence_service
            .snapshot(
                uid,
                watch.request_id,
                watch.user_ids.clone(),
                watch.chat_ids.clone(),
            )
            .await;
        // A policy changed during the query: discard the obsolete authorization result.
        if take_pending_changes(changes, uid, &watch.user_ids) {
            continue;
        }
        return match result {
            Ok(payload) => match serde_json::to_string(&ServerWsMessage::PresenceSnapshot(payload))
            {
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
        };
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
    let track_client = should_record_client_activity(&headers);
    ws.on_upgrade(move |socket| handle_auth_and_socket(socket, state, track_client))
}

async fn handle_auth_and_socket(mut socket: WebSocket, state: AppState, track_client: bool) {
    // Wait for auth message, timeout after 5 seconds
    let auth_result = timeout(std::time::Duration::from_secs(5), socket.recv()).await;

    let session = match auth_result {
        Ok(Some(Ok(Message::Text(text)))) => {
            let Ok(ClientWsMessage::Auth { ticket }) =
                serde_json::from_str::<ClientWsMessage>(&text)
            else {
                return;
            };
            match crate::utils::auth::verify_session(&ticket, &state) {
                Ok(session) => session,
                Err(error) => {
                    debug!(?error, "ws auth rejected (invalid ticket)");
                    return;
                }
            }
        }
        _ => return, // Timeout, connection closed, or non-text message
    };

    let uid = session.uid;
    let client_id = session.client_id;

    let registry = state.ws_registry.clone();
    let (entry, rx) = registry.register(uid, client_id);

    handle_socket(socket, state, uid, registry, entry, rx, track_client).await;
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
                if relevant && !send_presence_snapshot(&mut socket, &state, uid, watch, &mut presence_changes).await {
                    break;
                }
            }
            _ = presence_refresh.tick(), if watch.is_some() => {
                let Some(watch) = watch.as_ref() else {
                    continue;
                };
                if !send_presence_snapshot(&mut socket, &state, uid, watch, &mut presence_changes).await {
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
                                let Some(next_watch) = parse_presence_watch(request_id, user_ids, chat_ids) else {
                                    continue;
                                };
                                watch = next_watch;
                                presence_refresh = tokio::time::interval_at(
                                    tokio::time::Instant::now() + PRESENCE_REFRESH_INTERVAL,
                                    PRESENCE_REFRESH_INTERVAL,
                                );
                                if let Some(watch) = watch.as_ref() {
                                    if !send_presence_snapshot(&mut socket, &state, uid, watch, &mut presence_changes).await {
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
                                    Some(crate::services::unread::watch::UnreadWatch { request_id, views, app_badge })
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
                                    Some(crate::services::unread::states::StateWatch { request_id, conversations })
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
mod tests {
    use super::parse_presence_watch;

    #[test]
    fn watch_presence_replaces_with_empty_scope_without_a_publication() {
        assert!(matches!(
            parse_presence_watch(Some(4), Some(Vec::new()), Some(Vec::new())),
            Some(None)
        ));
    }

    #[test]
    fn watch_presence_rejects_scopes_above_the_protocol_bounds() {
        assert!(parse_presence_watch(Some(4), Some((0..101).collect()), None).is_none());
    }
}
