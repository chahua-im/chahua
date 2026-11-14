mod chat_attachments;
mod messages;
mod metrics;
mod reactions;
mod saved_messages;

use axum::{
    extract::{Path, Query, State},
    Json,
};
pub use metrics::ChatMetrics;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::chats::{
        AcknowledgeReactionsBody, ListChatsQuery, ListChatsResponse, MarkAsReadBody,
        MarkAsUnreadBody, MarkChatReadStateResponse, ReadReceiptQuery, UnreadCountResponse,
        UnreadMentionIdsResponse, UnreadMentionsQuery, UnreadReactionIdsResponse,
        UnreadReactionsAckResponse, UnreadReactionsQuery,
    },
    dto::read_receipts::ReadReceiptResponse,
    errors::AppError,
    extractors::DbConn,
    services::authentication::Principal,
    utils::auth::CurrentUid,
    AppState,
};

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

// ---------------------------------------------------------------------------

// Chat listing endpoints
// ---------------------------------------------------------------------------

/// GET /chats — List chats for the current user (cursor-based).
#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("limit" = Option<i64>, Query, description = "Max number of chats to return"),
        ("chatId" = Option<String>, Query, description = "Restrict to one chat visible to the current user"),
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
    Query(query): Query<ListChatsQuery>,
) -> Result<Json<ListChatsResponse>, AppError> {
    let queue = state
        .metrics
        .api
        .start_stage("http", "chats.list", "blocking_queue");
    let response = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        drop(queue);
        let stages = state.metrics.api.stages("http", "chats.list");
        let pool = stages.start("pool_acquire");
        let mut conn = state.db.get()?;
        drop(pool);
        futures::executor::block_on(crate::services::api::chats::get_chats(
            uid,
            query,
            &mut conn,
            state.unread_service.as_ref(),
            &state.media,
            state.avatars.as_ref(),
            stages,
        ))
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "chat list task failed");
        AppError::Internal("Chat list task failed")
    })??;

    Ok(Json(response))
}

/// POST /chats/:chat_id/read — Mark messages as read up to a specific message ID.
#[utoipa::path(
    post,
    path = "/read",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
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
    Json(body): Json<MarkAsReadBody>,
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let response = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let mut conn = state.db.get()?;
        crate::services::api::chats::mark_as_read(
            uid,
            chat_id,
            body,
            &mut conn,
            state.unread_service.as_ref(),
            &state.ws_registry,
        )
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "chat read task failed");
        AppError::Internal("Chat read task failed")
    })??;

    Ok(Json(response))
}

/// GET /chats/:chat_id/read-receipt — Read the peer's visible receipt in a DM.
#[utoipa::path(
    get,
    path = "/read-receipt",
    operation_id = "get_chat_read_receipt",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ReadReceiptQuery,
    ),
    responses(
        (status = 200, description = "Peer read receipt when visible", body = ReadReceiptResponse),
        (status = 404, description = "Not a direct-message receipt scope")
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_chat_read_receipt(
    CurrentUid(uid): CurrentUid,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    Query(query): Query<ReadReceiptQuery>,
    conn: DbConn,
) -> Result<Json<ReadReceiptResponse>, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::get_chat_read_receipt(uid, chat_id, query, &mut conn).map(Json)
    })
    .await
}

/// POST /chats/:chat_id/unread — Mark a chat as unread by rewinding the read pointer.
#[utoipa::path(
    post,
    path = "/unread",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
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
    body: Option<Json<MarkAsUnreadBody>>,
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let body = body.map(|Json(body)| body);
    let response = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let mut conn = state.db.get()?;
        crate::services::api::chats::mark_as_unread(
            uid,
            chat_id,
            body,
            &mut conn,
            state.unread_service.as_ref(),
            state.ws_registry.as_ref(),
        )
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "chat unread mutation task failed");
        AppError::Internal("Chat unread mutation task failed")
    })??;

    Ok(Json(response))
}

/// GET /chats/:chat_id/unread — Get capped unread count for a single chat.
#[utoipa::path(
    get,
    path = "/unread",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
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
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let response = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let mut conn = state.db.get()?;
        crate::services::api::chats::get_chat_unread_count(
            uid,
            chat_id,
            &mut conn,
            state.unread_service.as_ref(),
        )
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "chat unread count task failed");
        AppError::Internal("Chat unread count task failed")
    })??;

    Ok(Json(response))
}

/// GET /chats/{chat_id}/mentions - Unread @mention message ids for the current user.
///
/// Returns main-scope mentions by default; pass `threadId` for thread-scope mentions.
/// Ids are newest-first (default 1000, hard cap 1000). A mention is
/// unread while `message_id > last_read_message_id` (cursor-derived; no per-mention flag).
#[utoipa::path(
    get,
    path = "/mentions",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("threadId" = Option<String>, Query, description = "Thread root message id; omit for main-scope mentions"),
        ("max" = Option<i64>, Query, description = "Max ids to return (default 1000, capped at 1000)"),
    ),
    responses(
        (status = 200, description = "Unread mention message ids, newest-first", body = UnreadMentionIdsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_chat_mentions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    conn: DbConn,
    Query(query): Query<UnreadMentionsQuery>,
) -> Result<Json<UnreadMentionIdsResponse>, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::get_chat_mentions(
            uid,
            chat_id,
            query,
            &mut conn,
            state.unread_service.as_ref(),
        )
        .map(Json)
    })
    .await
}

/// GET /chats/{chat_id}/reactions - Message ids with unread reactions for the current user.
///
/// Returns main-scope reactions by default (reactions on the user's top-level
/// messages); pass `threadId` for reactions on the user's messages in that
/// thread. Ids are newest-first, one entry per message regardless of how many
/// new reactions it carries (default 1000, hard cap 1000). A reaction is
/// unread while `created_at > last_reactions_read_at` (cursor-derived; the
/// cursor advances only through the explicit reaction acknowledgement).
/// Pass the previous snapshot's readThrough as after to fetch only new reactions.
#[utoipa::path(
    get,
    path = "/reactions",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("threadId" = Option<String>, Query, description = "Thread root message id; omit for main-scope reactions"),
        ("max" = Option<i64>, Query, description = "Max ids to return (default 1000, capped at 1000)"),
        ("after" = Option<chrono::DateTime<chrono::Utc>>, Query, description = "Previous snapshot readThrough; return only reactions created strictly after it"),
    ),
    responses(
        (status = 200, description = "Message ids with unread reactions, newest-first", body = UnreadReactionIdsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_chat_reactions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    conn: DbConn,
    Query(query): Query<UnreadReactionsQuery>,
) -> Result<Json<UnreadReactionIdsResponse>, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::get_chat_reactions(
            uid,
            chat_id,
            query,
            &mut conn,
            state.unread_service.as_ref(),
        )
        .map(Json)
    })
    .await
}

/// POST /chats/{chat_id}/reactions/read — Mark the conversation scope's reactions read.
///
/// Chat-level read state: entering a chat or thread acknowledges every reaction
/// in the returned snapshot (readThrough), even if no reacted message was opened.
/// Omitting readThrough acknowledges through the current time on exit. The cursor
/// only advances; ordinary message reads never call this. Returns the fresh
/// unread-reaction count (normally 0).
#[utoipa::path(
    post,
    path = "/reactions/read",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    request_body = AcknowledgeReactionsBody,
    responses(
        (status = 200, description = "Fresh unread-reaction state", body = UnreadReactionsAckResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn acknowledge_chat_reactions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    conn: DbConn,
    Json(body): Json<AcknowledgeReactionsBody>,
) -> Result<Json<UnreadReactionsAckResponse>, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::acknowledge_chat_reactions(
            uid,
            chat_id,
            body,
            &mut conn,
            state.unread_service.as_ref(),
            state.ws_registry.as_ref(),
        )
        .map(Json)
    })
    .await
}

/// GET /chats/unread — Get total unread message and chat counts for the current user.
#[utoipa::path(
    get,
    path = "/unread",
    tag = "chats",
    responses(
        (status = 200, description = "Total unread count", body = UnreadCountResponse),
    ),
    security(("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn get_unread_count(
    principal: Principal,
    State(state): State<AppState>,
) -> Result<Json<UnreadCountResponse>, AppError> {
    let response = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let mut conn = state.db.get()?;
        crate::services::api::chats::get_unread_count(
            principal,
            &mut conn,
            state.authz_service.as_ref(),
            state.unread_service.as_ref(),
        )
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "unread summary task failed");
        AppError::Internal("Unread summary task failed")
    })??;

    Ok(Json(response))
}

/// PUT /chats/:chat_id/archive — Archive a chat without changing its notification preference.
#[utoipa::path(
    put,
    path = "/archive",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
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
    conn: DbConn,
) -> Result<axum::http::StatusCode, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::archive_chat(
            uid,
            chat_id,
            &mut conn,
            state.ws_registry.as_ref(),
        )?;
        Ok(axum::http::StatusCode::NO_CONTENT)
    })
    .await
}

/// DELETE /chats/:chat_id/archive — Unarchive a chat while preserving its notification preference.
#[utoipa::path(
    delete,
    path = "/archive",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
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
    conn: DbConn,
) -> Result<axum::http::StatusCode, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::unarchive_chat(
            uid,
            chat_id,
            &mut conn,
            state.ws_registry.as_ref(),
        )?;
        Ok(axum::http::StatusCode::NO_CONTENT)
    })
    .await
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
                .routes(utoipa_axum::routes!(get_chat_read_receipt))
                .routes(utoipa_axum::routes!(mark_as_unread))
                .routes(utoipa_axum::routes!(get_chat_unread_count))
                .routes(utoipa_axum::routes!(get_chat_mentions))
                .routes(utoipa_axum::routes!(get_chat_reactions))
                .routes(utoipa_axum::routes!(acknowledge_chat_reactions))
                .routes(utoipa_axum::routes!(self::messages::post_thread_message))
                .routes(utoipa_axum::routes!(super::threads::get_chat_threads))
                .nest("/threads/{thread_root_id}", super::threads::thread_router())
                .nest("/saved-messages", self::saved_messages::router())
                .nest("/pins", super::pins::router()),
        )
}
