mod chat_attachments;
mod messages;
mod metrics;
mod reactions;
mod saved_messages;

use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
pub use metrics::ChatMetrics;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::{
        chats::{ChatListItem, ListChatsResponse, MarkChatReadStateResponse, UnreadCountResponse},
        messages::MessageResponse,
        ws::{ChatArchiveStateChangedPayload, ServerWsMessage},
    },
    errors::AppError,
    extractors::DbConn,
    handlers::{members::check_membership, users::build_member_summary_map},
    services::{
        chat,
        messages::{attach_metadata, message_response_preview},
    },
    utils::{auth::CurrentUid, pagination::validate_limit},
};
use crate::{
    models::{GroupKind, MessageType},
    schema::{group_membership, groups, media, messages as messages_schema},
};
use crate::{AppState, MAX_CHATS_LIMIT};

// ---------------------------------------------------------------------------
// Re-exports for external consumers (pins.rs, threads.rs, invites.rs, ws/messages.rs)
// ---------------------------------------------------------------------------
pub use self::messages::router as messages_router;
pub use self::reactions::router as reactions_router;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct ChatIdPath {
    chat_id: i64,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageBody {
    pub message: Option<String>,
    pub message_type: MessageType,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub sticker_id: Option<i64>,
    pub client_generated_id: String,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub reply_to_id: Option<i64>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// Chat listing endpoints
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatsQuery {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    after: Option<i64>,
    #[serde(default)]
    archived: Option<bool>,
}

/// GET /chats — List chats for the current user (cursor-based).
#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("limit" = Option<i64>, Query, description = "Max number of chats to return"),
        ("after" = Option<String>, Query, description = "Cursor for pagination"),
        ("archived" = Option<bool>, Query, description = "When true, list archived chats instead of active ones"),
    ),
    responses(
        (status = 200, description = "List of chats", body = ListChatsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_chats(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(q): Query<ListChatsQuery>,
) -> Result<Json<ListChatsResponse>, AppError> {
    let conn = &mut *conn;

    let limit = validate_limit(q.limit, MAX_CHATS_LIMIT);
    let archived = q.archived.unwrap_or(false);

    let base_query = groups::table
        .inner_join(group_membership::table)
        .left_join(
            messages_schema::table.on(groups::last_message_id.eq(messages_schema::id.nullable())),
        )
        .left_join(
            media::table.on(groups::avatar_image_id
                .eq(media::id.nullable())
                .and(media::deleted_at.is_null())),
        )
        .filter(group_membership::uid.eq(uid))
        .filter(group_membership::archived.eq(archived));

    type RowType = (
        i64,
        String,
        Option<String>,
        Option<DateTime<Utc>>,
        Option<i64>,
        Option<crate::models::Message>,
        Option<DateTime<Utc>>,
        bool,
        GroupKind,
        Option<i32>,
        Option<i32>,
    );

    let rows: Vec<RowType> = match q.after {
        None => base_query
            .select((
                groups::id,
                groups::name,
                media::storage_key.nullable(),
                groups::last_message_at,
                group_membership::last_read_message_id,
                messages_schema::all_columns.nullable(),
                group_membership::muted_until,
                group_membership::archived,
                groups::kind,
                groups::dm_uid1,
                groups::dm_uid2,
            ))
            .order_by((
                groups::last_message_at.desc().nulls_last(),
                groups::id.desc(),
            ))
            .limit(limit + 1)
            .load(conn)?,
        Some(after_id) => {
            let cursor_at: Option<Option<DateTime<Utc>>> = groups::table
                .inner_join(group_membership::table)
                .filter(group_membership::uid.eq(uid))
                .filter(groups::id.eq(after_id))
                .select(groups::last_message_at)
                .first(conn)
                .optional()?;

            let cursor_at = match cursor_at {
                Some(c) => c,
                None => {
                    return Ok(Json(ListChatsResponse {
                        chats: vec![],
                        next_cursor: None,
                    }))
                }
            };
            let cursor_id = after_id;

            match cursor_at {
                Some(c_at) => base_query
                    .select((
                        groups::id,
                        groups::name,
                        media::storage_key.nullable(),
                        groups::last_message_at,
                        group_membership::last_read_message_id,
                        messages_schema::all_columns.nullable(),
                        group_membership::muted_until,
                        group_membership::archived,
                        groups::kind,
                        groups::dm_uid1,
                        groups::dm_uid2,
                    ))
                    .filter(
                        groups::last_message_at
                            .lt(c_at)
                            .or(groups::last_message_at
                                .eq(c_at)
                                .and(groups::id.lt(cursor_id)))
                            .or(groups::last_message_at.is_null()),
                    )
                    .order_by((
                        groups::last_message_at.desc().nulls_last(),
                        groups::id.desc(),
                    ))
                    .limit(limit + 1)
                    .load(conn)?,
                None => base_query
                    .select((
                        groups::id,
                        groups::name,
                        media::storage_key.nullable(),
                        groups::last_message_at,
                        group_membership::last_read_message_id,
                        messages_schema::all_columns.nullable(),
                        group_membership::muted_until,
                        group_membership::archived,
                        groups::kind,
                        groups::dm_uid1,
                        groups::dm_uid2,
                    ))
                    .filter(
                        groups::last_message_at
                            .is_null()
                            .and(groups::id.lt(cursor_id)),
                    )
                    .order_by((
                        groups::last_message_at.desc().nulls_last(),
                        groups::id.desc(),
                    ))
                    .limit(limit + 1)
                    .load(conn)?,
            }
        }
    };

    let has_more = rows.len() as i64 > limit;
    let items_to_process: Vec<RowType> = rows.into_iter().take(limit as usize).collect();

    let messages_to_process: Vec<crate::models::Message> = items_to_process
        .iter()
        .filter_map(|(_, _, _, _, _, msg, _, _, _, _, _)| msg.clone())
        .collect();

    let memberships = items_to_process
        .iter()
        .map(
            |(
                id,
                _name,
                _avatar_key,
                _last_message_at,
                last_read_message_id,
                _msg,
                muted_until,
                archived,
                _kind,
                _dm_uid1,
                _dm_uid2,
            )| crate::services::unread::ChatUnreadMembership {
                chat_id: *id,
                last_read_message_id: *last_read_message_id,
                archived: *archived,
                muted_until: *muted_until,
            },
        )
        .collect::<Vec<_>>();
    let unread_counts = state
        .unread_service
        .count_membership_unreads(conn, &memberships)?;

    let message_responses =
        attach_metadata(conn, messages_to_process, &state.media, &state.avatars, uid).await;

    let mut message_response_map: std::collections::HashMap<i64, MessageResponse> =
        message_responses
            .into_iter()
            .map(|mr| (mr.id, mr))
            .collect();

    let dm_peer_uids: Vec<i32> = items_to_process
        .iter()
        .filter_map(|(.., kind, dm_uid1, dm_uid2)| {
            if *kind == GroupKind::Dm {
                if *dm_uid1 == Some(uid) {
                    *dm_uid2
                } else {
                    *dm_uid1
                }
            } else {
                None
            }
        })
        .collect();
    let dm_peer_summaries = build_member_summary_map(conn, &state, &dm_peer_uids)?;

    let chats: Vec<ChatListItem> = items_to_process
        .into_iter()
        .map(
            |(
                id,
                name,
                avatar_key,
                last_message_at,
                last_read_message_id,
                msg,
                muted_until,
                archived,
                kind,
                dm_uid1,
                dm_uid2,
            )| {
                let unread_count = unread_counts.get(&id).copied().unwrap_or(0);
                let mr = msg
                    .and_then(|m| message_response_map.remove(&m.id))
                    .map(message_response_preview);
                let peer = if kind == GroupKind::Dm {
                    let peer_uid = if dm_uid1 == Some(uid) {
                        dm_uid2
                    } else {
                        dm_uid1
                    };
                    peer_uid.and_then(|puid| dm_peer_summaries.get(&puid).cloned())
                } else {
                    None
                };
                ChatListItem {
                    id,
                    name: Some(name),
                    avatar: avatar_key
                        .as_deref()
                        .map(|storage_key| state.media.public_url(storage_key)),
                    last_message_at,
                    unread_count,
                    last_read_message_id,
                    last_message: mr,
                    muted_until,
                    archived,
                    kind,
                    peer,
                }
            },
        )
        .collect();

    let next_cursor = has_more.then(|| chats.last().map(|c| c.id)).flatten();

    Ok(Json(ListChatsResponse { chats, next_cursor }))
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkAsReadBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    message_id: i64,
}

/// POST /chats/:chat_id/messages/read — Mark messages as read up to a specific message ID.
#[utoipa::path(
    post,
    path = "/read",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body = MarkAsReadBody,
    responses(
        (status = 200, description = "Updated read state", body = MarkChatReadStateResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn mark_as_read(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<MarkAsReadBody>,
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let read_state = crate::services::chat::mark_chat_as_read_state(
        conn,
        state.unread_service.as_ref(),
        chat_id,
        uid,
        body.message_id,
    )?;

    Ok(Json(MarkChatReadStateResponse {
        last_read_message_id: read_state.last_read_message_id,
        unread_count: read_state.unread_count,
    }))
}

/// Optional body for the unread endpoint — allows resetting read position to a specific message.
#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkAsUnreadBody {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    message_id: Option<i64>,
}

/// POST /chats/:chat_id/unread — Mark a chat as unread by rewinding the read pointer.
#[utoipa::path(
    post,
    path = "/unread",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body(content = Option<MarkAsUnreadBody>),
    responses(
        (status = 200, description = "Updated read state", body = MarkChatReadStateResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn mark_as_unread(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    body: Option<Json<MarkAsUnreadBody>>,
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let explicit_id = body.and_then(|Json(b)| b.message_id);

    let (new_read_id, unread_count) = if let Some(message_id) = explicit_id {
        use crate::schema::group_membership::dsl as gm_dsl;
        diesel::update(
            group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid))),
        )
        .set(gm_dsl::last_read_message_id.eq(Some(message_id)))
        .execute(conn)?;

        let unread_count =
            state
                .unread_service
                .count_chat_unread(conn, chat_id, Some(message_id))?;
        (Some(message_id), unread_count)
    } else {
        use crate::schema::messages::dsl;
        let last_two: Vec<i64> = messages_schema::table
            .filter(
                dsl::chat_id
                    .eq(chat_id)
                    .and(dsl::reply_root_id.is_null())
                    .and(dsl::deleted_at.is_null())
                    .and(dsl::is_published.eq(true)),
            )
            .order(dsl::id.desc())
            .limit(2)
            .select(dsl::id)
            .load(conn)?;

        // If < 2 public messages, set to NULL (entire chat unread); otherwise second-to-last
        let new_read_id = if last_two.len() >= 2 {
            Some(last_two[1])
        } else {
            None
        };

        use crate::schema::group_membership::dsl as gm_dsl;
        diesel::update(
            group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid))),
        )
        .set(gm_dsl::last_read_message_id.eq(new_read_id))
        .execute(conn)?;

        let unread_count = if new_read_id.is_some() {
            1
        } else {
            last_two.len() as i64
        };
        (new_read_id, unread_count)
    };

    Ok(Json(MarkChatReadStateResponse {
        last_read_message_id: new_read_id,
        unread_count,
    }))
}

/// GET /chats/:chat_id/unread — Get capped unread count for a single chat.
#[utoipa::path(
    get,
    path = "/unread",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = 200, description = "Capped chat unread count", body = MarkChatReadStateResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_chat_unread_count(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    use crate::schema::group_membership::dsl as gm_dsl;
    let last_read_message_id: Option<i64> = group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid)))
        .select(gm_dsl::last_read_message_id)
        .first(conn)?;

    let unread_count =
        state
            .unread_service
            .count_chat_unread(conn, chat_id, last_read_message_id)?;

    Ok(Json(MarkChatReadStateResponse {
        last_read_message_id,
        unread_count,
    }))
}

/// GET /chats/unread — Get total unread message and chat counts for the current user.
#[utoipa::path(
    get,
    path = "/unread",
    tag = "chats",
    responses(
        (status = 200, description = "Total unread count", body = UnreadCountResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_unread_count(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<UnreadCountResponse>, AppError> {
    let conn = &mut *conn;

    let counts = state.unread_service.count_user_unread_summary(conn, uid)?;

    Ok(Json(UnreadCountResponse {
        unread_count: counts.unread_count,
        archived_unread_count: counts.archived_unread_count,
        unread_chat_count: counts.unread_chat_count,
        archived_unread_chat_count: counts.archived_unread_chat_count,
    }))
}

/// PUT /chats/:chat_id/archive — Archive a chat and mute it indefinitely.
#[utoipa::path(
    put,
    path = "/archive",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn archive_chat(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<axum::http::StatusCode, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    diesel::update(
        group_membership::table.filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        ),
    )
    .set((
        group_membership::archived.eq(true),
        group_membership::muted_until.eq(Some(chat::indefinite_mute_until())),
    ))
    .execute(conn)?;

    state.ws_registry.broadcast_to_uids(
        &[uid],
        std::sync::Arc::new(ServerWsMessage::ChatArchiveStateChanged(
            ChatArchiveStateChangedPayload {
                chat_id,
                archived: true,
                muted_until: Some(chat::indefinite_mute_until()),
            },
        )),
    );

    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// DELETE /chats/:chat_id/archive — Unarchive a chat and unmute it.
#[utoipa::path(
    delete,
    path = "/archive",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn unarchive_chat(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<axum::http::StatusCode, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    diesel::update(
        group_membership::table.filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        ),
    )
    .set((
        group_membership::archived.eq(false),
        group_membership::muted_until.eq(None::<DateTime<Utc>>),
    ))
    .execute(conn)?;

    state.ws_registry.broadcast_to_uids(
        &[uid],
        std::sync::Arc::new(ServerWsMessage::ChatArchiveStateChanged(
            ChatArchiveStateChangedPayload {
                chat_id,
                archived: false,
                muted_until: None,
            },
        )),
    );

    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_chats))
        .routes(utoipa_axum::routes!(get_unread_count))
        .nest(
            "/{chat_id}",
            OpenApiRouter::new()
                .routes(utoipa_axum::routes!(archive_chat, unarchive_chat))
                .nest(
                    "/messages",
                    messages_router().nest("/{message_id}/reactions", reactions_router()),
                )
                .nest("/attachments", self::chat_attachments::router())
                .routes(utoipa_axum::routes!(mark_as_read))
                .routes(utoipa_axum::routes!(mark_as_unread))
                .routes(utoipa_axum::routes!(get_chat_unread_count))
                .routes(utoipa_axum::routes!(self::messages::post_thread_message))
                .nest("/threads/{thread_root_id}", super::threads::thread_router())
                .nest("/saved-messages", self::saved_messages::router())
                .nest("/pins", super::pins::router()),
        )
}
