//! WebSocket handler: auth handshake, lifecycle-aware presence updates, ping/pong keepalive,
//! connection registry, 300s stale timeout.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::Json;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::timeout;
use tracing::{debug, trace, warn};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::ws::{
    ClientWsMessage, OnlineClientConnectionResponse, OnlineClientStatus, ServerWsMessage,
    TicketResponse,
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
) -> bool {
    match state
        .presence_service
        .snapshot(
            uid,
            watch.request_id,
            watch.user_ids.clone(),
            watch.chat_ids.clone(),
        )
        .await
    {
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
async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_auth_and_socket(socket, state))
}

async fn handle_auth_and_socket(mut socket: WebSocket, state: AppState) {
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
    let conn_id = entry.conn_id;

    handle_socket(socket, state, uid, conn_id, registry, entry, rx).await;
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    uid: i32,
    conn_id: u64,
    registry: Arc<ws_registry::ConnectionRegistry>,
    entry: Arc<ws_registry::ConnectionEntry>,
    mut rx: tokio::sync::mpsc::Receiver<Arc<ServerWsMessage>>,
) {
    let started_at = Instant::now();
    let mut watch = None;
    let mut presence_refresh =
        tokio::time::interval_at(tokio::time::Instant::now(), PRESENCE_REFRESH_INTERVAL);
    loop {
        tokio::select! {
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
            _ = presence_refresh.tick(), if watch.is_some() => {
                let Some(watch) = watch.as_ref() else {
                    continue;
                };
                if !send_presence_snapshot(&mut socket, &state, uid, watch).await {
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
                            ClientWsMessage::Ping { state } => {
                                let state = state
                                    .map(AppPresenceState::from)
                                    .unwrap_or(AppPresenceState::Active);
                                entry.update_ping(state);
                                registry.refresh_metrics();
                                trace!("ws ping received uid={} conn_id={}", uid, conn_id);
                                if socket.send(Message::Text(PONG_JSON.into())).await.is_err() {
                                    break;
                                }
                            }
                            ClientWsMessage::AppState { state } => {
                                let state = state
                                    .map(AppPresenceState::from)
                                    .unwrap_or(AppPresenceState::Inactive);
                                entry.update_app_state(state);
                                registry.refresh_metrics();
                                trace!(
                                    "ws app_state received uid={} conn_id={} state={:?}",
                                    uid,
                                    conn_id,
                                    state
                                );
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
                                    if !send_presence_snapshot(&mut socket, &state, uid, watch).await {
                                        break;
                                    }
                                }
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
