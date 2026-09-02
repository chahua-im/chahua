use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use diesel::pg::Pg;
use diesel::prelude::*;
use diesel::sql_types::{Bool, Nullable};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use crate::dto::{
    messages::MessageResponse,
    pins::{ListPinsResponse, PinResponse},
    ws::{PinUpdatePayload, ServerWsMessage},
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::handlers::members::{check_membership, require_admin_role};
use crate::models::{GroupKind, Message, MessageType, NewPinnedMessage, PinnedMessage};
use crate::schema::{group_membership, groups, messages, pinned_messages};
use crate::services::messages::{attach_metadata, PreparedMessageSend, SendMessageOutcome};
use crate::utils::auth::CurrentUid;
use crate::utils::ids;
use crate::AppState;

const MAX_PINS_PER_SCOPE: i64 = 50;

/// Which pin list a request addresses. Chat-level pins and the pins of each
/// thread are independent lists sharing the `pinned_messages` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinScope {
    Chat,
    Thread { thread_root_id: i64 },
}

impl PinScope {
    fn thread_root_id(self) -> Option<i64> {
        match self {
            PinScope::Chat => None,
            PinScope::Thread { thread_root_id } => Some(thread_root_id),
        }
    }
}

type ScopeFilter = Box<dyn BoxableExpression<pinned_messages::table, Pg, SqlType = Nullable<Bool>>>;

/// Restrict a `pinned_messages` query to a single pin list. Chat pins are the
/// rows with a NULL `thread_root_id`.
fn scope_filter(scope: PinScope) -> ScopeFilter {
    match scope.thread_root_id() {
        None => Box::new(pinned_messages::thread_root_id.is_null().nullable()),
        Some(thread_root_id) => Box::new(pinned_messages::thread_root_id.eq(thread_root_id)),
    }
}

/// Threads are root-based: replies carry `reply_root_id == thread_root_id`, and
/// the root message itself has no `reply_root_id`.
fn message_belongs_to_thread(
    message_id: i64,
    reply_root_id: Option<i64>,
    thread_root_id: i64,
) -> bool {
    message_id == thread_root_id || reply_root_id == Some(thread_root_id)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreatePinBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    message_id: i64,
}

#[derive(Deserialize)]
struct ChatIdPath {
    chat_id: i64,
}

#[derive(Deserialize)]
struct PinIdPath {
    chat_id: i64,
    pin_id: i64,
}

#[derive(Deserialize)]
struct ThreadPinsPath {
    chat_id: i64,
    thread_root_id: i64,
}

#[derive(Deserialize)]
struct ThreadPinIdPath {
    chat_id: i64,
    thread_root_id: i64,
    pin_id: i64,
}

async fn list_pins_in_scope(
    state: &AppState,
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    scope: PinScope,
) -> Result<ListPinsResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    let now = Utc::now();
    let pins: Vec<PinnedMessage> = pinned_messages::table
        .filter(pinned_messages::chat_id.eq(chat_id))
        .filter(scope_filter(scope))
        .filter(
            pinned_messages::expires_at
                .is_null()
                .or(pinned_messages::expires_at.gt(now)),
        )
        .order(pinned_messages::pinned_at.desc())
        .load(conn)?;

    if pins.is_empty() {
        return Ok(ListPinsResponse { pins: vec![] });
    }

    let message_ids: Vec<i64> = pins.iter().map(|p| p.message_id).collect();
    let msgs: Vec<Message> = messages::table
        .filter(messages::id.eq_any(&message_ids))
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .load(conn)?;

    let enriched = attach_metadata(conn, msgs, &state.media, &state.avatars, uid).await;

    let mut msg_map: std::collections::HashMap<i64, MessageResponse> =
        enriched.into_iter().map(|m| (m.id, m)).collect();

    let pin_responses: Vec<PinResponse> = pins
        .into_iter()
        .filter_map(|p| {
            msg_map.remove(&p.message_id).map(|msg| PinResponse {
                id: p.id,
                chat_id: p.chat_id,
                thread_root_id: p.thread_root_id,
                message: msg,
                pinned_by: p.pinned_by,
                pinned_at: p.pinned_at,
                expires_at: p.expires_at,
            })
        })
        .collect();

    Ok(ListPinsResponse {
        pins: pin_responses,
    })
}

/// Who may pin/unpin: DM participants may manage shared pins themselves;
/// group chats stay admin-only. DM members are all `Member` (no admin exists),
/// so this replaces the previous unconditional admin requirement.
fn require_pin_permission(conn: &mut PgConnection, chat_id: i64, uid: i32) -> Result<(), AppError> {
    let kind: GroupKind = groups::table
        .find(chat_id)
        .select(groups::kind)
        .first(conn)?;
    if kind == GroupKind::Dm {
        check_membership(conn, chat_id, uid)
    } else {
        require_admin_role(conn, chat_id, uid)
    }
}

async fn create_pin_in_scope(
    state: &AppState,
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    scope: PinScope,
    message_id: i64,
) -> Result<PinResponse, AppError> {
    require_pin_permission(conn, chat_id, uid)?;

    // Verify message exists in this chat and is not deleted
    let msg: Message = messages::table
        .filter(
            messages::id
                .eq(message_id)
                .and(messages::chat_id.eq(chat_id))
                .and(messages::deleted_at.is_null())
                .and(messages::is_published.eq(true)),
        )
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    if let PinScope::Thread { thread_root_id } = scope {
        messages::table
            .filter(messages::id.eq(thread_root_id))
            .filter(messages::chat_id.eq(chat_id))
            .filter(messages::deleted_at.is_null())
            .select(messages::id)
            .first::<i64>(conn)
            .optional()?
            .ok_or(AppError::NotFound("Thread not found"))?;

        if !message_belongs_to_thread(msg.id, msg.reply_root_id, thread_root_id) {
            return Err(AppError::BadRequest("Message is not part of this thread"));
        }
    }

    // Check pin count for this scope
    let now = Utc::now();
    let pin_count: i64 = pinned_messages::table
        .filter(pinned_messages::chat_id.eq(chat_id))
        .filter(scope_filter(scope))
        .filter(
            pinned_messages::expires_at
                .is_null()
                .or(pinned_messages::expires_at.gt(now)),
        )
        .count()
        .get_result(conn)?;

    if pin_count >= MAX_PINS_PER_SCOPE {
        return Err(AppError::Conflict("Maximum number of pins reached"));
    }

    let pin_id = ids::next_message_id(state.id_gen.as_ref())
        .await
        .map_err(|e| {
            tracing::error!("ferroid pin id: {:?}", e);
            AppError::Internal("ID generation failed")
        })?;

    let new_pin = NewPinnedMessage {
        id: pin_id,
        chat_id,
        message_id,
        pinned_by: uid,
        pinned_at: now,
        expires_at: None,
        thread_root_id: scope.thread_root_id(),
    };

    let pin: PinnedMessage = diesel::insert_into(pinned_messages::table)
        .values(&new_pin)
        .returning(PinnedMessage::as_returning())
        .get_result(conn)
        .map_err(|e| {
            if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
                return AppError::Conflict("Message is already pinned");
            }
            tracing::error!("insert pin: {:?}", e);
            AppError::Internal("Database error")
        })?;

    let enriched = attach_metadata(conn, vec![msg], &state.media, &state.avatars, uid).await;
    let msg_response = enriched
        .into_iter()
        .next()
        .ok_or(AppError::Internal("Failed to build message response"))?;

    let pin_response = PinResponse {
        id: pin.id,
        chat_id: pin.chat_id,
        thread_root_id: pin.thread_root_id,
        message: msg_response,
        pinned_by: pin.pinned_by,
        pinned_at: pin.pinned_at,
        expires_at: pin.expires_at,
    };

    send_pin_system_message(state, conn, uid, chat_id, scope, PinAction::Pinned).await;

    // Broadcast pin event to all chat members
    let member_uids: Vec<i32> = group_membership::table
        .filter(group_membership::chat_id.eq(chat_id))
        .select(group_membership::uid)
        .load(conn)?;

    let event = match scope {
        PinScope::Chat => ServerWsMessage::PinAdded(PinUpdatePayload {
            chat_id,
            pin_id: pin_response.id,
            message_id: pin_response.message.id,
            thread_root_id: None,
            pin: Some(pin_response.clone()),
        }),
        PinScope::Thread { thread_root_id } => ServerWsMessage::ThreadPinAdded(PinUpdatePayload {
            chat_id,
            pin_id: pin_response.id,
            message_id: pin_response.message.id,
            thread_root_id: Some(thread_root_id),
            pin: Some(pin_response.clone()),
        }),
    };
    let ws_msg = std::sync::Arc::new(event);
    state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);

    Ok(pin_response)
}

async fn delete_pin_in_scope(
    state: &AppState,
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    scope: PinScope,
    pin_id: i64,
) -> Result<(), AppError> {
    require_pin_permission(conn, chat_id, uid)?;

    let pin: PinnedMessage = pinned_messages::table
        .filter(
            pinned_messages::id
                .eq(pin_id)
                .and(pinned_messages::chat_id.eq(chat_id)),
        )
        .filter(scope_filter(scope))
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Pin not found"))?;

    diesel::delete(pinned_messages::table.filter(pinned_messages::id.eq(pin_id))).execute(conn)?;

    send_pin_system_message(state, conn, uid, chat_id, scope, PinAction::Unpinned).await;

    // Broadcast pin removal
    let member_uids: Vec<i32> = group_membership::table
        .filter(group_membership::chat_id.eq(chat_id))
        .select(group_membership::uid)
        .load(conn)?;

    let event = match scope {
        PinScope::Chat => ServerWsMessage::PinRemoved(PinUpdatePayload {
            chat_id,
            pin_id: pin.id,
            message_id: pin.message_id,
            thread_root_id: None,
            pin: None,
        }),
        PinScope::Thread { thread_root_id } => {
            ServerWsMessage::ThreadPinRemoved(PinUpdatePayload {
                chat_id,
                pin_id: pin.id,
                message_id: pin.message_id,
                thread_root_id: Some(thread_root_id),
                pin: None,
            })
        }
    };
    let ws_msg = std::sync::Arc::new(event);
    state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);

    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum PinAction {
    Pinned,
    Unpinned,
}

/// Best-effort system message announcing the pin change. Thread pins announce
/// inside the thread so the change is visible in the thread transcript.
async fn send_pin_system_message(
    state: &AppState,
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    scope: PinScope,
    action: PinAction,
) {
    let text = match (scope, action) {
        (PinScope::Chat, PinAction::Pinned) => "pinned a message",
        (PinScope::Chat, PinAction::Unpinned) => "unpinned a message",
        (PinScope::Thread { .. }, PinAction::Pinned) => "pinned a message in this thread",
        (PinScope::Thread { .. }, PinAction::Unpinned) => "unpinned a message in this thread",
    };
    let thread_root_id = scope.thread_root_id();

    if let Ok(SendMessageOutcome::Created(send_result)) =
        crate::services::messages::send_prepared_message(
            conn,
            state,
            PreparedMessageSend {
                chat_id,
                sender_uid: uid,
                message: Some(text.to_string()),
                message_type: MessageType::System,
                sticker_id: None,
                reply_to_id: thread_root_id,
                reply_root_id: thread_root_id,
                client_generated_id: Uuid::new_v4().to_string(),
                attachment_ids: vec![],
                publish_immediately: true,
            },
        )
        .await
    {
        let send_result = *send_result;
        send_result.side_effects.fire(state);
    }
}

#[utoipa::path(
    get,
    path = "/",
    tag = "pins",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = OK, body = ListPinsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn list_pins(
    State(state): State<AppState>,
    Path(path): Path<ChatIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<ListPinsResponse>, AppError> {
    let conn = &mut *conn;
    let response = list_pins_in_scope(&state, conn, uid, path.chat_id, PinScope::Chat).await?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/",
    tag = "pins",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body = CreatePinBody,
    responses(
        (status = CREATED, body = PinResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn create_pin(
    State(state): State<AppState>,
    Path(path): Path<ChatIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Json(body): Json<CreatePinBody>,
) -> Result<(StatusCode, Json<PinResponse>), AppError> {
    let conn = &mut *conn;
    let pin_response = create_pin_in_scope(
        &state,
        conn,
        uid,
        path.chat_id,
        PinScope::Chat,
        body.message_id,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(pin_response)))
}

#[utoipa::path(
    delete,
    path = "/{pin_id}",
    tag = "pins",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("pin_id" = i64, Path, description = "Pin ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn delete_pin(
    State(state): State<AppState>,
    Path(path): Path<PinIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    delete_pin_in_scope(&state, conn, uid, path.chat_id, PinScope::Chat, path.pin_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/",
    tag = "pins",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = OK, body = ListPinsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn list_thread_pins(
    State(state): State<AppState>,
    Path(path): Path<ThreadPinsPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<ListPinsResponse>, AppError> {
    let conn = &mut *conn;
    let response = list_pins_in_scope(
        &state,
        conn,
        uid,
        path.chat_id,
        PinScope::Thread {
            thread_root_id: path.thread_root_id,
        },
    )
    .await?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/",
    tag = "pins",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    request_body = CreatePinBody,
    responses(
        (status = CREATED, body = PinResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn create_thread_pin(
    State(state): State<AppState>,
    Path(path): Path<ThreadPinsPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Json(body): Json<CreatePinBody>,
) -> Result<(StatusCode, Json<PinResponse>), AppError> {
    let conn = &mut *conn;
    let pin_response = create_pin_in_scope(
        &state,
        conn,
        uid,
        path.chat_id,
        PinScope::Thread {
            thread_root_id: path.thread_root_id,
        },
        body.message_id,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(pin_response)))
}

#[utoipa::path(
    delete,
    path = "/{pin_id}",
    tag = "pins",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
        ("pin_id" = i64, Path, description = "Pin ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn delete_thread_pin(
    State(state): State<AppState>,
    Path(path): Path<ThreadPinIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    delete_pin_in_scope(
        &state,
        conn,
        uid,
        path.chat_id,
        PinScope::Thread {
            thread_root_id: path.thread_root_id,
        },
        path.pin_id,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(list_pins, create_pin))
        .routes(utoipa_axum::routes!(delete_pin))
}

pub fn thread_router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(list_thread_pins, create_thread_pin))
        .routes(utoipa_axum::routes!(delete_thread_pin))
}

#[cfg(test)]
mod tests {
    use super::{message_belongs_to_thread, PinScope};

    #[test]
    fn chat_scope_has_no_thread_root() {
        assert_eq!(PinScope::Chat.thread_root_id(), None);
        assert_eq!(
            PinScope::Thread { thread_root_id: 7 }.thread_root_id(),
            Some(7)
        );
    }

    #[test]
    fn thread_root_itself_belongs_to_its_thread() {
        assert!(message_belongs_to_thread(7, None, 7));
    }

    #[test]
    fn thread_reply_belongs_to_its_thread() {
        assert!(message_belongs_to_thread(9, Some(7), 7));
    }

    #[test]
    fn reply_in_another_thread_does_not_belong() {
        assert!(!message_belongs_to_thread(9, Some(8), 7));
    }

    #[test]
    fn unrelated_top_level_message_does_not_belong() {
        assert!(!message_belongs_to_thread(9, None, 7));
    }
}
