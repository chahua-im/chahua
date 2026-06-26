use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::threads::{
        ListThreadsResponse, MarkThreadReadResponse, ThreadReadStateResponse,
        ThreadSubscriptionStatusResponse, UnreadThreadCountResponse,
    },
    errors::AppError,
    extractors::DbConn,
    handlers::members::check_membership,
    models::Message,
    schema::messages,
    services::threads as thread_svc,
    utils::{auth::CurrentUid, pagination::validate_limit},
    AppState,
};

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsQuery {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    before: Option<DateTime<Utc>>,
    #[serde(default)]
    archived: Option<bool>,
}

/// GET /threads — List threads the user is subscribed to.
#[utoipa::path(
    get,
    path = "/",
    tag = "threads",
    params(
        ("limit" = Option<i64>, Query, description = "Page size limit"),
        ("before" = Option<DateTime<Utc>>, Query, description = "Cursor for pagination"),
        ("archived" = Option<bool>, Query, description = "When true, list archived thread subscriptions instead of active ones"),
    ),
    responses(
        (status = OK, body = ListThreadsResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_threads(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<ListThreadsQuery>,
) -> Result<Json<ListThreadsResponse>, AppError> {
    let conn = &mut *conn;

    let limit = validate_limit(query.limit.or(Some(20)), 50);
    let archived = query.archived.unwrap_or(false);
    let rows = thread_svc::get_user_threads(conn, uid, limit + 1, query.before, archived)?;

    let has_more = rows.len() as i64 > limit;
    let rows: Vec<_> = rows.into_iter().take(limit as usize).collect();

    let root_ids: Vec<i64> = rows.iter().map(|r| r.thread_root_id).collect();

    if root_ids.is_empty() {
        return Ok(Json(ListThreadsResponse {
            threads: vec![],
            next_cursor: None,
        }));
    }

    // Load raw root messages (no heavy attach_metadata — enrich_thread_list builds lightweight previews)
    let root_messages: Vec<Message> = messages::table
        .filter(messages::id.eq_any(&root_ids))
        .filter(messages::reply_root_id.is_null())
        .filter(messages::has_thread.eq(true))
        .filter(messages::is_published.eq(true))
        .select(Message::as_select())
        .load(conn)?;

    let response =
        thread_svc::enrich_thread_list(conn, rows, has_more, root_messages, uid, &state)?;

    Ok(Json(response))
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkThreadReadBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    message_id: i64,
}

#[derive(serde::Deserialize)]
pub struct ThreadRootIdPath {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    thread_root_id: i64,
}

/// Resolve `chat_id` from a thread root message ID, or return 404.
fn resolve_chat_id_for_thread(
    conn: &mut PgConnection,
    thread_root_id: i64,
) -> Result<i64, AppError> {
    messages::table
        .filter(messages::id.eq(thread_root_id))
        .select(messages::chat_id)
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Thread root message not found"))
}

/// POST /threads/:thread_root_id/read — Mark a thread as read.
#[utoipa::path(
    post,
    path = "/{thread_root_id}/read",
    tag = "threads",
    params(
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    request_body = MarkThreadReadBody,
    responses(
        (status = OK, body = MarkThreadReadResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn mark_thread_read(
    CurrentUid(uid): CurrentUid,
    Path(ThreadRootIdPath { thread_root_id }): Path<ThreadRootIdPath>,
    mut conn: DbConn,
    Json(body): Json<MarkThreadReadBody>,
) -> Result<Json<MarkThreadReadResponse>, AppError> {
    let conn = &mut *conn;

    let chat_id = resolve_chat_id_for_thread(conn, thread_root_id)?;
    // If the client reports reading the root message itself (no replies),
    // there is nothing to track — skip the write.
    if body.message_id == thread_root_id {
        return Ok(Json(MarkThreadReadResponse {
            last_read_message_id: None,
            unread_count: 0,
        }));
    }

    let _ = thread_svc::ensure_thread_user_state(conn, chat_id, thread_root_id, uid)?;
    let read_state =
        thread_svc::mark_thread_read(conn, chat_id, thread_root_id, uid, body.message_id)?;

    Ok(Json(MarkThreadReadResponse {
        last_read_message_id: read_state.last_read_message_id,
        unread_count: read_state.unread_count,
    }))
}

/// GET /threads/:thread_root_id/read-state — Get the user's read position for a thread.
#[utoipa::path(
    get,
    path = "/{thread_root_id}/read-state",
    tag = "threads",
    params(
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = OK, body = ThreadReadStateResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_thread_read_state(
    CurrentUid(uid): CurrentUid,
    Path(ThreadRootIdPath { thread_root_id }): Path<ThreadRootIdPath>,
    mut conn: DbConn,
) -> Result<Json<ThreadReadStateResponse>, AppError> {
    let conn = &mut *conn;

    let chat_id = resolve_chat_id_for_thread(conn, thread_root_id)?;

    let last_read_message_id =
        thread_svc::get_thread_last_read_message_id(conn, chat_id, thread_root_id, uid)?;

    Ok(Json(ThreadReadStateResponse {
        last_read_message_id,
    }))
}
/// GET /threads/unread — Get total unread thread and message counts for the current user.
#[utoipa::path(
    get,
    path = "/unread",
    tag = "threads",
    responses(
        (status = OK, body = UnreadThreadCountResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_unread_thread_count(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<UnreadThreadCountResponse>, AppError> {
    let conn = &mut *conn;

    let counts = thread_svc::get_unread_summary_counts(conn, uid)?;

    Ok(Json(UnreadThreadCountResponse {
        unread_thread_count: counts.unread_thread_count,
        archived_unread_thread_count: counts.archived_unread_thread_count,
        unread_message_count: counts.unread_message_count,
        archived_unread_message_count: counts.archived_unread_message_count,
    }))
}

#[derive(serde::Deserialize)]
pub struct ThreadSubscribePath {
    chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    thread_root_id: i64,
}

/// PUT /chats/:chat_id/threads/:thread_root_id/subscribe — Follow a thread.
#[utoipa::path(
    put,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
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
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    // Verify the thread root message exists
    let exists: bool = diesel::select(diesel::dsl::exists(
        messages::table.filter(
            messages::id
                .eq(thread_root_id)
                .and(messages::chat_id.eq(chat_id))
                .and(messages::deleted_at.is_null())
                .and(messages::is_published.eq(true)),
        ),
    ))
    .get_result(conn)?;

    if !exists {
        return Err(AppError::NotFound("Thread root message not found"));
    }

    let inserted = thread_svc::subscribe_to_thread(conn, chat_id, thread_root_id, uid)?;
    if inserted {
        thread_svc::broadcast_thread_update_to_uids(
            conn,
            &state.ws_registry,
            &[uid],
            chat_id,
            thread_root_id,
        )?;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /chats/:chat_id/threads/:thread_root_id/subscribe — Unfollow a thread.
#[utoipa::path(
    delete,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
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
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let removed = thread_svc::unsubscribe_from_thread(conn, chat_id, thread_root_id, uid)?;
    if removed {
        thread_svc::broadcast_thread_membership_changed_to_user(
            &state.ws_registry,
            uid,
            chat_id,
            thread_root_id,
        );
    }

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
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = OK, body = ThreadSubscriptionStatusResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_subscription_status(
    CurrentUid(uid): CurrentUid,
    Path(ThreadSubscriptionStatusPath {
        chat_id,
        thread_root_id,
    }): Path<ThreadSubscriptionStatusPath>,
    mut conn: DbConn,
) -> Result<Json<ThreadSubscriptionStatusResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let state = thread_svc::get_subscription_state(conn, chat_id, thread_root_id, uid)?;
    let (subscribed, archived) = match state {
        Some((archived, subscribed)) => (subscribed, archived),
        None => (false, false),
    };

    Ok(Json(ThreadSubscriptionStatusResponse {
        subscribed,
        archived,
    }))
}

/// PUT /chats/:chat_id/threads/:thread_root_id/archive — Archive a thread subscription.
#[utoipa::path(
    put,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
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
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let updated = thread_svc::archive_thread(conn, chat_id, thread_root_id, uid)?;
    if updated {
        thread_svc::broadcast_thread_membership_changed_to_user(
            &state.ws_registry,
            uid,
            chat_id,
            thread_root_id,
        );
    }

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /chats/:chat_id/threads/:thread_root_id/archive — Unarchive a thread subscription.
#[utoipa::path(
    delete,
    path = "/",
    tag = "threads",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_root_id" = i64, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
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
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let updated = thread_svc::unarchive_thread(conn, chat_id, thread_root_id, uid)?;
    if updated {
        thread_svc::broadcast_thread_membership_changed_to_user(
            &state.ws_registry,
            uid,
            chat_id,
            thread_root_id,
        );
    }

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_threads))
        .routes(utoipa_axum::routes!(get_unread_thread_count))
        .routes(utoipa_axum::routes!(mark_thread_read))
        .routes(utoipa_axum::routes!(get_thread_read_state))
}
/// Routes that are nested under /chats/:chat_id/threads/:thread_root_id
pub fn subscribe_router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
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
}
