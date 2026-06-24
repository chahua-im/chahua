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
    let offset = params.offset.unwrap_or(0);

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

    if candidate_page.candidates.is_empty() {
        state.metrics.observe_message_search_results(sort_label, 0);
        record_search_query_metrics(&state.metrics, sort_label, "success", started_at);
        return Ok(Json(SearchMessagesResponse {
            messages: Vec::new(),
            next_offset: candidate_page.next_offset,
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
        next_offset: candidate_page.next_offset,
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
    let response = messages_vec
        .into_iter()
        .next()
        .ok_or(AppError::Internal("Failed to build message response"))?;

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
                forwarded_from_message_id: None,
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

/// Load and validate a thread root message.
/// Returns NotFound if the message doesn't exist, BadRequest if it's not a text message.
fn load_thread_root_message(
    conn: &mut diesel::PgConnection,
    thread_id: i64,
    chat_id: i64,
) -> Result<Message, AppError> {
    let root: Message = messages::table
        .filter(
            dsl::id
                .eq(thread_id)
                .and(dsl::chat_id.eq(chat_id))
                // Removed: .and(dsl::deleted_at.is_null()) — deleted roots must stay reachable.
                .and(dsl::is_published.eq(true)),
        )
        .select(Message::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Thread root message not found"))?;
    // Block creating new threads on deleted messages that have no existing thread.
    // A deleted message with has_thread=false means the discussion is fully terminated.
    if root.deleted_at.is_some() && !root.has_thread {
        return Err(AppError::BadRequest(
            "Cannot create a thread on a deleted message with no existing replies",
        ));
    }

    // Skip message-type check for deleted roots - the thread already exists.
    // Invariant: only Text messages can ever acquire has_thread=true (enforced in
    // post_thread_message above), so a deleted root is guaranteed to be Text and
    // does not need re-validation. We skip solely because message_type is not
    // reliable for deleted rows that may have been redacted.
    if root.deleted_at.is_none() && root.message_type != MessageType::Text {
        return Err(AppError::BadRequest(
            "Threads can only be created on text messages",
        ));
    }
    Ok(root)
}

/// Apply thread side effects after inserting a message into a thread.
/// Handles: sender subscription, read position, root author subscription,
/// thread metadata increment, and root message has_thread flag.
fn apply_thread_side_effects(
    conn: &mut diesel::PgConnection,
    chat_id: i64,
    thread_id: i64,
    sender_uid: i32,
    root_sender_uid: i32,
    inserted_msg_id: i64,
    created_at: chrono::DateTime<chrono::Utc>,
) -> Result<(), AppError> {
    crate::services::threads::ensure_thread_subscription(conn, chat_id, thread_id, sender_uid)?;
    crate::services::threads::mark_thread_as_read(
        conn,
        chat_id,
        thread_id,
        sender_uid,
        inserted_msg_id,
    )?;
    if root_sender_uid != sender_uid {
        crate::services::threads::ensure_thread_subscription(
            conn,
            chat_id,
            thread_id,
            root_sender_uid,
        )?;
    }
    crate::services::threads::increment_thread_meta(conn, chat_id, thread_id, created_at)?;
    diesel::update(messages::table.filter(dsl::id.eq(thread_id)))
        .set(dsl::has_thread.eq(true))
        .execute(conn)?;
    Ok(())
}

/// Best-effort thread-update broadcast: log a warning on failure instead of
/// propagating the error. Thread-update delivery must never roll back an
/// otherwise-successful message create/delete/forward.
fn broadcast_thread_update_safely(
    conn: &mut diesel::PgConnection,
    state: &AppState,
    chat_id: i64,
    thread_id: i64,
) {
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

/// Clone all attachments belonging to `source_message_id` into new attachment rows
/// (message_id = None; send_prepared_message links them later). Returns generated
/// attachment IDs in original order. Used by message forwarding.
async fn clone_attachments_for_forward(
    conn: &mut diesel::PgConnection,
    source_message_id: i64,
    id_gen: &crate::utils::ids::IdGen,
) -> Result<Vec<i64>, AppError> {
    use crate::schema::attachments::dsl as a_dsl;
    let original_attachments: Vec<crate::models::Attachment> = attachments::table
        .filter(a_dsl::message_id.eq(source_message_id))
        .select(crate::models::Attachment::as_select())
        .load(conn)?;

    let mut cloned_attachment_ids: Vec<i64> = Vec::new();
    for att in &original_attachments {
        let new_id = crate::utils::ids::next_message_id(id_gen)
            .await
            .map_err(|e| {
                tracing::error!("next_message_id for forwarded attachment: {:?}", e);
                AppError::Internal("Failed to generate attachment ID")
            })?;
        // Insert with message_id = None; send_prepared_message will link them.
        diesel::insert_into(attachments::table)
            .values(&crate::models::NewAttachment {
                id: new_id,
                message_id: None,
                file_name: att.file_name.clone(),
                kind: att.kind.clone(),
                external_reference: att.external_reference.clone(),
                size: att.size,
                created_at: att.created_at,
                deleted_at: att.deleted_at,
                width: att.width,
                height: att.height,
                order: att.order,
            })
            .execute(conn)?;
        cloned_attachment_ids.push(new_id);
    }
    Ok(cloned_attachment_ids)
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

    // Load root message: validate existence and message type. Allow deleted roots so
    // threads remain usable (see load_thread_root_message for the deleted-root invariant).
    let root_msg = load_thread_root_message(conn, thread_id, chat_id)?;
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
                forwarded_from_message_id: None,
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

        // Auto-subscribe mentioned users (unique to thread replies)
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
            apply_thread_side_effects(
                conn,
                chat_id,
                thread_id,
                uid,
                root_msg.sender_uid,
                response.id,
                response.created_at,
            )?;
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

        broadcast_thread_update_safely(conn, &state, chat_id, thread_id);
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
    if message.forwarded_from_message_id.is_some() {
        return Err(AppError::Forbidden("Forwarded messages cannot be edited"));
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
        broadcast_thread_update_safely(conn, &state, chat_id, reply_root_id);
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

/// Request body for forwarding a message.
#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardMessageBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    pub source_chat_id: i64,
    pub client_generated_id: String,
    /// Optional: forward into a thread instead of top-level chat.
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub thread_id: Option<i64>,
}

/// POST /chats/:target_chat_id/messages/:message_id/forward — Forward a message to a chat.
#[utoipa::path(
    post,
    path = "/{message_id}/forward",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Target chat ID"),
        ("message_id" = i64, Path, description = "Source message ID"),
    ),
    request_body = ForwardMessageBody,
    responses(
        (status = 201, description = "Message forwarded", body = MessageResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn forward_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id: target_chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
    Json(body): Json<ForwardMessageBody>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;

    let source_chat_id = body.source_chat_id;
    // Forwarder must be a member of both source and target chats.
    check_membership(conn, source_chat_id, uid)?;
    check_membership(conn, target_chat_id, uid)?;
    // Load the original message from the source chat.
    use crate::schema::messages::dsl;
    let original: Message = messages::table
        .filter(
            dsl::id
                .eq(message_id)
                .and(dsl::chat_id.eq(source_chat_id))
                .and(dsl::deleted_at.is_null())
                .and(dsl::is_published.eq(true)),
        )
        .select(Message::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;
    // Reject forwarding of message types that clients are not allowed to send directly
    // (System / Invite). Otherwise a member could forward a system or invite message into
    // another chat, bypassing the dedicated send restrictions enforced in post_message.
    validate_client_message_type(&original.message_type)?;

    // If forwarding into a thread, validate the root message exists and is a text message.
    let thread_root: Option<Message> = if let Some(thread_id) = body.thread_id {
        Some(load_thread_root_message(conn, thread_id, target_chat_id)?)
    } else {
        None
    };

    // Keep message creation and side effects atomic.
    diesel::sql_query("BEGIN").execute(conn)?;

    let tx_result: Result<_, AppError> = async {
        // Re-validate inside the transaction: the original was loaded before BEGIN, so a
        // concurrent soft-delete could race. Re-check non-deleted + published here.
        let original_still_valid: bool = messages::table
            .filter(
                dsl::id
                    .eq(message_id)
                    .and(dsl::chat_id.eq(source_chat_id))
                    .and(dsl::deleted_at.is_null())
                    .and(dsl::is_published.eq(true)),
            )
            .count()
            .get_result::<i64>(conn)?
            > 0;
        if !original_still_valid {
            return Err(AppError::NotFound("Message not found"));
        }
        // forwarded_from_message_id always stores the root message ID,
        // so no chain resolution is needed.
        let root_message_id = original.forwarded_from_message_id.unwrap_or(original.id);

        // Clone attachments from the original message BEFORE send_prepared_message
        // so the WebSocket broadcast includes them.
        let cloned_attachment_ids =
            clone_attachments_for_forward(conn, original.id, state.id_gen.as_ref()).await?;

        let send_result = super::send_prepared_message(
            conn,
            &state,
            super::PreparedMessageSend {
                chat_id: target_chat_id,
                sender_uid: uid,
                message: original.message.clone(),
                message_type: original.message_type.clone(),
                sticker_id: original.sticker_id,
                reply_to_id: None,
                reply_root_id: body.thread_id,
                client_generated_id: body.client_generated_id,
                attachment_ids: cloned_attachment_ids,
                publish_immediately: true,
                forwarded_from_message_id: Some(root_message_id),
            },
        )
        .await?;

        let super::SendMessageOutcome::Created(created) = &send_result else {
            return Ok(send_result);
        };
        let inserted_msg = &created.inserted_message;

        // If forwarding into a thread, fire thread-specific side effects.
        if let (Some(thread_id), Some(root)) = (body.thread_id, &thread_root) {
            apply_thread_side_effects(
                conn,
                target_chat_id,
                thread_id,
                uid,
                root.sender_uid,
                inserted_msg.id,
                inserted_msg.created_at,
            )?;
            // Auto-subscribe mentioned users (mirrors post_thread_message) so they receive
            // subsequent ThreadUpdate broadcasts, not just this forward's push notification.
            // apply_thread_side_effects already subscribes sender + root author.
            if let Some(ref text) = original.message {
                for mentioned_uid in extract_mention_uids(text) {
                    if mentioned_uid != uid && mentioned_uid != root.sender_uid {
                        crate::services::threads::ensure_thread_subscription(
                            conn,
                            target_chat_id,
                            thread_id,
                            mentioned_uid,
                        )?;
                    }
                }
            }
        }
        Ok(send_result)
    }
    .await;

    match tx_result {
        Ok(send_result) => {
            diesel::sql_query("COMMIT").execute(conn)?;

            let response = match send_result {
                super::SendMessageOutcome::Created(created) => {
                    // If forwarding into a thread, broadcast thread update to subscribers.
                    if let Some(thread_id) = body.thread_id {
                        broadcast_thread_update_safely(conn, &state, target_chat_id, thread_id);
                    }
                    if let Some(search_service) = state.message_search.clone() {
                        search_service.upsert_message_best_effort(created.inserted_message.clone());
                    }
                    created.side_effects.fire(&state);

                    super::attach_metadata(conn, vec![created.inserted_message], &state, uid)
                        .await
                        .into_iter()
                        .next()
                        .unwrap()
                }
                // Client retry with the same client_generated_id: return the previously created
                // forwarded message instead of panicking. The original forward already
                // succeeded and was committed, so this is a safe idempotent replay.
                super::SendMessageOutcome::Duplicate(response) => *response,
            };

            Ok((StatusCode::CREATED, Json(response)).into_response())
        }
        Err(e) => {
            let _ = diesel::sql_query("ROLLBACK").execute(conn);
            Err(e)
        }
    }
}
pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_messages, post_message))
        .routes(utoipa_axum::routes!(search_messages))
        .routes(utoipa_axum::routes!(
            get_message,
            patch_message,
            delete_message,
            forward_message
        ))
}

#[cfg(test)]
mod tests {
    use super::{
        search_limit, validate_client_message_type, INVITE_MESSAGE_TYPE_FORBIDDEN,
        SYSTEM_MESSAGE_TYPE_FORBIDDEN,
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
    fn search_sort_rejects_unknown_values() {
        assert!(serde_json::from_str::<MessageSearchSort>("\"oldest\"").is_err());
        assert_eq!(
            serde_json::from_str::<MessageSearchSort>("\"newest\"").unwrap(),
            MessageSearchSort::Newest
        );
    }
}
