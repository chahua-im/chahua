use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::threads::{
        ListChatThreadsQuery, ListChatThreadsResponse, ListThreadParticipantsQuery,
        ListThreadParticipantsResponse, ListThreadsQuery, ListThreadsResponse, MarkThreadReadBody,
        MarkThreadReadResponse, ThreadOrder, ThreadReadStateResponse,
        ThreadSubscriptionStatusResponse, UnreadThreadCountResponse,
    },
    errors::AppError,
    extractors::DbConn,
    services::api::threads,
    utils::auth::CurrentUid,
    AppState,
};

/// GET /threads — List threads the user is subscribed to.
#[utoipa::path(
    get,
    path = "/",
    tag = "threads",
    params(
        ("limit" = Option<i64>, Query, description = "Page size limit"),
        ("rootId" = Option<String>, Query, description = "Restrict to one subscribed thread"),
        ("before" = Option<DateTime<Utc>>, Query, description = "Cursor for pagination"),
        ("archived" = Option<bool>, Query, description = "When true, list archived thread subscriptions instead of active ones"),
    ),
    responses(
        (status = OK, body = ListThreadsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_threads(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<ListThreadsQuery>,
) -> Result<Json<ListThreadsResponse>, AppError> {
    Ok(Json(threads::get_threads(
        uid,
        query,
        &mut conn,
        &state.media,
        &state.avatars,
    )?))
}

#[derive(serde::Deserialize)]
pub(super) struct ChatThreadsPath {
    chat_id: i64,
}

/// List all published threads in a chat, independently of subscriptions.
#[utoipa::path(
    get,
    path = "/threads",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("limit" = Option<i64>, Query, description = "Page size, default 20, clamped to 1–100"),
        ("cursor" = Option<String>, Query, description = "Exclusive root ID cursor from nextCursor; retain the same order"),
        ("order" = Option<ThreadOrder>, Query, description = "Root ID ordering: newest (default) or oldest"),
        ("participantUid" = Option<i32>, Query, description = "Filter threads by root/reply author"),
    ),
    responses(
        (status = OK, body = ListChatThreadsResponse),
        (status = FORBIDDEN, description = "Not a chat member"),
    ),
    security(("bearer_jwt" = [])),
)]
pub(super) async fn get_chat_threads(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatThreadsPath { chat_id }): Path<ChatThreadsPath>,
    mut conn: DbConn,
    Query(query): Query<ListChatThreadsQuery>,
) -> Result<Json<ListChatThreadsResponse>, AppError> {
    Ok(Json(
        threads::get_chat_threads(uid, chat_id, query, &mut conn, &state.media, &state.avatars)
            .await?,
    ))
}

/// List root/reply authors in ascending UID order, not thread subscribers.
#[utoipa::path(
    get,
    path = "/participants",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
        ("limit" = Option<i64>, Query, description = "Page size, default 100, clamped to 1–100"),
        ("cursor" = Option<i32>, Query, description = "Exclusive UID cursor from nextCursor"),
    ),
    responses(
        (status = OK, body = ListThreadParticipantsResponse),
        (status = FORBIDDEN, description = "Not a chat member"),
        (status = NOT_FOUND, description = "No published thread at this root in this chat"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_thread_participants(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadSubscribePath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscribePath>,
    mut conn: DbConn,
    Query(query): Query<ListThreadParticipantsQuery>,
) -> Result<Json<ListThreadParticipantsResponse>, AppError> {
    Ok(Json(threads::get_thread_participants(
        uid,
        chat_id,
        thread_root_id,
        query,
        &mut conn,
        &state.avatars,
    )?))
}

#[derive(serde::Deserialize)]
pub struct ThreadRootIdPath {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    thread_root_id: i64,
}

/// POST /threads/:thread_root_id/read — Mark a thread as read.
///
/// Deprecated: use `POST /chats/{chat_id}/threads/{thread_root_id}/read`.
/// Retained so clients released before the chat-scoped route keep working.
#[utoipa::path(
    post,
    path = "/{thread_root_id}/read",
    tag = "threads",
    params(
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    request_body = MarkThreadReadBody,
    responses(
        (status = OK, body = MarkThreadReadResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn mark_thread_read(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadRootIdPath { thread_root_id }): Path<ThreadRootIdPath>,
    mut conn: DbConn,
    Json(body): Json<MarkThreadReadBody>,
) -> Result<Json<MarkThreadReadResponse>, AppError> {
    Ok(Json(threads::mark_thread_read(
        uid,
        thread_root_id,
        body,
        &mut conn,
        &state.unread_service,
        &state.ws_registry,
    )?))
}

/// GET /threads/:thread_root_id/read-state — Get the user's read position for a thread.
///
/// Deprecated: use `GET /chats/{chat_id}/threads/{thread_root_id}/read-state`.
/// Retained so clients released before the chat-scoped route keep working.
#[utoipa::path(
    get,
    path = "/{thread_root_id}/read-state",
    tag = "threads",
    params(
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = OK, body = ThreadReadStateResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_thread_read_state(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadRootIdPath { thread_root_id }): Path<ThreadRootIdPath>,
    mut conn: DbConn,
) -> Result<Json<ThreadReadStateResponse>, AppError> {
    Ok(Json(threads::get_thread_read_state(
        uid,
        thread_root_id,
        &mut conn,
        &state.unread_service,
    )?))
}

/// GET /threads/unread — Get total unread thread and message counts for the current user.
#[utoipa::path(
    get,
    path = "/unread",
    tag = "threads",
    responses(
        (status = OK, body = UnreadThreadCountResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_unread_thread_count(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<UnreadThreadCountResponse>, AppError> {
    Ok(Json(threads::get_unread_thread_count(uid, &mut conn)?))
}

#[derive(serde::Deserialize)]
pub struct ThreadSubscribePath {
    chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    thread_root_id: i64,
}

/// POST /chats/:chat_id/threads/:thread_root_id/read — Mark a thread as read.
#[utoipa::path(
    post,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    request_body = MarkThreadReadBody,
    responses(
        (status = OK, body = MarkThreadReadResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn mark_thread_read_in_chat(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadSubscribePath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscribePath>,
    mut conn: DbConn,
    Json(body): Json<MarkThreadReadBody>,
) -> Result<Json<MarkThreadReadResponse>, AppError> {
    Ok(Json(threads::mark_thread_read_in_chat(
        uid,
        chat_id,
        thread_root_id,
        body,
        &mut conn,
        &state.unread_service,
        &state.ws_registry,
    )?))
}

/// GET /chats/:chat_id/threads/:thread_root_id/read-state — Read position in a thread.
#[utoipa::path(
    get,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = OK, body = ThreadReadStateResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_thread_read_state_in_chat(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadSubscribePath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscribePath>,
    mut conn: DbConn,
) -> Result<Json<ThreadReadStateResponse>, AppError> {
    Ok(Json(threads::get_thread_read_state_in_chat(
        uid,
        chat_id,
        thread_root_id,
        &mut conn,
        &state.unread_service,
    )?))
}

/// PUT /chats/:chat_id/threads/:thread_root_id/subscribe — Follow a thread.
#[utoipa::path(
    put,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn subscribe_thread(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadSubscribePath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscribePath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    threads::subscribe_thread(uid, chat_id, thread_root_id, &mut conn, &state.ws_registry)?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /chats/:chat_id/threads/:thread_root_id/subscribe — Unfollow a thread.
#[utoipa::path(
    delete,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn unsubscribe_thread(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadSubscribePath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscribePath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    threads::unsubscribe_thread(uid, chat_id, thread_root_id, &mut conn, &state.ws_registry)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct ThreadSubscriptionStatusPath {
    chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    thread_root_id: i64,
}

/// GET /chats/:chat_id/threads/:thread_root_id/subscribe — Check subscription status.
#[utoipa::path(
    get,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = OK, body = ThreadSubscriptionStatusResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_subscription_status(
    CurrentUid(uid): CurrentUid,
    Path(ThreadSubscriptionStatusPath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscriptionStatusPath>,
    mut conn: DbConn,
) -> Result<Json<ThreadSubscriptionStatusResponse>, AppError> {
    Ok(Json(threads::get_subscription_status(
        uid,
        chat_id,
        thread_root_id,
        &mut conn,
    )?))
}

/// PUT /chats/:chat_id/threads/:thread_root_id/archive — Archive a thread subscription.
#[utoipa::path(
    put,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn archive_thread(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadSubscribePath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscribePath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    threads::archive_thread(uid, chat_id, thread_root_id, &mut conn, &state.ws_registry)?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /chats/:chat_id/threads/:thread_root_id/archive — Unarchive a thread subscription.
#[utoipa::path(
    delete,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn unarchive_thread(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadSubscribePath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscribePath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    threads::unarchive_thread(uid, chat_id, thread_root_id, &mut conn, &state.ws_registry)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Top-level `/threads` routes.
///
/// These are the cross-chat inbox endpoints, plus the deprecated per-thread
/// read routes that predate the chat-scoped equivalents in [`thread_router`].
pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_threads))
        .routes(utoipa_axum::routes!(get_unread_thread_count))
        .routes(utoipa_axum::routes!(mark_thread_read))
        .routes(utoipa_axum::routes!(get_thread_read_state))
}

/// Routes nested under `/chats/:chat_id/threads/:thread_root_id`.
///
/// Keep every thread-scoped endpoint in this router so callers mount one
/// cohesive subtree rather than composing individual thread features.
pub fn thread_router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_thread_participants))
        .nest(
            "/subscribe",
            OpenApiRouter::new().routes(utoipa_axum::routes!(
                get_subscription_status,
                subscribe_thread,
                unsubscribe_thread
            )),
        )
        .nest(
            "/archive",
            OpenApiRouter::new().routes(utoipa_axum::routes!(archive_thread, unarchive_thread)),
        )
        .nest(
            "/read",
            OpenApiRouter::new().routes(utoipa_axum::routes!(mark_thread_read_in_chat)),
        )
        .nest(
            "/read-state",
            OpenApiRouter::new().routes(utoipa_axum::routes!(get_thread_read_state_in_chat)),
        )
        .nest("/pins", super::pins::thread_router())
}
