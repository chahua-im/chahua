use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use diesel::prelude::*;
use std::time::Instant;
use utoipa_axum::router::OpenApiRouter;

use crate::schema::messages::dsl;
use crate::{
    dto::{
        messages::{ListMessagesResponse, MessageResponse, SearchMessagesResponse},
        ws::ServerWsMessage,
    },
    errors::AppError,
    extractors::DbConn,
    handlers::{groups::load_requester_group_role, members::check_membership},
    models::{GroupRole, Message, MessageType},
    schema::{attachments, group_membership, groups, messages},
    services::message_search::{
        filter_authoritative_hits_with_counts, validate_search_query, MessageSearchSort,
        SearchCandidateDropCounts,
    },
    utils::{auth::CurrentUid, pagination::validate_limit},
    AppState, MAX_MESSAGES_LIMIT,
};

use super::{
    attach_metadata, extract_mention_uids, send_prepared_message, ChatIdPath, CreateMessageBody,
    PreparedMessageSend, SendMessageOutcome,
};

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListMessagesQuery {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    before: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    around: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    after: Option<i64>,
    #[serde(default)]
    max: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    thread_id: Option<i64>,
}

#[derive(serde::Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct SearchMessagesQuery {
    q: String,
    #[serde(default)]
    sort: Option<MessageSearchSort>,
    limit: Option<i64>,
    offset: Option<usize>,
}

#[derive(serde::Deserialize)]
pub struct ThreadIdPath {
    chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    thread_id: i64,
}

#[derive(serde::Deserialize)]
pub struct MessageIdPath {
    chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    message_id: i64,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMessageBody {
    message: String,
    #[serde(default)]
    attachment_ids: Vec<String>,
}

const SYSTEM_MESSAGE_TYPE_FORBIDDEN: &str = "System messages cannot be sent by clients";
const INVITE_MESSAGE_TYPE_FORBIDDEN: &str = "Invite messages must be sent through invite APIs";
const DEFAULT_SEARCH_LIMIT: i64 = 20;
const MAX_SEARCH_RESULT_WINDOW: usize = 1_000;

fn validate_client_message_type(message_type: &MessageType) -> Result<(), AppError> {
    if matches!(message_type, MessageType::System) {
        return Err(AppError::BadRequest(SYSTEM_MESSAGE_TYPE_FORBIDDEN));
    }

    if matches!(message_type, MessageType::Invite) {
        return Err(AppError::BadRequest(INVITE_MESSAGE_TYPE_FORBIDDEN));
    }

    Ok(())
}

fn search_limit(limit: Option<i64>) -> usize {
    validate_limit(
        Some(limit.unwrap_or(DEFAULT_SEARCH_LIMIT)),
        MAX_MESSAGES_LIMIT,
    ) as usize
}

fn search_offset(offset: Option<usize>, limit: usize) -> Result<usize, AppError> {
    let offset = offset.unwrap_or(0);
    if offset.saturating_add(limit) > MAX_SEARCH_RESULT_WINDOW {
        return Err(AppError::BadRequest("Search offset is too large"));
    }
    Ok(offset)
}

fn search_next_offset(next_offset: Option<usize>, limit: usize) -> Option<usize> {
    next_offset.filter(|offset| offset.saturating_add(limit) <= MAX_SEARCH_RESULT_WINDOW)
}

const MAX_ATTACHMENTS_PER_MESSAGE: usize = 20;

fn validate_message_payload(
    body: &CreateMessageBody,
    attachment_ids: &[i64],
) -> Result<(), AppError> {
    if attachment_ids.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(AppError::BadRequest(
            "Too many attachments (maximum of 20 allowed)",
        ));
    }

    if matches!(body.message_type, MessageType::Sticker) {
        body.sticker_id
            .ok_or(AppError::BadRequest("Sticker ID is required"))?;

        if !attachment_ids.is_empty() {
            return Err(AppError::BadRequest(
                "Sticker messages cannot include attachments",
            ));
        }
        if body
            .message
            .as_deref()
            .is_some_and(|message| !message.trim().is_empty())
        {
            return Err(AppError::BadRequest("Sticker messages cannot include text"));
        }
    } else if body.sticker_id.is_some() {
        return Err(AppError::BadRequest(
            "Sticker ID is only valid for sticker messages",
        ));
    }

    Ok(())
}

/// GET /chats/:chat_id/messages — List messages in a chat (cursor-based).
#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("before" = Option<String>, Query, description = "Cursor: fetch messages before this ID"),
        ("around" = Option<String>, Query, description = "Cursor: fetch messages around this ID"),
        ("after" = Option<String>, Query, description = "Cursor: fetch messages after this ID"),
        ("max" = Option<i64>, Query, description = "Max number of messages to return"),
        ("thread_id" = Option<String>, Query, description = "Thread root ID to filter by"),
    ),
    responses(
        (status = 200, description = "List of messages", body = ListMessagesResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Query(q): Query<ListMessagesQuery>,
) -> Result<Json<ListMessagesResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let max = validate_limit(q.max, MAX_MESSAGES_LIMIT);

    let q_thread_id = q.thread_id;
    macro_rules! base_query {
        () => {{
            let mut b = messages::table
                .into_boxed()
                .filter(dsl::chat_id.eq(chat_id).and(dsl::is_published.eq(true)));
            if let Some(tid) = q_thread_id {
                b = b.filter(
                    dsl::reply_root_id
                        .eq(tid)
                        .and(dsl::deleted_at.is_null())
                        .or(dsl::id.eq(tid)),
                );
            } else {
                b = b.filter(
                    dsl::reply_root_id
                        .is_null()
                        .and(dsl::deleted_at.is_null().or(dsl::has_thread.eq(true))),
                );
            }
            b
        }};
    }

    // around=<id>: fetch a window centered on the target message
    if let Some(target) = q.around {
        let half = max / 2;

        // Messages with id >= target, ordered ASC (target first, then newer)
        let newer_rows: Vec<Message> = base_query!()
            .filter(dsl::id.ge(target))
            .order(dsl::id.asc())
            .limit(half + 2)
            .select(Message::as_select())
            .load(conn)?;

        // Messages with id < target, ordered DESC (closest to target first)
        let older_rows: Vec<Message> = base_query!()
            .filter(dsl::id.lt(target))
            .order(dsl::id.desc())
            .limit(half + 1)
            .select(Message::as_select())
            .load(conn)?;

        let has_older = older_rows.len() as i64 > half;
        let has_newer = newer_rows.len() as i64 > half + 1;

        let older_to_use: Vec<Message> = older_rows.into_iter().take(half as usize).collect();
        let newer_to_use: Vec<Message> = newer_rows.into_iter().take((half + 1) as usize).collect();

        // next_cursor = oldest id (for loading older), prev_cursor = newest id (for loading newer)
        let next_cursor = has_older
            .then(|| older_to_use.last().map(|m| m.id))
            .flatten();
        let prev_cursor = has_newer
            .then(|| newer_to_use.last().map(|m| m.id))
            .flatten();

        // Combine: older reversed (oldest first) + newer (target first, ascending)
        let mut combined: Vec<Message> = older_to_use.into_iter().rev().collect();
        combined.extend(newer_to_use);

        let messages_vec = attach_metadata(conn, combined, &state, uid).await;

        return Ok(Json(ListMessagesResponse {
            messages: messages_vec,
            next_cursor,
            prev_cursor,
        }));
    }

    // after=<id>: fetch messages newer than `after`, ascending order
    if let Some(after) = q.after {
        let rows: Vec<Message> = base_query!()
            .filter(dsl::id.gt(after))
            .order(dsl::id.asc())
            .limit(max + 1)
            .select(Message::as_select())
            .load(conn)?;

        let has_more = rows.len() as i64 > max;
        let messages_to_process: Vec<Message> = rows.into_iter().take(max as usize).collect();
        let prev_cursor = has_more
            .then(|| messages_to_process.last().map(|m| m.id))
            .flatten();

        let messages_vec = attach_metadata(conn, messages_to_process, &state, uid).await;

        return Ok(Json(ListMessagesResponse {
            messages: messages_vec,
            next_cursor: None,
            prev_cursor,
        }));
    }

    // Default: before cursor, descending (newest first in response, reversed by client)
    let rows: Vec<Message> = match q.before {
        None => base_query!()
            .order(dsl::id.desc())
            .limit(max + 1)
            .select(Message::as_select())
            .load(conn),
        Some(before) => base_query!()
            .filter(dsl::id.lt(before))
            .order(dsl::id.desc())
            .limit(max + 1)
            .select(Message::as_select())
            .load(conn),
    }?;

    let has_more = rows.len() as i64 > max;
    let messages_to_process: Vec<Message> = rows.into_iter().take(max as usize).collect();
    let next_cursor = has_more
        .then(|| messages_to_process.last().map(|m| m.id))
        .flatten();

    // Reverse to return ASC (oldest first)
    let messages_to_process: Vec<Message> = messages_to_process.into_iter().rev().collect();

    let messages_vec = attach_metadata(conn, messages_to_process, &state, uid).await;

    Ok(Json(ListMessagesResponse {
        messages: messages_vec,
        next_cursor,
        prev_cursor: None,
    }))
}

/// GET /chats/:chat_id/messages/search — Search visible messages in a chat.
#[utoipa::path(
    get,
    path = "/search",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        SearchMessagesQuery,
    ),
    responses(
        (status = 200, description = "Search results", body = SearchMessagesResponse),
        (status = 400, description = "Invalid search query"),
        (status = 503, description = "Message search unavailable"),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn search_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Query(params): Query<SearchMessagesQuery>,
) -> Result<Json<SearchMessagesResponse>, AppError> {
    let started_at = Instant::now();
    let conn = &mut *conn;
    let sort = params.sort.unwrap_or(MessageSearchSort::Relevance);
    let sort_label = sort.as_str();

    if let Err(err) = check_membership(conn, chat_id, uid) {
        record_search_query_metrics(&state.metrics, sort_label, "failure", started_at);
        return Err(err);
    }

    let query = match validate_search_query(&params.q) {
        Ok(query) => query,
        Err(_) => {
            record_search_query_metrics(&state.metrics, sort_label, "failure", started_at);
            return Err(AppError::BadRequest(
                "Search query must be at least 2 characters",
            ));
        }
    };
    let limit = search_limit(params.limit);
    let offset = match search_offset(params.offset, limit) {
        Ok(offset) => offset,
        Err(err) => {
            record_search_query_metrics(&state.metrics, sort_label, "failure", started_at);
            return Err(err);
        }
    };

    let Some(search_service) = state.message_search.clone() else {
        record_search_query_metrics(&state.metrics, sort_label, "failure", started_at);
        return Err(AppError::ServiceUnavailable("Message search unavailable"));
    };

    let candidate_page = match search_service
        .search_candidates(&query, chat_id, sort, limit, offset)
        .await
    {
        Ok(page) => page,
        Err(err) => {
            record_search_query_metrics(&state.metrics, sort_label, "failure", started_at);
            tracing::warn!(
                chat_id,
                sort = sort_label,
                ?err,
                "message search query failed"
            );
            return Err(AppError::ServiceUnavailable("Message search unavailable"));
        }
    };
    state
        .metrics
        .observe_message_search_candidates(sort_label, candidate_page.candidates.len());
    let next_offset = search_next_offset(candidate_page.next_offset, limit);

    if candidate_page.candidates.is_empty() {
        state.metrics.observe_message_search_results(sort_label, 0);
        record_search_query_metrics(&state.metrics, sort_label, "success", started_at);
        return Ok(Json(SearchMessagesResponse {
            messages: Vec::new(),
            next_offset,
        }));
    }

    let candidate_ids = candidate_page
        .candidates
        .iter()
        .map(|candidate| candidate.message_id)
        .collect::<Vec<_>>();
    let rows = match messages::table
        .filter(dsl::id.eq_any(&candidate_ids))
        .select(Message::as_select())
        .load::<Message>(conn)
    {
        Ok(rows) => rows,
        Err(err) => {
            record_search_query_metrics(&state.metrics, sort_label, "failure", started_at);
            return Err(err.into());
        }
    };

    let authoritative_hits =
        filter_authoritative_hits_with_counts(chat_id, &candidate_page.candidates, rows);
    record_search_candidate_drops(&state.metrics, authoritative_hits.drops);
    let messages = attach_metadata(conn, authoritative_hits.messages, &state, uid).await;
    state
        .metrics
        .observe_message_search_results(sort_label, messages.len());

    record_search_query_metrics(&state.metrics, sort_label, "success", started_at);

    Ok(Json(SearchMessagesResponse {
        messages,
        next_offset,
    }))
}

fn record_search_query_metrics(
    metrics: &crate::metrics::Metrics,
    sort_label: &str,
    result: &str,
    started_at: Instant,
) {
    metrics.record_message_search_query(sort_label, result);
    metrics.record_message_search_query_duration(
        sort_label,
        result,
        started_at.elapsed().as_secs_f64(),
    );
}

fn record_search_candidate_drops(
    metrics: &crate::metrics::Metrics,
    drops: SearchCandidateDropCounts,
) {
    metrics.record_message_search_candidate_drop("missing_db_row", drops.missing_db_row);
    metrics.record_message_search_candidate_drop("wrong_chat", drops.wrong_chat);
    metrics.record_message_search_candidate_drop("not_searchable", drops.not_searchable);
    metrics.record_message_search_candidate_drop("stale_version", drops.stale_version);
}

/// GET /chats/:chat_id/messages/:message_id — Get a single message.
#[utoipa::path(
    get,
    path = "/{message_id}",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("message_id" = i64, Path, description = "Message ID"),
    ),
    responses(
        (status = 200, description = "Single message", body = MessageResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
) -> Result<Json<MessageResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let message: Message = messages::table
        .filter(
            dsl::id
                .eq(message_id)
                .and(dsl::chat_id.eq(chat_id))
                .and(dsl::deleted_at.is_null())
                .and(dsl::is_published.eq(true)),
        )
        .select(Message::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    let messages_vec = attach_metadata(conn, vec![message], &state, uid).await;
    let response = messages_vec.into_iter().next().unwrap();

    Ok(Json(response))
}

/// POST /chats/:chat_id/messages — Send a message.
#[utoipa::path(
    post,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body = CreateMessageBody,
    responses(
        (status = 201, description = "Message created", body = MessageResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn post_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<CreateMessageBody>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;
    validate_client_message_type(&body.message_type)?;
    let attachment_ids: Vec<i64> = body
        .attachment_ids
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    validate_message_payload(&body, &attachment_ids)?;

    // Keep message creation and read-position advancement atomic.
    diesel::sql_query("BEGIN").execute(conn)?;

    let publish_immediately = !matches!(body.message_type, MessageType::Audio);
    let tx_result: Result<_, AppError> = async {
        let send_result = send_prepared_message(
            conn,
            &state,
            PreparedMessageSend {
                chat_id,
                sender_uid: uid,
                message: if matches!(body.message_type, MessageType::Sticker) {
                    None
                } else {
                    body.message
                },
                message_type: body.message_type,
                sticker_id: body.sticker_id,
                reply_to_id: body.reply_to_id,
                reply_root_id: None,
                client_generated_id: body.client_generated_id,
                attachment_ids,
                publish_immediately,
            },
        )
        .await?;

        if let SendMessageOutcome::Created(send_result) = &send_result {
            crate::services::chat::mark_chat_as_read(conn, chat_id, uid, send_result.response.id)?;
        }

        Ok(send_result)
    }
    .await;

    let send_result = match tx_result {
        Ok(send_result) => {
            diesel::sql_query("COMMIT").execute(conn)?;
            send_result
        }
        Err(err) => {
            let _ = diesel::sql_query("ROLLBACK").execute(conn);
            return Err(err);
        }
    };

    let response = match send_result {
        SendMessageOutcome::Created(send_result) => {
            let send_result = *send_result;
            send_result.side_effects.fire(&state);
            if let Some(search_service) = state.message_search.clone() {
                search_service.upsert_message_best_effort(send_result.inserted_message);
            }
            if matches!(send_result.response.message_type, MessageType::Audio) {
                crate::services::audio_transcode::enqueue_message(send_result.response.id);
            }
            send_result.response
        }
        SendMessageOutcome::Duplicate(response) => *response,
    };

    Ok((StatusCode::CREATED, Json(response)))
}

/// POST /chats/:chat_id/threads/:thread_id/messages — Send a message in a thread.
#[utoipa::path(
    post,
    path = "/threads/{thread_id}/messages",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("thread_id" = i64, Path, description = "Thread root message ID"),
    ),
    request_body = CreateMessageBody,
    responses(
        (status = 201, description = "Thread message created", body = MessageResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
pub(super) async fn post_thread_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadIdPath { chat_id, thread_id }): Path<ThreadIdPath>,
    mut conn: DbConn,
    Json(body): Json<CreateMessageBody>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;
    validate_client_message_type(&body.message_type)?;

    // Load root message: validate existence. Allow deleted roots only when a
    // thread already exists (has_thread=true) so existing discussions stay usable.
    // A deleted message with has_thread=false means the discussion is fully
    // terminated, so it's excluded here and surfaces as NotFound.

    let root_msg: Message = messages::table
        .filter(
            dsl::id
                .eq(thread_id)
                .and(dsl::chat_id.eq(chat_id))
                .and(dsl::is_published.eq(true))
                .and(dsl::deleted_at.is_null().or(dsl::has_thread.eq(true))),
        )
        .select(Message::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Thread root message not found"))?;

    // Skip message-type check for deleted roots - the thread already exists.
    // Invariant: only Text messages can ever acquire has_thread=true (enforced in
    // post_thread_message above), so a deleted root is guaranteed to be Text and
    // does not need re-validation. We skip solely because message_type is not
    // reliable for deleted rows that may have been redacted.
    if root_msg.deleted_at.is_none() && root_msg.message_type != MessageType::Text {
        return Err(AppError::BadRequest(
            "Threads can only be created on text messages",
        ));
    }
    let attachment_ids: Vec<i64> = body
        .attachment_ids
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    validate_message_payload(&body, &attachment_ids)?;

    // Begin transaction: message insert + thread_meta + subscriptions are atomic.
    // send_prepared_message is async so we use raw BEGIN/COMMIT.
    diesel::sql_query("BEGIN").execute(conn)?;

    let publish_immediately = !matches!(body.message_type, MessageType::Audio);
    let tx_result: Result<_, AppError> = async {
        let send_result = send_prepared_message(
            conn,
            &state,
            PreparedMessageSend {
                chat_id,
                sender_uid: uid,
                message: if matches!(body.message_type, MessageType::Sticker) {
                    None
                } else {
                    body.message
                },
                message_type: body.message_type,
                sticker_id: body.sticker_id,
                reply_to_id: body.reply_to_id,
                reply_root_id: Some(thread_id),
                client_generated_id: body.client_generated_id,
                attachment_ids,
                publish_immediately,
            },
        )
        .await?;
        let send_result = match send_result {
            SendMessageOutcome::Created(send_result) => *send_result,
            SendMessageOutcome::Duplicate(response) => {
                return Ok(SendMessageOutcome::Duplicate(response));
            }
        };
        let response = send_result.response.clone();
        let publish_now = publish_immediately;

        // Auto-subscribe the replying user and track read position
        crate::services::threads::ensure_thread_subscription(conn, chat_id, thread_id, uid)?;
        crate::services::threads::mark_thread_as_read(conn, chat_id, thread_id, uid, response.id)?;

        // Ensure the root author has an initial participant row without
        // overriding any existing subscription or archive preference.
        if root_msg.sender_uid != uid {
            crate::services::threads::ensure_thread_user_state(
                conn,
                chat_id,
                thread_id,
                root_msg.sender_uid,
                true,
            )?;
        }

        // Auto-subscribe mentioned users
        if let Some(ref text) = response.message {
            for mentioned_uid in extract_mention_uids(text) {
                if mentioned_uid != uid {
                    crate::services::threads::ensure_thread_subscription(
                        conn,
                        chat_id,
                        thread_id,
                        mentioned_uid,
                    )?;
                }
            }
        }

        if publish_now {
            crate::services::threads::increment_thread_meta(
                conn,
                chat_id,
                thread_id,
                response.created_at,
            )?;

            // Mark the root message as having a thread
            diesel::update(messages::table.filter(dsl::id.eq(thread_id)))
                .set(dsl::has_thread.eq(true))
                .execute(conn)?;
        }

        Ok(SendMessageOutcome::Created(Box::new(send_result)))
    }
    .await;

    let send_result = match tx_result {
        Ok(data) => {
            diesel::sql_query("COMMIT").execute(conn)?;
            data
        }
        Err(e) => {
            let _ = diesel::sql_query("ROLLBACK").execute(conn);
            return Err(e);
        }
    };

    let send_result = match send_result {
        SendMessageOutcome::Created(send_result) => *send_result,
        SendMessageOutcome::Duplicate(response) => {
            return Ok((StatusCode::CREATED, Json(*response)));
        }
    };

    let response = send_result.response;
    let member_uids = send_result.member_uids;
    let msg_side_effects = send_result.side_effects;

    // Post-commit: fire deferred side effects (new message WS broadcast + push)
    msg_side_effects.fire(&state);
    if let Some(search_service) = state.message_search.clone() {
        search_service.upsert_response_best_effort(response.clone());
    }
    if matches!(response.message_type, MessageType::Audio) {
        crate::services::audio_transcode::enqueue_message(response.id);
    }

    // Post-commit: WS broadcasts (root message update + thread update)
    let root_msg_updated: Option<Message> = messages::table
        .filter(dsl::id.eq(thread_id))
        .select(Message::as_select())
        .first(conn)
        .ok();

    if publish_immediately {
        if let Some(root_msg) = root_msg_updated {
            let root_response = attach_metadata(conn, vec![root_msg], &state, uid)
                .await
                .into_iter()
                .next()
                .unwrap();
            let ws_msg =
                std::sync::Arc::new(ServerWsMessage::MessageUpdated(root_response.clone()));
            state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);
        }

        if let Err(err) = crate::services::threads::broadcast_thread_update_to_subscribers(
            conn,
            &state.ws_registry,
            chat_id,
            thread_id,
        ) {
            tracing::warn!(
                chat_id,
                thread_id,
                ?err,
                "failed to broadcast thread update to subscribers"
            );
        }
    }

    Ok((StatusCode::CREATED, Json(response)))
}

/// PATCH /chats/:chat_id/messages/:message_id — Edit a message.
#[utoipa::path(
    patch,
    path = "/{message_id}",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("message_id" = i64, Path, description = "Message ID"),
    ),
    request_body = UpdateMessageBody,
    responses(
        (status = 200, description = "Updated message", body = MessageResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn patch_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
    Json(body): Json<UpdateMessageBody>,
) -> Result<Json<MessageResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    // Verify message exists and belongs to the user

    let message: Message = messages::table
        .filter(dsl::id.eq(message_id).and(dsl::chat_id.eq(chat_id)))
        .select(Message::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    if message.sender_uid != uid {
        return Err(AppError::Forbidden("You can only edit your own messages"));
    }

    if message.deleted_at.is_some() {
        return Err(AppError::BadRequest("Cannot edit deleted message"));
    }
    if !message.is_published {
        return Err(AppError::BadRequest("Cannot edit unpublished message"));
    }

    if body.message.trim().is_empty() && body.attachment_ids.is_empty() {
        return Err(AppError::BadRequest("Message cannot be empty"));
    }

    let attachment_ids: Vec<i64> = body
        .attachment_ids
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();

    if attachment_ids.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(AppError::BadRequest(
            "Too many attachments (maximum of 20 allowed)",
        ));
    }

    use crate::schema::attachments::dsl as a_dsl;
    diesel::update(attachments::table.filter(a_dsl::message_id.eq(message_id)))
        .set(a_dsl::message_id.eq::<Option<i64>>(None))
        .execute(conn)?;

    if !attachment_ids.is_empty() {
        diesel::update(attachments::table.filter(a_dsl::id.eq_any(&attachment_ids)))
            .set(a_dsl::message_id.eq(message_id))
            .execute(conn)?;
    }

    // Update message
    let now = Utc::now();
    let updated_message: Message = diesel::update(messages::table.filter(dsl::id.eq(message_id)))
        .set((
            dsl::message.eq(&body.message),
            dsl::has_attachments.eq(!attachment_ids.is_empty()),
            dsl::updated_at.eq(Some(now)),
        ))
        .returning(Message::as_returning())
        .get_result(conn)?;

    if let Some(search_service) = state.message_search.clone() {
        search_service.upsert_message_best_effort(updated_message.clone());
    }

    let response = attach_metadata(conn, vec![updated_message], &state, uid)
        .await
        .into_iter()
        .next()
        .unwrap();

    // Broadcast update to all members
    let member_uids: Vec<i32> = {
        use crate::schema::group_membership as gm_dsl;
        group_membership::table
            .filter(gm_dsl::chat_id.eq(chat_id))
            .select(group_membership::uid)
            .load(conn)?
    };
    let ws_msg = std::sync::Arc::new(ServerWsMessage::MessageUpdated(response.clone()));
    state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);

    Ok(Json(response))
}

/// DELETE /chats/:chat_id/messages/:message_id — Delete a message (soft delete).
#[utoipa::path(
    delete,
    path = "/{message_id}",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("message_id" = i64, Path, description = "Message ID"),
    ),
    responses(
        (status = 204, description = "Message deleted"),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn delete_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    // Verify message exists and belongs to the user
    let message: Message = messages::table
        .filter(dsl::id.eq(message_id).and(dsl::chat_id.eq(chat_id)))
        .select(Message::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    if message.sender_uid != uid {
        // Not the sender — allow if requester is an admin
        let role = load_requester_group_role(conn, chat_id, uid)?;
        if role != Some(GroupRole::Admin) {
            return Err(AppError::Forbidden("You can only delete your own messages"));
        }
    }

    if message.deleted_at.is_some() {
        return Err(AppError::Gone("Message already deleted"));
    }
    if !message.is_published {
        return Err(AppError::BadRequest("Cannot delete unpublished message"));
    }

    // Transaction: soft-delete + thread_meta + group last_message
    let now = Utc::now();
    let deleted_message: Message = conn.transaction::<_, diesel::result::Error, _>(|conn| {
        let deleted_message: Message =
            diesel::update(messages::table.filter(dsl::id.eq(message_id)))
                .set(dsl::deleted_at.eq(Some(now)))
                .returning(Message::as_returning())
                .get_result(conn)?;

        if let Some(reply_root_id) = deleted_message.reply_root_id {
            crate::services::threads::recalculate_thread_meta(conn, chat_id, reply_root_id)?;
        }

        {
            use crate::schema::groups::dsl as g_dsl;
            let group_last_msg: Option<i64> = groups::table
                .filter(g_dsl::id.eq(chat_id))
                .select(g_dsl::last_message_id)
                .first::<Option<i64>>(conn)?;

            if group_last_msg == Some(message_id) {
                super::recalculate_group_last_message(conn, chat_id)
                    .map_err(|_| diesel::result::Error::RollbackTransaction)?;
            }
        }

        // Shift any read pointers anchored on the deleted message so they
        // don't dangle (PWA `around=<last_read_message_id>` would strand
        // scroll). Only a top-level message with no thread can dangle a
        // chat-level pointer; a reply dangles its thread-level pointer.
        if let Some(thread_root_id) = deleted_message.reply_root_id {
            crate::services::threads::shift_thread_read_pointers_on_delete(
                conn,
                thread_root_id,
                &[message_id],
            )?;
        } else if !deleted_message.has_thread {
            super::shift_chat_read_pointers_on_delete(conn, chat_id, &[message_id])?;
        }

        Ok(deleted_message)
    })?;

    if let Some(search_service) = state.message_search.clone() {
        search_service.delete_message_best_effort(message_id);
    }

    // Update unread count if the message is not in a thread
    if deleted_message.reply_root_id.is_none() {
        state
            .unread_service
            .observe_top_level_message_counted(chat_id, message_id, false);
    }

    let response = attach_metadata(conn, vec![deleted_message], &state, uid)
        .await
        .into_iter()
        .next()
        .unwrap();

    // Broadcast deletion to all members
    let member_uids: Vec<i32> = {
        use crate::schema::group_membership as gm_dsl;
        group_membership::table
            .filter(gm_dsl::chat_id.eq(chat_id))
            .select(group_membership::uid)
            .load(conn)?
    };
    let ws_msg = std::sync::Arc::new(ServerWsMessage::MessageDeleted(response.clone()));
    state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);

    // Thread reply deletion: broadcast the lighter ThreadUpdate (carries reply_count /
    // last_reply_at) to subscribers for the thread-list view. The parent-chat bubble
    // badge is refreshed for ALL members by the MessageUpdated(root) broadcast below.
    if let Some(reply_root_id) = response.reply_root_id {
        if let Err(err) = crate::services::threads::broadcast_thread_update_to_subscribers(
            conn,
            &state.ws_registry,
            chat_id,
            reply_root_id,
        ) {
            tracing::warn!(
                chat_id,
                reply_root_id,
                ?err,
                "failed to broadcast thread update after reply deletion"
            );
        }
    }

    // Broadcast the updated root message to ALL members so the thread-reply
    // count badge (threadInfo.replyCount) decreases in real-time — mirrors the
    // reply-create path which broadcasts MessageUpdated(root) to all members.
    // The ThreadUpdate above only reaches subscribed users; the bubble audience
    // is all members viewing the parent timeline, many of whom are not
    // subscribed (thread view does not set subscribed=true).
    if let Some(reply_root_id) = response.reply_root_id {
        let root_msg_updated: Option<Message> = messages::table
            .filter(dsl::id.eq(reply_root_id).and(dsl::chat_id.eq(chat_id)))
            .select(Message::as_select())
            .first(conn)
            .ok();
        if let Some(root_msg) = root_msg_updated {
            let root_response = attach_metadata(conn, vec![root_msg], &state, uid)
                .await
                .into_iter()
                .next();
            if let Some(root_response) = root_response {
                let ws_msg = std::sync::Arc::new(ServerWsMessage::MessageUpdated(root_response));
                state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);
            }
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_messages, post_message))
        .routes(utoipa_axum::routes!(search_messages))
        .routes(utoipa_axum::routes!(
            get_message,
            patch_message,
            delete_message
        ))
}

#[cfg(test)]
mod tests {
    use super::{
        search_limit, search_next_offset, search_offset, validate_client_message_type,
        INVITE_MESSAGE_TYPE_FORBIDDEN, MAX_SEARCH_RESULT_WINDOW, SYSTEM_MESSAGE_TYPE_FORBIDDEN,
    };
    use crate::errors::AppError;
    use crate::models::MessageType;
    use crate::services::message_search::MessageSearchSort;

    #[test]
    fn rejects_system_message_type_from_clients() {
        let err = validate_client_message_type(&MessageType::System)
            .expect_err("system should be rejected");
        assert!(matches!(err, AppError::BadRequest(msg) if msg == SYSTEM_MESSAGE_TYPE_FORBIDDEN));
    }

    #[test]
    fn allows_standard_message_types_from_clients() {
        assert!(validate_client_message_type(&MessageType::Text).is_ok());
        assert!(validate_client_message_type(&MessageType::Audio).is_ok());
        assert!(validate_client_message_type(&MessageType::File).is_ok());
        assert!(validate_client_message_type(&MessageType::Sticker).is_ok());
    }

    #[test]
    fn rejects_invite_message_type_from_generic_message_api() {
        let err = validate_client_message_type(&MessageType::Invite)
            .expect_err("invite should be rejected");
        assert!(matches!(err, AppError::BadRequest(msg) if msg == INVITE_MESSAGE_TYPE_FORBIDDEN));
    }

    #[test]
    fn search_limit_defaults_to_twenty_and_caps_to_message_max() {
        assert_eq!(search_limit(None), 20);
        assert_eq!(search_limit(Some(500)), 100);
        assert_eq!(search_limit(Some(0)), 1);
    }

    #[test]
    fn search_offset_rejects_requests_outside_result_window() {
        assert_eq!(search_offset(None, 20).unwrap(), 0);
        assert_eq!(
            search_offset(Some(MAX_SEARCH_RESULT_WINDOW - 20), 20).unwrap(),
            980
        );
        assert!(matches!(
            search_offset(Some(MAX_SEARCH_RESULT_WINDOW - 19), 20),
            Err(AppError::BadRequest("Search offset is too large"))
        ));
    }

    #[test]
    fn search_next_offset_stops_at_result_window() {
        assert_eq!(
            search_next_offset(Some(MAX_SEARCH_RESULT_WINDOW - 20), 20),
            Some(980)
        );
        assert_eq!(
            search_next_offset(Some(MAX_SEARCH_RESULT_WINDOW - 19), 20),
            None
        );
        assert_eq!(search_next_offset(None, 20), None);
    }

    #[test]
    fn search_sort_rejects_unknown_values() {
        assert!(serde_json::from_str::<MessageSearchSort>("\"oldest\"").is_err());
        assert_eq!(
            serde_json::from_str::<MessageSearchSort>("\"newest\"").unwrap(),
            MessageSearchSort::Newest
        );
    }
}
