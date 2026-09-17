//! WebSocket handler: auth handshake, lifecycle-aware presence updates, ping/pong keepalive,
//! connection registry, 300s stale timeout.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Instant;
use tokio::time::timeout;
use tracing::{debug, trace};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::ws::{ServerWsMessage, TicketResponse};
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsAuthMessage {
    #[serde(rename = "type")]
    type_: String,
    ticket: String,
    state: Option<WsAppState>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
enum WsClientMessage {
    Ping { state: Option<WsAppState> },
    AppState { state: WsAppState },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WsAppState {
    Active,
    Inactive,
}

impl From<WsAppState> for AppPresenceState {
    fn from(value: WsAppState) -> Self {
        match value {
            WsAppState::Active => AppPresenceState::Active,
            WsAppState::Inactive => AppPresenceState::Inactive,
        }
    }
}

const PONG_JSON: &str = r#"{"type":"pong"}"#;

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

    let (uid, initial_state) = match auth_result {
        Ok(Some(Ok(Message::Text(text)))) => {
            if let Ok(parsed) = serde_json::from_str::<WsAuthMessage>(&text) {
                if parsed.type_ == "auth" {
                    match crate::utils::auth::verify_session(&parsed.ticket, &state) {
                        Ok(session) => (session.uid, parsed.state.map(AppPresenceState::from)),
                        Err(e) => {
                            debug!("ws auth rejected (invalid ticket): {:?}", e);
                            return;
                        } // Invalid ticket
                    }
                } else {
                    return; // First message not auth
                }
            } else {
                return; // Invalid JSON or wrong structure
            }
        }
        _ => return, // Timeout, connection closed, or non-text message
    };

    let registry = state.ws_registry.clone();
    let (entry, rx) = registry.register(uid, initial_state).await;
    let conn_id = entry.conn_id();
    let heartbeat = entry.heartbeat_handle();

    handle_socket(socket, state, uid, conn_id, heartbeat, registry, rx).await;
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    uid: i32,
    conn_id: u64,
    heartbeat: ws_registry::HeartbeatHandle,
    registry: Arc<ws_registry::ConnectionRegistry>,
    mut rx: tokio::sync::mpsc::Receiver<Arc<ServerWsMessage>>,
) {
    let started_at = Instant::now();
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
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(parsed) = serde_json::from_str::<WsClientMessage>(&text) {
                            match parsed {
                            WsClientMessage::Ping { state } => {
                                let app_state = state.map(AppPresenceState::from);
                                heartbeat.record();
                                if !registry.heartbeat(uid, conn_id, app_state).await {
                                    break;
                                }
                                trace!("ws ping received uid={} conn_id={}", uid, conn_id);
                                if socket.send(Message::Text(PONG_JSON.into())).await.is_err() {
                                    break;
                                }
                            }
                            WsClientMessage::AppState { state } => {
                                let app_state = AppPresenceState::from(state);
                                heartbeat.record();
                                if !registry.heartbeat(uid, conn_id, Some(app_state)).await {
                                    break;
                                }
                                trace!(
                                    "ws app_state received uid={} conn_id={} state={:?}",
                                    uid,
                                    conn_id,
                                    app_state
                                );
                            }
                            }
                        }
                    }
                    Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
    registry.remove_connection(uid, conn_id).await;
    state
        .metrics
        .ws
        .record_connection_duration(started_at.elapsed().as_secs_f64());
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(ws_handler))
        .routes(utoipa_axum::routes!(get_ws_ticket))
}

#[cfg(test)]
mod tests {
    use super::{WsAppState, WsAuthMessage, WsClientMessage};

    #[test]
    fn auth_state_is_optional_for_legacy_clients() {
        let auth: WsAuthMessage = serde_json::from_str(r#"{"type":"auth","ticket":"ticket"}"#)
            .expect("auth message should deserialize");

        assert!(auth.state.is_none());
    }

    #[test]
    fn auth_accepts_an_explicit_initial_state() {
        let auth: WsAuthMessage =
            serde_json::from_str(r#"{"type":"auth","ticket":"ticket","state":"active"}"#)
                .expect("auth message should deserialize");

        assert!(matches!(auth.state, Some(WsAppState::Active)));
    }

    #[test]
    fn app_state_message_requires_state() {
        assert!(serde_json::from_str::<WsClientMessage>(r#"{"type":"appState"}"#).is_err());
    }

    #[test]
    fn ping_without_state_remains_a_heartbeat_only() {
        let message: WsClientMessage = serde_json::from_str(r#"{"type":"ping"}"#)
            .expect("ping without state should deserialize");

        assert!(matches!(message, WsClientMessage::Ping { state: None }));
    }
}
