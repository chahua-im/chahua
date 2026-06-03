use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use diesel::prelude::*;
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
use crate::handlers::chats::{attach_metadata, PreparedMessageSend};
use crate::handlers::members::{check_membership, require_admin_role};
use crate::models::{Message, MessageType, NewPinnedMessage, PinnedMessage};
use crate::schema::{group_membership, messages, pinned_messages};
use crate::utils::auth::CurrentUid;
use crate::utils::ids;
use crate::AppState;

const MAX_PINS_PER_CHAT: i64 = 50;

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
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn list_pins(
    State(state): State<AppState>,
    Path(path): Path<ChatIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<ListPinsResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, path.chat_id, uid)?;

    let now = Utc::now();
    let pins: Vec<PinnedMessage> = pinned_messages::table
        .filter(pinned_messages::chat_id.eq(path.chat_id))
        .filter(
            pinned_messages::expires_at
                .is_null()
                .or(pinned_messages::expires_at.gt(now)),
        )
        .order(pinned_messages::pinned_at.desc())
        .load(conn)?;

    if pins.is_empty() {
        return Ok(Json(ListPinsResponse { pins: vec![] }));
    }

    let message_ids: Vec<i64> = pins.iter().map(|p| p.message_id).collect();
    let msgs: Vec<Message> = messages::table
        .filter(messages::id.eq_any(&message_ids))
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .load(conn)?;

    let enriched = attach_metadata(conn, msgs, &state, uid).await;

    let mut msg_map: std::collections::HashMap<i64, MessageResponse> =
        enriched.into_iter().map(|m| (m.id, m)).collect();

    let pin_responses: Vec<PinResponse> = pins
        .into_iter()
        .filter_map(|p| {
            msg_map.remove(&p.message_id).map(|msg| PinResponse {
                id: p.id,
                chat_id: p.chat_id,
                message: msg,
                pinned_by: p.pinned_by,
                pinned_at: p.pinned_at,
                expires_at: p.expires_at,
            })
        })
        .collect();

    Ok(Json(ListPinsResponse {
        pins: pin_responses,
    }))
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
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn create_pin(
    State(state): State<AppState>,
    Path(path): Path<ChatIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Json(body): Json<CreatePinBody>,
) -> Result<(StatusCode, Json<PinResponse>), AppError> {
    let conn = &mut *conn;

    require_admin_role(conn, path.chat_id, uid)?;

    // Verify message exists in this chat and is not deleted
    let msg: Message = messages::table
        .filter(
            messages::id
                .eq(body.message_id)
                .and(messages::chat_id.eq(path.chat_id))
                .and(messages::deleted_at.is_null())
                .and(messages::is_published.eq(true)),
        )
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    // Check pin count
    let now = Utc::now();
    let pin_count: i64 = pinned_messages::table
        .filter(pinned_messages::chat_id.eq(path.chat_id))
        .filter(
            pinned_messages::expires_at
                .is_null()
                .or(pinned_messages::expires_at.gt(now)),
        )
        .count()
        .get_result(conn)?;

    if pin_count >= MAX_PINS_PER_CHAT {
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
        chat_id: path.chat_id,
        message_id: body.message_id,
        pinned_by: uid,
        pinned_at: now,
        expires_at: None,
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

    let enriched = attach_metadata(conn, vec![msg], &state, uid).await;
    let msg_response = enriched
        .into_iter()
        .next()
        .ok_or(AppError::Internal("Failed to build message response"))?;

    let pin_response = PinResponse {
        id: pin.id,
        chat_id: pin.chat_id,
        message: msg_response,
        pinned_by: pin.pinned_by,
        pinned_at: pin.pinned_at,
        expires_at: pin.expires_at,
    };

    // Send system message (best-effort — pin already saved)
    if let Ok(send_result) = crate::handlers::chats::send_prepared_message(
        conn,
        &state,
        PreparedMessageSend {
            chat_id: path.chat_id,
            sender_uid: uid,
            message: Some("pinned a message".to_string()),
            message_type: MessageType::System,
            sticker_id: None,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: Uuid::new_v4().to_string(),
            attachment_ids: vec![],
            publish_immediately: true,
            forwarded_from_message_id: None,
            forwarded_from_chat_id: None,
            forwarded_from_sender_uid: None,
        },
    )
    .await
    {
        send_result.side_effects.fire(&state);
    }

    // Broadcast pin event to all chat members
    let member_uids: Vec<i32> = group_membership::table
        .filter(group_membership::chat_id.eq(path.chat_id))
        .select(group_membership::uid)
        .load(conn)?;

    let ws_msg = std::sync::Arc::new(ServerWsMessage::PinAdded(PinUpdatePayload {
        chat_id: path.chat_id,
        pin_id: pin_response.id,
        message_id: pin_response.message.id,
        pin: Some(pin_response.clone()),
    }));
    state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);

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
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn delete_pin(
    State(state): State<AppState>,
    Path(path): Path<PinIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;

    require_admin_role(conn, path.chat_id, uid)?;

    let pin: PinnedMessage = pinned_messages::table
        .filter(
            pinned_messages::id
                .eq(path.pin_id)
                .and(pinned_messages::chat_id.eq(path.chat_id)),
        )
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Pin not found"))?;

    diesel::delete(pinned_messages::table.filter(pinned_messages::id.eq(path.pin_id)))
        .execute(conn)?;

    // Send system message (best-effort — unpin already saved)
    if let Ok(send_result) = crate::handlers::chats::send_prepared_message(
        conn,
        &state,
        PreparedMessageSend {
            chat_id: path.chat_id,
            sender_uid: uid,
            message: Some("unpinned a message".to_string()),
            message_type: MessageType::System,
            sticker_id: None,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: Uuid::new_v4().to_string(),
            attachment_ids: vec![],
            publish_immediately: true,
            forwarded_from_message_id: None,
            forwarded_from_chat_id: None,
            forwarded_from_sender_uid: None,
        },
    )
    .await
    {
        send_result.side_effects.fire(&state);
    }

    // Broadcast pin removal
    let member_uids: Vec<i32> = group_membership::table
        .filter(group_membership::chat_id.eq(path.chat_id))
        .select(group_membership::uid)
        .load(conn)?;

    let ws_msg = std::sync::Arc::new(ServerWsMessage::PinRemoved(PinUpdatePayload {
        chat_id: path.chat_id,
        pin_id: pin.id,
        message_id: pin.message_id,
        pin: None,
    }));
    state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(list_pins, create_pin))
        .routes(utoipa_axum::routes!(delete_pin))
}
