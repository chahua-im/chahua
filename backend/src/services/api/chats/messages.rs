use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use diesel::prelude::*;
use diesel::PgConnection;

use crate::dto::messages::{
    BulkDeleteMessagesBody, CreateMessageBody, ForwardMessageBody, ForwardMessagesBody,
    ListMessagesQuery, ListMessagesResponse, MessageResponse, SearchMessagesQuery,
    SearchMessagesResponse, UpdateMessageBody,
};
use crate::dto::ws::{BulkDeletedPayload, NotificationPayload, NotificationType, ServerWsMessage};
use crate::errors::AppError;
use crate::metrics::Metrics;
use crate::models::{GroupRole, Message, MessageType};
use crate::schema::{attachments, group_membership, groups, messages, messages::dsl};
use crate::services::api::{groups::load_requester_group_role, members::check_membership};
use crate::services::authentication::Principal;
use crate::services::authz::{Action as AuthzAction, AuthorizationService};
use crate::services::avatars::AvatarService;
use crate::services::forwarding::prepare_forward_message;
use crate::services::link_previews::{LinkPreviewJob, LinkPreviewService};
use crate::services::media::MediaStore;
use crate::services::message_search::pagination::{
    CandidatePageRequest, CursorContext, SearchContinuation, SearchPosition, MAX_CANDIDATE_BATCHES,
    RELEVANCE_RESULT_WINDOW,
};
use crate::services::message_search::{
    filter_authoritative_hits, validate_search_query, MessageSearchFilters, MessageSearchMetrics,
    MessageSearchRange, MessageSearchService, MessageSearchSort, SearchCandidateDropCounts,
};
use crate::services::messages::{
    attach_metadata, attachment_position, authorize_message_send, load_username_by_uid,
    parse_attachment_ids, send_prepared_message, sync_edited_message_mentions, validate_message,
    PreparedMessageSend, SendMessageOutcome, SendPreparedMessageDeps,
};
use crate::services::push::PushService;
use crate::services::single_forwarding::{prepare_single_forward, PreparedSingleForward};
use crate::services::social;
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::ids::IdGen;
use crate::utils::pagination::validate_limit;
use crate::utils::transaction::AsyncTransaction;
use crate::MAX_MESSAGES_LIMIT;

pub struct PostMessageDeps<'a> {
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub authz_service: &'a Arc<AuthorizationService>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub push_service: &'a Arc<PushService>,
    pub message_search: &'a Option<Arc<MessageSearchService>>,
    pub link_previews: &'a Arc<LinkPreviewService>,
}

pub struct ForwardMessagesDeps<'a> {
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub push_service: &'a Arc<PushService>,
}

pub struct ForwardMessageDeps<'a> {
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub push_service: &'a Arc<PushService>,
    pub message_search: &'a Option<Arc<MessageSearchService>>,
}

pub struct PostThreadMessageDeps<'a> {
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub push_service: &'a Arc<PushService>,
    pub message_search: &'a Option<Arc<MessageSearchService>>,
    pub link_previews: &'a Arc<LinkPreviewService>,
}

pub struct PatchMessageDeps<'a> {
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub message_search: &'a Option<Arc<MessageSearchService>>,
    pub link_previews: &'a Arc<LinkPreviewService>,
}

pub struct DeleteMessageDeps<'a> {
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub message_search: &'a Option<Arc<MessageSearchService>>,
}

pub struct BulkDeleteMessagesDeps<'a> {
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub message_search: &'a Option<Arc<MessageSearchService>>,
}
pub struct SearchMessagesDeps<'a> {
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub message_search: &'a Option<Arc<MessageSearchService>>,
}

const DEFAULT_SEARCH_LIMIT: i64 = 20;

fn search_limit(limit: Option<i64>) -> usize {
    validate_limit(
        Some(limit.unwrap_or(DEFAULT_SEARCH_LIMIT)),
        MAX_MESSAGES_LIMIT,
    ) as usize
}

pub async fn get_messages(
    uid: i32,
    chat_id: i64,
    q: ListMessagesQuery,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<ListMessagesResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    let max = validate_limit(q.max, MAX_MESSAGES_LIMIT);

    let q_thread_id = q.thread_id;
    macro_rules! raw_query {
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

    let (chat_settings, kind, membership_message_policy) =
        crate::services::user::load_chat_settings_for_chat(conn, uid, chat_id)?;
    let filtering = !membership_message_policy.can_view
        || crate::services::system_messages::hides_membership_messages(
            chat_settings.show_membership_messages,
            kind,
            q_thread_id,
        );
    macro_rules! base_query {
        () => {{
            let mut query = raw_query!();
            if filtering {
                query = query.filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
                    crate::services::system_messages::NON_MEMBERSHIP_PREDICATE,
                ));
            }
            query
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

        let older_cursor = has_older
            .then(|| older_to_use.last().map(|m| m.id))
            .flatten();
        let newer_cursor = has_newer
            .then(|| newer_to_use.last().map(|m| m.id))
            .flatten();

        // Combine: older reversed (oldest first) + newer (target first, ascending)
        let mut combined: Vec<Message> = older_to_use.into_iter().rev().collect();
        combined.extend(newer_to_use);
        // Preserve an explicitly requested hidden target for exact-link validation.
        // It remains hidden by the client, which positions its visible neighbour.
        if filtering && membership_message_policy.can_view {
            if let Some(target_message) = raw_query!()
                .filter(dsl::id.eq(target))
                .select(Message::as_select())
                .first::<Message>(conn)
                .optional()?
            {
                if target_message
                    .system_kind
                    .is_some_and(|kind| kind.is_membership())
                {
                    combined.push(target_message);
                    combined.sort_by_key(|message| message.id);
                }
            }
        }
        let messages_vec = attach_metadata(conn, combined, media, avatars, uid).await;

        return Ok(ListMessagesResponse {
            membership_message_policy,
            chat_settings,
            messages: messages_vec,
            next_cursor: older_cursor,
            prev_cursor: newer_cursor,
            older_cursor,
            newer_cursor,
        });
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
        let newer_cursor = has_more
            .then(|| messages_to_process.last().map(|m| m.id))
            .flatten();
        let messages_vec = attach_metadata(conn, messages_to_process, media, avatars, uid).await;

        return Ok(ListMessagesResponse {
            membership_message_policy,
            chat_settings,
            messages: messages_vec,
            next_cursor: None,
            prev_cursor: newer_cursor,
            older_cursor: None,
            newer_cursor,
        });
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
    let older_cursor = has_more
        .then(|| messages_to_process.last().map(|m| m.id))
        .flatten();

    // Reverse to return ASC (oldest first)
    let messages_to_process: Vec<Message> = messages_to_process.into_iter().rev().collect();
    let messages_vec = attach_metadata(conn, messages_to_process, media, avatars, uid).await;

    Ok(ListMessagesResponse {
        membership_message_policy,
        chat_settings,
        messages: messages_vec,
        next_cursor: older_cursor,
        prev_cursor: None,
        older_cursor,
        newer_cursor: None,
    })
}
pub async fn search_messages(
    uid: i32,
    chat_id: i64,
    params: crate::dto::messages::ChatSearchMessagesQuery,
    conn: &mut PgConnection,
    deps: SearchMessagesDeps<'_>,
) -> Result<SearchMessagesResponse, AppError> {
    let filters = MessageSearchFilters {
        created_from: params.created_from,
        created_before: params.created_before,
        range: params.search_range()?,
        sender_uid: params.sender_uid,
    };
    search_messages_with_range(uid, Some(chat_id), params.into_query(), filters, conn, deps).await
}

pub async fn search_messages_in_scope(
    uid: i32,
    chat_id: Option<i64>,
    params: SearchMessagesQuery,
    conn: &mut PgConnection,
    deps: SearchMessagesDeps<'_>,
) -> Result<SearchMessagesResponse, AppError> {
    let filters = MessageSearchFilters {
        range: MessageSearchRange::All,
        sender_uid: params.sender_uid,
        created_from: params.created_from,
        created_before: params.created_before,
    };
    search_messages_with_range(uid, chat_id, params, filters, conn, deps).await
}

async fn search_messages_with_range(
    uid: i32,
    chat_id: Option<i64>,
    params: SearchMessagesQuery,
    filters: MessageSearchFilters,
    conn: &mut PgConnection,
    deps: SearchMessagesDeps<'_>,
) -> Result<SearchMessagesResponse, AppError> {
    let started_at = Instant::now();
    let sort = resolve_search_sort(&params);
    let metrics = &deps.metrics.message_search;
    let result = search_messages_page(uid, chat_id, params, filters, conn, &deps).await;
    if let Ok(page) = &result {
        metrics.observe_results(sort.as_str(), page.messages.len());
    }
    record_search_query_metrics(
        metrics,
        sort.as_str(),
        if result.is_ok() { "success" } else { "failure" },
        started_at,
    );
    result
}

async fn search_messages_page(
    uid: i32,
    chat_id: Option<i64>,
    params: SearchMessagesQuery,
    filters: MessageSearchFilters,
    conn: &mut PgConnection,
    deps: &SearchMessagesDeps<'_>,
) -> Result<SearchMessagesResponse, AppError> {
    let participant_uid = match filters.range {
        MessageSearchRange::Threads(uid) => Some(uid),
        _ => None,
    };
    let (query, sort) = prepare_search(&params, filters.sender_uid.or(participant_uid))?;
    if chat_id.is_none() && query.is_none() {
        return Err(AppError::BadRequest("Cross-chat search requires a query"));
    }
    let context = CursorContext::new(uid, chat_id, query.as_deref(), filters, sort);
    let continuation = context.decode(params.cursor.as_deref(), sort)?;
    let limit = search_limit(params.limit);
    let before = match continuation {
        Some(SearchContinuation::Newest(p)) => Some(p),
        _ => None,
    };

    if let Some(chat_id) = chat_id {
        check_membership(conn, chat_id, uid)?;
    }
    if let (Some(chat_id), MessageSearchRange::Thread(id)) = (chat_id, filters.range) {
        let valid = diesel::select(diesel::dsl::exists(
            messages::table
                .filter(dsl::id.eq(id))
                .filter(dsl::chat_id.eq(chat_id))
                .filter(dsl::reply_root_id.is_null())
                .filter(dsl::has_thread.eq(true))
                .filter(dsl::is_published.eq(true)),
        ))
        .get_result::<bool>(conn)?;
        if !valid {
            return Err(AppError::NotFound("Thread not found"));
        }
    }
    if let (Some(chat_id), Some(sender_uid)) = (chat_id, filters.sender_uid.or(participant_uid)) {
        validate_search_sender(conn, chat_id, filters.range, sender_uid)?;
    }

    let Some(query) = query else {
        let mixed = filters.range == MessageSearchRange::All && filters.sender_uid.is_some();
        let mut rows = if let Some(participant_uid) = participant_uid {
            crate::services::message_search::load_participant_threads(
                conn,
                uid,
                chat_id.ok_or(AppError::BadRequest("A chat is required for thread search"))?,
                participant_uid,
                filters,
                limit as i64,
                before,
            )?
        } else if mixed {
            crate::services::message_search::load_sender_history(
                conn,
                uid,
                chat_id.ok_or(AppError::BadRequest(
                    "A chat is required for sender history",
                ))?,
                filters.sender_uid.unwrap(),
                filters,
                limit as i64,
                before,
            )?
        } else {
            let scope =
                crate::services::message_search::HistorySearchScope::new(chat_id, filters.range)?;
            crate::services::message_search::load_filtered_messages(
                conn,
                uid,
                scope,
                filters,
                limit as i64,
                before,
            )?
        };
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = rows.last().filter(|_| has_more).map(|m| {
            context.encode(SearchContinuation::Newest(SearchPosition {
                created_at: m.created_at,
                id: m.id,
            }))
        });
        let thread_ids: std::collections::HashSet<_> = rows
            .iter()
            .filter(|m| (mixed || participant_uid.is_some()) && m.has_thread)
            .map(|m| m.id)
            .collect();
        let messages = attach_metadata(conn, rows, deps.media, deps.avatars, uid)
            .await
            .into_iter()
            .map(|message| {
                let kind = if thread_ids.contains(&message.id) {
                    crate::dto::messages::SearchResultKind::Thread
                } else {
                    crate::dto::messages::SearchResultKind::Message
                };
                crate::dto::messages::SearchMessageResult { kind, message }
            })
            .collect();
        return Ok(SearchMessagesResponse {
            messages,
            next_cursor,
            truncated: false,
        });
    };

    let chat_ids = match chat_id {
        Some(id) => vec![id],
        None => crate::services::chat_access::list_accessible_chat_ids(conn, uid)?,
    };
    if chat_ids.is_empty() {
        return Ok(SearchMessagesResponse {
            messages: vec![],
            next_cursor: None,
            truncated: false,
        });
    }
    let search_service = deps
        .message_search
        .as_ref()
        .ok_or(AppError::ServiceUnavailable("Message search unavailable"))?;
    let page = load_keyword_messages(
        conn,
        uid,
        &chat_ids,
        KeywordSearch {
            query: &query,
            filters,
            sort,
            limit,
            continuation,
        },
        search_service,
        &deps.metrics.message_search,
    )
    .await?;
    let next_cursor = page.continuation.map(|c| context.encode(c));
    let messages = attach_metadata(conn, page.messages, deps.media, deps.avatars, uid)
        .await
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(SearchMessagesResponse {
        messages,
        next_cursor,
        truncated: page.truncated,
    })
}

struct KeywordSearch<'a> {
    query: &'a str,
    filters: MessageSearchFilters,
    sort: MessageSearchSort,
    limit: usize,
    continuation: Option<SearchContinuation>,
}

struct SearchRowsPage {
    messages: Vec<Message>,
    continuation: Option<SearchContinuation>,
    truncated: bool,
}

async fn load_keyword_messages(
    conn: &mut PgConnection,
    uid: i32,
    chat_ids: &[i64],
    request: KeywordSearch<'_>,
    search_service: &MessageSearchService,
    metrics: &MessageSearchMetrics,
) -> Result<SearchRowsPage, AppError> {
    let KeywordSearch {
        query,
        filters,
        sort,
        limit,
        continuation,
    } = request;
    let mut before = match continuation {
        Some(SearchContinuation::Newest(p)) => Some(p),
        _ => None,
    };
    let mut offset = match continuation {
        Some(SearchContinuation::Relevance(n)) => n,
        _ => 0,
    };
    let mut rows = Vec::with_capacity(limit);
    let mut has_more = true;
    let mut candidates_seen = 0;
    // Bound work even when many indexed hits are deleted, stale or no longer accessible.
    for batch in 0..MAX_CANDIDATE_BATCHES {
        // Usually one page plus a lookahead is enough. Larger refill batches are
        // useful only after authoritative checks have dropped indexed candidates.
        let batch_limit = if batch == 0 {
            (limit + 1).min(MAX_MESSAGES_LIMIT as usize)
        } else {
            MAX_MESSAGES_LIMIT as usize
        };
        let batch_limit = if sort == MessageSearchSort::Relevance {
            batch_limit.min(RELEVANCE_RESULT_WINDOW - offset)
        } else {
            batch_limit
        };
        let page = search_service
            .search_candidates(
                query,
                chat_ids,
                filters,
                sort,
                CandidatePageRequest {
                    limit: batch_limit,
                    offset,
                    before,
                },
            )
            .await
            .map_err(|err| {
                tracing::warn!(
                    chat_count = chat_ids.len(),
                    sort = sort.as_str(),
                    ?err,
                    "message search query failed"
                );
                AppError::ServiceUnavailable("Message search unavailable")
            })?;
        candidates_seen += page.candidates.len();
        let candidate_ids = page
            .candidates
            .iter()
            .map(|c| c.message_id)
            .collect::<Vec<_>>();
        let candidates = messages::table
            .filter(dsl::id.eq_any(candidate_ids))
            .select(Message::as_select())
            .load::<Message>(conn)?;
        let hits = filter_authoritative_hits(
            &crate::services::chat_access::filter_accessible_chat_ids(conn, uid, chat_ids)?,
            filters,
            &page.candidates,
            candidates,
        );
        record_search_candidate_drops(metrics, hits.drops);
        let mut accepted = hits
            .messages
            .into_iter()
            .map(|m| (m.id, m))
            .collect::<std::collections::HashMap<_, _>>();
        has_more = page.has_more;
        for (index, candidate) in page.candidates.iter().enumerate() {
            if sort == MessageSearchSort::Newest {
                before = candidate.position;
            } else {
                offset += 1;
            }
            if let Some(message) = accepted.remove(&candidate.message_id) {
                rows.push(message);
            }
            if rows.len() == limit {
                has_more = index + 1 < page.candidates.len() || page.has_more;
                break;
            }
        }
        if rows.len() == limit
            || !has_more
            || (sort == MessageSearchSort::Relevance && offset >= RELEVANCE_RESULT_WINDOW)
        {
            break;
        }
    }
    metrics.observe_candidates(sort.as_str(), candidates_seen);
    let truncated =
        sort == MessageSearchSort::Relevance && offset >= RELEVANCE_RESULT_WINDOW && has_more;
    let continuation = if !has_more || truncated {
        None
    } else {
        match sort {
            MessageSearchSort::Newest => before.map(SearchContinuation::Newest),
            MessageSearchSort::Relevance => Some(SearchContinuation::Relevance(offset)),
        }
    };
    Ok(SearchRowsPage {
        messages: rows,
        continuation,
        truncated,
    })
}

fn resolve_search_sort(params: &SearchMessagesQuery) -> MessageSearchSort {
    params.sort.unwrap_or_else(|| {
        if params.q.as_deref().is_some_and(|q| !q.trim().is_empty()) {
            MessageSearchSort::Relevance
        } else {
            MessageSearchSort::Newest
        }
    })
}

fn prepare_search(
    params: &SearchMessagesQuery,
    sender_uid: Option<i32>,
) -> Result<(Option<String>, MessageSearchSort), AppError> {
    for date in [params.created_from, params.created_before]
        .into_iter()
        .flatten()
    {
        if date.timestamp_subsec_nanos() % 1_000_000 != 0 {
            return Err(AppError::BadRequest(
                "Date filters support millisecond precision",
            ));
        }
    }
    if matches!((params.created_from, params.created_before), (Some(from), Some(before)) if from >= before)
    {
        return Err(AppError::BadRequest(
            "createdFrom must be before createdBefore",
        ));
    }
    let sort = resolve_search_sort(params);
    let q = params.q.as_deref().map(str::trim).filter(|q| !q.is_empty());
    match q {
        Some(q) => {
            Ok((
                Some(validate_search_query(q).map_err(|_| {
                    AppError::BadRequest("Search query must be at least 2 characters")
                })?),
                sort,
            ))
        }
        None => {
            if sender_uid.is_none()
                && params.created_from.is_none()
                && params.created_before.is_none()
            {
                return Err(AppError::BadRequest(
                    "A date boundary or senderUid is required without a query",
                ));
            }
            if sort == MessageSearchSort::Relevance {
                return Err(AppError::BadRequest("relevance sorting requires a query"));
            }
            Ok((None, sort))
        }
    }
}

fn validate_search_sender(
    conn: &mut PgConnection,
    chat_id: i64,
    range: MessageSearchRange,
    sender_uid: i32,
) -> Result<(), AppError> {
    let kind = groups::table
        .find(chat_id)
        .select(groups::kind)
        .first::<crate::models::GroupKind>(conn)?;
    if kind != crate::models::GroupKind::Group {
        return Err(AppError::BadRequest(
            "Author filters are only supported in group chats",
        ));
    }
    let eligible = match range {
        MessageSearchRange::All | MessageSearchRange::Main | MessageSearchRange::Threads(_) => {
            let scope = match range {
                MessageSearchRange::Main => crate::dto::chats::ChatParticipantScope::Main,
                MessageSearchRange::Threads(_) => crate::dto::chats::ChatParticipantScope::Threads,
                _ => crate::dto::chats::ChatParticipantScope::All,
            };
            crate::services::participants::is_chat_participant(conn, chat_id, scope, sender_uid)?
        }
        MessageSearchRange::Thread(id) => {
            crate::services::threads::is_thread_participant(conn, id, sender_uid)?
        }
    };
    if !eligible {
        return Err(AppError::BadRequest(
            "The selected user must be a participant in the selected scope",
        ));
    }
    Ok(())
}

fn record_search_query_metrics(
    metrics: &MessageSearchMetrics,
    sort_label: &str,
    result: &str,
    started_at: Instant,
) {
    metrics.record_query(sort_label, result);
    metrics.record_query_duration(sort_label, result, started_at.elapsed().as_secs_f64());
}

fn record_search_candidate_drops(metrics: &MessageSearchMetrics, drops: SearchCandidateDropCounts) {
    metrics.record_candidate_drop("missing_db_row", drops.missing_db_row);
    metrics.record_candidate_drop("wrong_chat", drops.wrong_chat);
    metrics.record_candidate_drop("wrong_scope", drops.wrong_scope);
    metrics.record_candidate_drop("wrong_sender", drops.wrong_sender);
    metrics.record_candidate_drop("wrong_date", drops.wrong_date);
    metrics.record_candidate_drop("not_searchable", drops.not_searchable);
    metrics.record_candidate_drop("stale_version", drops.stale_version);
}
pub async fn get_message(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<MessageResponse, AppError> {
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

    if message.system_kind.is_some_and(|kind| kind.is_membership())
        && !crate::services::user::load_chat_settings_for_chat(conn, uid, chat_id)?
            .2
            .can_view
    {
        return Err(AppError::NotFound("Message not found"));
    }
    let messages_vec = attach_metadata(conn, vec![message], media, avatars, uid).await;
    let response = messages_vec.into_iter().next().unwrap();

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_query_dates_and_sort_are_validated() {
        let parse = |value| serde_json::from_value::<SearchMessagesQuery>(value).unwrap();
        let params = parse(serde_json::json!({"q":"  ","createdFrom":"2026-11-02T08:00:00+08:00"}));
        assert_eq!(
            prepare_search(&params, None).unwrap(),
            (None, MessageSearchSort::Newest)
        );
        assert_eq!(
            params.created_from.unwrap().to_rfc3339(),
            "2026-11-02T00:00:00+00:00"
        );
        let empty = parse(serde_json::json!({}));
        assert!(prepare_search(&empty, None).is_err());
        assert_eq!(
            prepare_search(&empty, Some(42)).unwrap(),
            (None, MessageSearchSort::Newest)
        );
        for value in [
            serde_json::json!({"q":"x"}),
            serde_json::json!({"createdFrom":"2026-11-02T00:00:00Z","sort":"relevance"}),
            serde_json::json!({"createdFrom":"2026-11-02T00:00:00Z","createdBefore":"2026-11-02T00:00:00Z"}),
            serde_json::json!({"createdBefore":"2026-11-02T00:00:00.000001Z"}),
        ] {
            assert!(prepare_search(&parse(value), None).is_err());
        }
        assert_eq!(
            prepare_search(&parse(serde_json::json!({"q":"你好"})), None)
                .unwrap()
                .1,
            MessageSearchSort::Relevance
        );
        assert!(serde_json::from_value::<SearchMessagesQuery>(
            serde_json::json!({"createdFrom":"2026-11-02"})
        )
        .is_err());
    }

    #[test]
    fn sender_eligibility_is_group_only_and_uses_participants_not_subscribers() {
        use diesel::connection::SimpleConnection;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id,name) VALUES (9876995000,'sender-group');
                 INSERT INTO groups(id,name,kind,dm_uid1,dm_uid2) VALUES (9876995001,'sender-dm','dm',501,502);
                 INSERT INTO group_membership(chat_id,uid) VALUES (9876995000,501),(9876995000,502),(9876995001,501);
                 INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,has_thread,deleted_at)
                 VALUES (9876995010,9876995000,503,'text','sender-root-test',NOW(),TRUE,NOW());
                 INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id)
                 VALUES (9876995011,9876995000,501,'text','sender-reply-test',NOW(),9876995010);
                 INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed,archived)
                 VALUES (9876995000,9876995010,502,TRUE,TRUE);"
            )?;
            for range in [MessageSearchRange::All, MessageSearchRange::Threads(503)] {
                assert!(validate_search_sender(conn,9876995000,range,502).is_err()); // Subscription alone.
                assert!(validate_search_sender(conn,9876995000,range,503).is_ok()); // Departed root author.
                assert!(validate_search_sender(conn,9876995001,range,501).is_err()); // DM.
            }
            assert!(validate_search_sender(conn,9876995000,MessageSearchRange::Main,501).is_err());
            assert!(validate_search_sender(conn,9876995000,MessageSearchRange::Main,503).is_err());
            conn.batch_execute("INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at) VALUES (9876995012,9876995000,504,'text','departed-main-author',NOW())")?;
            for range in [MessageSearchRange::All, MessageSearchRange::Main] {
                assert!(validate_search_sender(conn,9876995000,range,504).is_ok());
            }
            let range = MessageSearchRange::Thread(9876995010);
            assert!(validate_search_sender(conn,9876995000,range,501).is_ok());
            assert!(validate_search_sender(conn,9876995000,range,503).is_ok());
            assert!(validate_search_sender(conn,9876995000,range,502).is_err());
            assert!(validate_search_sender(conn,9876995001,range,501).is_err());
            conn.batch_execute("UPDATE messages SET deleted_at=NOW() WHERE id=9876995011")?;
            assert!(validate_search_sender(conn,9876995000,range,501).is_err());
            Ok(())
        });
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

pub fn get_forwarded_messages(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<crate::dto::messages::ForwardedMessagesResponse, AppError> {
    use crate::services::messages::{
        deserialize_forwarded_bundle_payload, forwarded_messages_response_from_items,
        load_chat_forwarded_bundle_id, load_forwarded_bundle,
    };
    let bundle_id = load_chat_forwarded_bundle_id(conn, chat_id, message_id, uid)?;
    let bundle = load_forwarded_bundle(conn, bundle_id)?;
    let (total, items) = deserialize_forwarded_bundle_payload(bundle)?;
    Ok(forwarded_messages_response_from_items(
        conn, media, avatars, uid, total, items,
    ))
}

pub fn get_forwarded_bundle_messages(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    bundle_id: i64,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<crate::dto::messages::ForwardedMessagesResponse, AppError> {
    use crate::services::messages::{
        deserialize_forwarded_bundle_payload, forwarded_messages_response_from_items,
        load_chat_forwarded_bundle_id, load_target_forwarded_bundle_from_root,
    };
    let root_bundle_id = load_chat_forwarded_bundle_id(conn, chat_id, message_id, uid)?;
    let bundle = load_target_forwarded_bundle_from_root(conn, root_bundle_id, bundle_id)?;
    let (total, items) = deserialize_forwarded_bundle_payload(bundle)?;
    Ok(forwarded_messages_response_from_items(
        conn, media, avatars, uid, total, items,
    ))
}

const SYSTEM_MESSAGE_TYPE_FORBIDDEN: &str = "System messages cannot be sent by clients";
const INVITE_MESSAGE_TYPE_FORBIDDEN: &str = "Invite messages must be sent through invite APIs";
const FORWARDED_MESSAGE_TYPE_FORBIDDEN: &str =
    "Forwarded messages must be sent through forward APIs";
const PLACEHOLDER_MESSAGE_TYPE_FORBIDDEN: &str =
    "Placeholder messages must be created through forward APIs";

fn validate_client_message_type(message_type: &MessageType) -> Result<(), AppError> {
    match message_type {
        MessageType::System => Err(AppError::BadRequest(SYSTEM_MESSAGE_TYPE_FORBIDDEN)),
        MessageType::Invite => Err(AppError::BadRequest(INVITE_MESSAGE_TYPE_FORBIDDEN)),
        MessageType::Forwarded => Err(AppError::BadRequest(FORWARDED_MESSAGE_TYPE_FORBIDDEN)),
        MessageType::Placeholder => Err(AppError::BadRequest(PLACEHOLDER_MESSAGE_TYPE_FORBIDDEN)),
        _ => Ok(()),
    }
}

pub async fn post_message(
    principal: Principal,
    chat_id: i64,
    body: CreateMessageBody,
    conn: &mut PgConnection,
    deps: PostMessageDeps<'_>,
) -> Result<MessageResponse, AppError> {
    let uid = principal.require_user_action(
        conn,
        deps.authz_service,
        AuthzAction::OnBehalfOfMessageSend,
    )?;
    validate_client_message_type(&body.message_type)?;
    let attachment_ids = parse_attachment_ids(&body.attachment_ids)?;
    let publish_immediately = !matches!(body.message_type, MessageType::Audio);
    let previews = crate::services::link_previews::prepare(
        matches!(
            body.message_type,
            MessageType::Text | MessageType::Audio | MessageType::File
        )
        .then_some(body.message.as_deref())
        .flatten(),
        body.metadata.as_ref(),
        Utc::now(),
    )?;
    let (send_result, receipt_advanced) = {
        let mut transaction = AsyncTransaction::begin(conn)?;
        let conn = transaction.connection();
        let result = async {
            let target = authorize_message_send(conn, chat_id, None, uid)?;
            let send_result = send_prepared_message(
                conn,
                SendPreparedMessageDeps {
                    id_gen: deps.id_gen,
                    media: deps.media,
                    avatars: deps.avatars,
                    metrics: deps.metrics,
                },
                PreparedMessageSend {
                    metadata: previews.metadata,
                    system_kind: None,
                    forwarded_from_message_id: None,
                    chat_id,
                    chat_kind: target.kind,
                    sender_uid: uid,
                    message: body.message,
                    message_type: body.message_type,
                    sticker_id: body.sticker_id,
                    reply_to_id: body.reply_to_id,
                    reply_root_id: None,
                    client_generated_id: body.client_generated_id,
                    attachment_ids,
                    publish_immediately,
                    forwarded_bundle_id: None,
                    forwarded_preview_total: None,
                    forwarded_preview_contains_forwarded_messages: None,
                    forwarded_preview_items: None,
                },
            )
            .await?;
            let receipt_advanced = if let SendMessageOutcome::Created(send_result) = &send_result {
                crate::services::chat::mark_chat_as_read(
                    conn,
                    chat_id,
                    uid,
                    send_result.response.id,
                )?;
                crate::services::read_receipts::advance_chat_read_receipt(
                    conn,
                    chat_id,
                    uid,
                    send_result.response.id,
                )?
            } else {
                false
            };
            Ok((send_result, receipt_advanced))
        }
        .await;
        transaction.finish(result)?
    };

    deps.ws_registry.invalidate_unread(&[uid]);
    let response = match send_result {
        SendMessageOutcome::Created(send_result) => {
            let send_result = *send_result;
            send_result
                .side_effects
                .fire(deps.ws_registry, deps.push_service);
            if !previews.work.is_empty() {
                deps.link_previews.enqueue(LinkPreviewJob::new(
                    &send_result.inserted_message,
                    previews.expires_at,
                    previews.work,
                ));
            }
            if let Some(search_service) = deps.message_search {
                search_service.upsert_message_best_effort(send_result.inserted_message);
            }
            if matches!(send_result.response.message_type, MessageType::Audio) {
                crate::services::audio_transcode::enqueue_message(send_result.response.id);
            }
            send_result.response
        }
        SendMessageOutcome::Duplicate(response) => *response,
    };

    if receipt_advanced {
        crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
            conn,
            deps.ws_registry,
            chat_id,
            false,
            Some(uid),
            None,
        )?;
    }
    Ok(response)
}

pub async fn forward_messages(
    uid: i32,
    dest_chat_id: i64,
    body: ForwardMessagesBody,
    conn: &mut PgConnection,
    deps: ForwardMessagesDeps<'_>,
) -> Result<MessageResponse, AppError> {
    let (send_result, receipt_advanced, subscription_changes) = {
        let mut transaction = AsyncTransaction::begin(conn)?;
        let conn = transaction.connection();
        let result = async {
            let target = authorize_message_send(conn, dest_chat_id, body.thread_id, uid)?;
            let prepared = prepare_forward_message(
                conn,
                deps.id_gen.as_ref(),
                uid,
                dest_chat_id,
                target.kind,
                &body,
            )
            .await?;
            let send_result = send_prepared_message(
                conn,
                SendPreparedMessageDeps {
                    id_gen: deps.id_gen,
                    media: deps.media,
                    avatars: deps.avatars,
                    metrics: deps.metrics,
                },
                prepared,
            )
            .await?;
            let SendMessageOutcome::Created(created) = &send_result else {
                return Ok((send_result, false, Vec::new()));
            };
            let (receipt_advanced, subscription_changes) = if let Some(root) = &target.thread_root {
                let thread_state = crate::services::threads::record_thread_send(
                    conn,
                    &created.response,
                    &created.member_uids,
                    root,
                    true,
                    false,
                )?;
                (
                    thread_state.receipt_advanced,
                    thread_state.subscription_changes,
                )
            } else {
                crate::services::chat::mark_chat_as_read(
                    conn,
                    dest_chat_id,
                    uid,
                    created.response.id,
                )?;
                (
                    crate::services::read_receipts::advance_chat_read_receipt(
                        conn,
                        dest_chat_id,
                        uid,
                        created.response.id,
                    )?,
                    Vec::new(),
                )
            };
            Ok((send_result, receipt_advanced, subscription_changes))
        }
        .await;
        transaction.finish(result)?
    };

    let created = match send_result {
        SendMessageOutcome::Created(created) => *created,
        SendMessageOutcome::Duplicate(response) => return Ok(*response),
    };
    created
        .side_effects
        .fire(deps.ws_registry, deps.push_service);
    if receipt_advanced {
        crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
            conn,
            deps.ws_registry,
            dest_chat_id,
            false,
            Some(uid),
            body.thread_id,
        )?;
    }
    if let Some(thread_id) = body.thread_id {
        for changed_uid in subscription_changes {
            crate::services::threads::broadcast_thread_membership_changed_to_user(
                conn,
                deps.ws_registry,
                changed_uid,
                dest_chat_id,
                thread_id,
            )?;
        }
        broadcast_thread_send_updates(
            conn,
            ThreadSendUpdateDeps {
                media: deps.media,
                avatars: deps.avatars,
                ws_registry: deps.ws_registry,
            },
            dest_chat_id,
            thread_id,
            &created.member_uids,
            uid,
        )
        .await;
    }
    Ok(created.response)
}

pub async fn forward_message(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    body: ForwardMessageBody,
    conn: &mut PgConnection,
    deps: ForwardMessageDeps<'_>,
) -> Result<MessageResponse, AppError> {
    let (send_result, receipt_advanced, subscription_changes) = {
        let mut transaction = AsyncTransaction::begin(conn)?;
        let conn = transaction.connection();
        let result = async {
            let target = authorize_message_send(conn, chat_id, body.thread_id, uid)?;
            let prepared = prepare_single_forward(
                conn,
                deps.id_gen.as_ref(),
                uid,
                chat_id,
                target.kind,
                message_id,
                &body,
            )
            .await?;
            let send_result = match prepared {
                PreparedSingleForward::Existing(existing) => {
                    let response =
                        attach_metadata(conn, vec![*existing], deps.media, deps.avatars, uid)
                            .await
                            .into_iter()
                            .next()
                            .ok_or(AppError::Internal("Failed to build message response"))?;
                    return Ok((
                        SendMessageOutcome::Duplicate(Box::new(response)),
                        false,
                        Vec::new(),
                    ));
                }
                PreparedSingleForward::New(prepared) => {
                    send_prepared_message(
                        conn,
                        SendPreparedMessageDeps {
                            id_gen: deps.id_gen,
                            media: deps.media,
                            avatars: deps.avatars,
                            metrics: deps.metrics,
                        },
                        *prepared,
                    )
                    .await?
                }
            };
            let SendMessageOutcome::Created(created) = &send_result else {
                return Ok((send_result, false, Vec::new()));
            };
            let (receipt_advanced, subscription_changes) = if let Some(root) = &target.thread_root {
                let thread_state = crate::services::threads::record_thread_send(
                    conn,
                    &created.response,
                    &created.member_uids,
                    root,
                    true,
                    false,
                )?;
                (
                    thread_state.receipt_advanced,
                    thread_state.subscription_changes,
                )
            } else {
                crate::services::chat::mark_chat_as_read(conn, chat_id, uid, created.response.id)?;
                (
                    crate::services::read_receipts::advance_chat_read_receipt(
                        conn,
                        chat_id,
                        uid,
                        created.response.id,
                    )?,
                    Vec::new(),
                )
            };
            Ok((send_result, receipt_advanced, subscription_changes))
        }
        .await;
        transaction.finish(result)?
    };
    let created = match send_result {
        SendMessageOutcome::Created(created) => *created,
        SendMessageOutcome::Duplicate(response) => return Ok(*response),
    };
    created
        .side_effects
        .fire(deps.ws_registry, deps.push_service);
    if let Some(search) = deps.message_search {
        search.upsert_message_best_effort(created.inserted_message);
    }
    if receipt_advanced {
        crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
            conn,
            deps.ws_registry,
            chat_id,
            false,
            Some(uid),
            body.thread_id,
        )?;
    }
    if let Some(thread_id) = body.thread_id {
        for changed_uid in subscription_changes {
            crate::services::threads::broadcast_thread_membership_changed_to_user(
                conn,
                deps.ws_registry,
                changed_uid,
                chat_id,
                thread_id,
            )?;
        }
        broadcast_thread_send_updates(
            conn,
            ThreadSendUpdateDeps {
                media: deps.media,
                avatars: deps.avatars,
                ws_registry: deps.ws_registry,
            },
            chat_id,
            thread_id,
            &created.member_uids,
            uid,
        )
        .await;
    }
    Ok(created.response)
}

pub async fn post_thread_message(
    uid: i32,
    chat_id: i64,
    thread_id: i64,
    body: CreateMessageBody,
    conn: &mut PgConnection,
    deps: PostThreadMessageDeps<'_>,
) -> Result<MessageResponse, AppError> {
    validate_client_message_type(&body.message_type)?;
    let attachment_ids = parse_attachment_ids(&body.attachment_ids)?;
    let publish_immediately = !matches!(body.message_type, MessageType::Audio);
    let previews = crate::services::link_previews::prepare(
        matches!(
            body.message_type,
            MessageType::Text | MessageType::Audio | MessageType::File
        )
        .then_some(body.message.as_deref())
        .flatten(),
        body.metadata.as_ref(),
        Utc::now(),
    )?;
    let (send_result, receipt_advanced, subscription_changes) = {
        let mut transaction = AsyncTransaction::begin(conn)?;
        let conn = transaction.connection();
        let result = async {
            let target = authorize_message_send(conn, chat_id, Some(thread_id), uid)?;
            let root_msg = target.thread_root.ok_or(AppError::Internal(
                "Thread authorization did not return a thread root",
            ))?;
            let send_result = send_prepared_message(
                conn,
                SendPreparedMessageDeps {
                    id_gen: deps.id_gen,
                    media: deps.media,
                    avatars: deps.avatars,
                    metrics: deps.metrics,
                },
                PreparedMessageSend {
                    metadata: previews.metadata,
                    system_kind: None,
                    forwarded_from_message_id: None,
                    chat_id,
                    chat_kind: target.kind,
                    sender_uid: uid,
                    message: body.message,
                    message_type: body.message_type,
                    sticker_id: body.sticker_id,
                    reply_to_id: body.reply_to_id,
                    reply_root_id: Some(thread_id),
                    client_generated_id: body.client_generated_id,
                    attachment_ids,
                    publish_immediately,
                    forwarded_bundle_id: None,
                    forwarded_preview_total: None,
                    forwarded_preview_contains_forwarded_messages: None,
                    forwarded_preview_items: None,
                },
            )
            .await?;
            let send_result = match send_result {
                SendMessageOutcome::Created(send_result) => *send_result,
                SendMessageOutcome::Duplicate(response) => {
                    return Ok((SendMessageOutcome::Duplicate(response), false, Vec::new()));
                }
            };
            let thread_state = crate::services::threads::record_thread_send(
                conn,
                &send_result.response,
                &send_result.member_uids,
                &root_msg,
                publish_immediately,
                true,
            )?;
            Ok((
                SendMessageOutcome::Created(Box::new(send_result)),
                thread_state.receipt_advanced,
                thread_state.subscription_changes,
            ))
        }
        .await;
        transaction.finish(result)?
    };

    let send_result = match send_result {
        SendMessageOutcome::Created(send_result) => *send_result,
        SendMessageOutcome::Duplicate(response) => return Ok(*response),
    };
    let response = send_result.response;
    let member_uids = send_result.member_uids;
    let msg_side_effects = send_result.side_effects;
    deps.ws_registry.invalidate_unread(&[uid]);
    msg_side_effects.fire(deps.ws_registry, deps.push_service);
    if !previews.work.is_empty() {
        deps.link_previews.enqueue(LinkPreviewJob::new(
            &send_result.inserted_message,
            previews.expires_at,
            previews.work,
        ));
    }
    if let Some(search_service) = deps.message_search {
        search_service.upsert_response_best_effort(response.clone());
    }
    if matches!(response.message_type, MessageType::Audio) {
        crate::services::audio_transcode::enqueue_message(response.id);
    }
    if receipt_advanced {
        crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
            conn,
            deps.ws_registry,
            chat_id,
            false,
            Some(uid),
            Some(thread_id),
        )?;
    }
    for changed_uid in subscription_changes {
        crate::services::threads::broadcast_thread_membership_changed_to_user(
            conn,
            deps.ws_registry,
            changed_uid,
            chat_id,
            thread_id,
        )?;
    }
    if publish_immediately {
        broadcast_thread_send_updates(
            conn,
            ThreadSendUpdateDeps {
                media: deps.media,
                avatars: deps.avatars,
                ws_registry: deps.ws_registry,
            },
            chat_id,
            thread_id,
            &member_uids,
            uid,
        )
        .await;
    }
    Ok(response)
}

struct ThreadSendUpdateDeps<'a> {
    media: &'a MediaStore,
    avatars: &'a Arc<AvatarService>,
    ws_registry: &'a Arc<ConnectionRegistry>,
}

async fn broadcast_thread_send_updates(
    conn: &mut PgConnection,
    deps: ThreadSendUpdateDeps<'_>,
    chat_id: i64,
    thread_id: i64,
    member_uids: &[i32],
    uid: i32,
) {
    let root = messages::table
        .filter(dsl::id.eq(thread_id).and(dsl::chat_id.eq(chat_id)))
        .select(Message::as_select())
        .first::<Message>(conn)
        .ok();
    if let Some(root) = root {
        if let Some(root_response) =
            attach_metadata(conn, vec![root], deps.media, deps.avatars, uid)
                .await
                .into_iter()
                .next()
        {
            deps.ws_registry.broadcast_to_uids(
                member_uids,
                Arc::new(ServerWsMessage::MessageUpdated(root_response)),
            );
        }
    }
    if let Err(error) = crate::services::threads::broadcast_thread_update_to_subscribers(
        conn,
        deps.ws_registry,
        chat_id,
        thread_id,
    ) {
        tracing::warn!(
            chat_id,
            thread_id,
            ?error,
            "failed to broadcast thread update after message send"
        );
    }
}

pub async fn patch_message(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    body: UpdateMessageBody,
    conn: &mut PgConnection,
    deps: PatchMessageDeps<'_>,
) -> Result<MessageResponse, AppError> {
    check_membership(conn, chat_id, uid)?;
    social::require_chat_writable(conn, chat_id, uid)?;
    let attachment_ids = parse_attachment_ids(&body.attachment_ids)?;
    let (updated_message, added_mention_uids, previews) =
        conn.transaction::<_, AppError, _>(|conn| {
            use crate::schema::attachments::dsl as a_dsl;
            use crate::services::speaking;
            speaking::lock_chat(conn, chat_id, false)?;
            let message: Message = messages::table
                .filter(dsl::id.eq(message_id).and(dsl::chat_id.eq(chat_id)))
                .for_update()
                .select(Message::as_select())
                .first(conn)
                .optional()?
                .ok_or(AppError::NotFound("Message not found"))?;
            let now = crate::services::link_previews::finalize::next_edit_timestamp(
                Utc::now(),
                message.updated_at,
            );
            if message.system_kind.is_some_and(|kind| kind.is_membership())
                && !crate::services::user::load_chat_settings_for_chat(conn, uid, chat_id)?
                    .2
                    .can_view
            {
                return Err(AppError::NotFound("Message not found"));
            }
            if message.sender_uid != uid {
                return Err(AppError::Forbidden("You can only edit your own messages"));
            }
            if message.deleted_at.is_some() {
                return Err(AppError::BadRequest("Cannot edit deleted message"));
            }
            if !message.is_published {
                return Err(AppError::BadRequest("Cannot edit unpublished message"));
            }
            if message.forwarded_from_message_id.is_some()
                || message.message_type == MessageType::Placeholder
            {
                return Err(AppError::Forbidden("Forwarded messages cannot be edited"));
            }
            if !matches!(message.message_type, MessageType::Text) {
                return Err(AppError::BadRequest("This message type cannot be edited"));
            }
            speaking::require_edit(conn, &message, uid)?;
            let requested = attachments::table
                .filter(a_dsl::id.eq_any(&attachment_ids))
                .order(a_dsl::id.asc())
                .for_update()
                .select(crate::models::Attachment::as_select())
                .load::<crate::models::Attachment>(conn)?;
            if requested.len() != attachment_ids.len()
                || requested.iter().any(|attachment| {
                    attachment.deleted_at.is_some()
                        || (attachment.message_id != Some(message_id)
                            && (attachment.message_id.is_some()
                                || attachment.uploader_uid != Some(uid)))
                })
            {
                return Err(AppError::BadRequest("Invalid attachment selection"));
            }
            validate_message(
                &message.message_type,
                Some(&body.message),
                message.sticker_id,
                &requested,
            )?;
            diesel::update(attachments::table.filter(a_dsl::message_id.eq(message_id)))
                .set(a_dsl::message_id.eq::<Option<i64>>(None))
                .execute(conn)?;
            if !attachment_ids.is_empty() {
                let attached = diesel::update(
                    attachments::table
                        .filter(a_dsl::id.eq_any(&attachment_ids))
                        .filter(a_dsl::message_id.is_null()),
                )
                .set((
                    a_dsl::message_id.eq(message_id),
                    a_dsl::order.eq(attachment_position(&attachment_ids, a_dsl::id) - 1i16),
                ))
                .execute(conn)?;
                if attached != attachment_ids.len() {
                    return Err(AppError::BadRequest("Invalid attachment selection"));
                }
            }
            let previews = crate::services::link_previews::prepare_edit(
                &body.message,
                body.metadata.as_ref(),
                message.metadata.as_ref(),
                Utc::now(),
            )?;
            let updated_message: Message =
                diesel::update(messages::table.filter(dsl::id.eq(message_id)))
                    .set((
                        dsl::message.eq(&body.message),
                        dsl::has_attachments.eq(!attachment_ids.is_empty()),
                        dsl::updated_at.eq(Some(now)),
                        dsl::metadata.eq(&previews.metadata),
                    ))
                    .returning(Message::as_returning())
                    .get_result(conn)?;
            let added_mention_uids =
                sync_edited_message_mentions(conn, &message, &body.message, uid, now)?;
            Ok((updated_message, added_mention_uids, previews))
        })?;
    if let Some(search_service) = deps.message_search {
        search_service.upsert_message_best_effort(updated_message.clone());
    }
    let edited_thread_root_id = updated_message.reply_root_id;
    let preview_job = (!previews.work.is_empty())
        .then(|| LinkPreviewJob::new(&updated_message, previews.expires_at, previews.work));
    let response = attach_metadata(conn, vec![updated_message], deps.media, deps.avatars, uid)
        .await
        .into_iter()
        .next()
        .unwrap();
    let member_uids: Vec<i32> = {
        use crate::schema::group_membership as gm_dsl;
        group_membership::table
            .filter(gm_dsl::chat_id.eq(chat_id))
            .select(group_membership::uid)
            .load(conn)?
    };
    let ws_msg = Arc::new(ServerWsMessage::MessageUpdated(response.clone()));
    deps.ws_registry.broadcast_to_uids(&member_uids, ws_msg);
    if let Some(job) = preview_job {
        deps.link_previews.enqueue(job);
    }
    if let Some(root_id) = edited_thread_root_id {
        for mentioned_uid in &added_mention_uids {
            crate::services::threads::broadcast_thread_membership_changed_to_user(
                conn,
                deps.ws_registry,
                *mentioned_uid,
                chat_id,
                root_id,
            )?;
        }
    }
    if !added_mention_uids.is_empty() {
        let actor_name = load_username_by_uid(conn, uid)?.unwrap_or_else(|| "Someone".to_string());
        let payload = NotificationPayload {
            notification_type: NotificationType::Mention,
            chat_id,
            message_id,
            thread_root_id: edited_thread_root_id,
            actor_uid: uid,
            actor_name: Some(actor_name),
        };
        deps.ws_registry.broadcast_to_uids(
            &added_mention_uids,
            Arc::new(ServerWsMessage::Notification(payload)),
        );
    }
    Ok(response)
}

pub async fn delete_message(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    conn: &mut PgConnection,
    deps: DeleteMessageDeps<'_>,
) -> Result<(), AppError> {
    check_membership(conn, chat_id, uid)?;
    social::require_chat_writable(conn, chat_id, uid)?;
    let message: Message = messages::table
        .filter(dsl::id.eq(message_id).and(dsl::chat_id.eq(chat_id)))
        .select(Message::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;
    if message.system_kind.is_some_and(|kind| kind.is_membership())
        && !crate::services::user::load_chat_settings_for_chat(conn, uid, chat_id)?
            .2
            .can_view
    {
        return Err(AppError::NotFound("Message not found"));
    }
    if message.sender_uid != uid {
        let role = load_requester_group_role(conn, chat_id, uid)?;
        if role != Some(GroupRole::Admin) {
            return Err(AppError::Forbidden("You can only delete your own messages"));
        }
    }
    crate::services::message_deletion::validate_deletable_message_type(&message.message_type)?;
    if message.deleted_at.is_some() {
        return Err(AppError::Gone("Message already deleted"));
    }
    if !message.is_published {
        return Err(AppError::BadRequest("Cannot delete unpublished message"));
    }
    let now = Utc::now();
    let deleted_message: Message = conn.transaction::<_, diesel::result::Error, _>(|conn| {
        let deleted_message: Message =
            diesel::update(messages::table.filter(dsl::id.eq(message_id)))
                .set(dsl::deleted_at.eq(Some(now)))
                .returning(Message::as_returning())
                .get_result(conn)?;
        {
            use crate::schema::message_mentions::dsl as mm_dsl;
            diesel::delete(mm_dsl::message_mentions.filter(mm_dsl::message_id.eq(message_id)))
                .execute(conn)?;
        }
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
                crate::services::chat::recalculate_group_last_message(conn, chat_id)
                    .map_err(|_| diesel::result::Error::RollbackTransaction)?;
            }
        }
        if let Some(thread_root_id) = deleted_message.reply_root_id {
            crate::services::threads::shift_thread_read_pointers_on_delete(
                conn,
                thread_root_id,
                &[message_id],
            )?;
        } else if !deleted_message.has_thread {
            crate::services::chat::shift_chat_read_pointers_on_delete(
                conn,
                chat_id,
                &[message_id],
            )?;
        }
        Ok(deleted_message)
    })?;
    if let Some(search_service) = deps.message_search {
        search_service.delete_message_best_effort(message_id);
    }
    let response = attach_metadata(conn, vec![deleted_message], deps.media, deps.avatars, uid)
        .await
        .into_iter()
        .next()
        .unwrap();
    let member_uids: Vec<i32> = if message.system_kind.is_some_and(|kind| kind.is_membership()) {
        group_membership::table
            .inner_join(groups::table)
            .filter(groups::id.eq(chat_id))
            .filter(crate::services::system_messages::membership_allowed())
            .select(group_membership::uid)
            .load(conn)?
    } else {
        group_membership::table
            .filter(group_membership::chat_id.eq(chat_id))
            .select(group_membership::uid)
            .load(conn)?
    };
    deps.ws_registry.broadcast_to_uids(
        &member_uids,
        Arc::new(ServerWsMessage::MessageDeleted(response.clone())),
    );
    if let Some(reply_root_id) = response.reply_root_id {
        if let Err(err) = crate::services::threads::broadcast_thread_update_to_subscribers(
            conn,
            deps.ws_registry,
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
    if let Some(reply_root_id) = response.reply_root_id {
        let root_msg_updated: Option<Message> = messages::table
            .filter(dsl::id.eq(reply_root_id).and(dsl::chat_id.eq(chat_id)))
            .select(Message::as_select())
            .first(conn)
            .ok();
        if let Some(root_msg) = root_msg_updated {
            let root_response =
                attach_metadata(conn, vec![root_msg], deps.media, deps.avatars, uid)
                    .await
                    .into_iter()
                    .next();
            if let Some(root_response) = root_response {
                deps.ws_registry.broadcast_to_uids(
                    &member_uids,
                    Arc::new(ServerWsMessage::MessageUpdated(root_response)),
                );
            }
        }
    }
    Ok(())
}

pub async fn bulk_delete_messages(
    uid: i32,
    chat_id: i64,
    body: BulkDeleteMessagesBody,
    conn: &mut PgConnection,
    deps: BulkDeleteMessagesDeps<'_>,
) -> Result<BulkDeletedPayload, AppError> {
    use crate::services::message_deletion::{delete_selection, validate_message_ids};
    let ids = validate_message_ids(body.message_ids)?;
    check_membership(conn, chat_id, uid)?;
    social::require_chat_writable(conn, chat_id, uid)?;
    let is_admin = load_requester_group_role(conn, chat_id, uid)? == Some(GroupRole::Admin);
    let deletion = delete_selection(conn, chat_id, uid, is_admin, &ids)?;
    let payload = BulkDeletedPayload {
        chat_id: chat_id.to_string(),
        message_ids: deletion
            .impact
            .message_ids
            .iter()
            .map(i64::to_string)
            .collect(),
        complete: Some(true),
        thread_root_ids: Some(
            deletion
                .impact
                .thread_root_ids
                .iter()
                .map(i64::to_string)
                .collect(),
        ),
    };
    if let Some(search) = deps.message_search {
        search.delete_message_ids_best_effort(ids);
    }
    deps.ws_registry.broadcast_to_uids(
        &deletion.member_uids,
        Arc::new(ServerWsMessage::MessagesBulkDeleted(payload.clone())),
    );
    for root in &deletion.roots {
        if let Err(error) = crate::services::threads::broadcast_thread_update_to_uids(
            conn,
            deps.ws_registry,
            &deletion.member_uids,
            chat_id,
            root.id,
        ) {
            tracing::warn!(
                chat_id,
                root_id = root.id,
                ?error,
                "failed to broadcast thread update after bulk deletion"
            );
        }
    }
    for root in attach_metadata(conn, deletion.roots, deps.media, deps.avatars, uid).await {
        deps.ws_registry.broadcast_to_uids(
            &deletion.member_uids,
            Arc::new(ServerWsMessage::MessageUpdated(root)),
        );
    }
    Ok(payload)
}

#[cfg(test)]
mod message_write_tests {
    use super::{
        validate_client_message_type, AppError, MessageType, FORWARDED_MESSAGE_TYPE_FORBIDDEN,
        INVITE_MESSAGE_TYPE_FORBIDDEN, SYSTEM_MESSAGE_TYPE_FORBIDDEN,
    };

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
    fn rejects_forwarded_message_type_from_generic_message_api() {
        let err = validate_client_message_type(&MessageType::Forwarded)
            .expect_err("forwarded should be rejected");
        assert!(
            matches!(err, AppError::BadRequest(msg) if msg == FORWARDED_MESSAGE_TYPE_FORBIDDEN)
        );
    }
}

#[cfg(test)]
#[path = "message_search_pagination_tests.rs"]
mod search_pagination_tests;
