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
use crate::models::{GroupRole, Message, MessageType};
use crate::schema::{attachments, group_membership, groups, messages, messages::dsl};
use crate::services::api::{groups::load_requester_group_role, members::check_membership};
use crate::services::authentication::Principal;
use crate::services::authz::{Action as AuthzAction, AuthorizationService};
use crate::services::avatars::AvatarService;
use crate::services::forwarding::prepare_forward_message;
use crate::services::link_previews::{LinkPreviewJob, LinkPreviewService};
use crate::services::media::MediaStore;
use crate::services::message_search::{
    filter_authoritative_hits_with_counts, validate_search_query, MessageSearchMetrics,
    MessageSearchService, MessageSearchSort, SearchCandidateDropCounts,
};
use crate::services::message_visibility::{history_query, MessageVisibility};
use crate::services::messages::{
    attach_metadata, attachment_position, authorize_message_send, load_username_by_uid,
    parse_attachment_ids, project_message_id_conflict, sync_edited_message_mentions,
    validate_message, MessageWriter, PreparedMessageSend, SendMessageOutcome, MESSAGE_ID_CONFLICT,
};
use crate::services::push::PushService;
use crate::services::single_forwarding::{prepare_single_forward, PreparedSingleForward};
use crate::services::social;
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::pagination::validate_limit;
use crate::utils::transaction::AsyncTransaction;
const MAX_MESSAGES_LIMIT: i64 = 100;

pub struct MessagesService {
    pub restricted_user_group_ids: Arc<[i32]>,
    pub message_writer: Arc<MessageWriter>,
    pub authz_service: Arc<AuthorizationService>,
    pub ws_registry: Arc<ConnectionRegistry>,
    pub push_service: Arc<PushService>,
    pub message_search: Option<Arc<MessageSearchService>>,
    pub link_previews: Arc<LinkPreviewService>,
}

const DEFAULT_SEARCH_LIMIT: i64 = 20;
const MAX_SEARCH_RESULT_WINDOW: usize = 1_000;
const PAGE_ENVELOPE_RESERVE: usize = 4096;

#[derive(Clone, Copy)]
enum MessagePageTrimMode {
    Before,
    After,
    Around(i64),
}

fn fit_messages_page(
    response: &mut ListMessagesResponse,
    mode: MessagePageTrimMode,
    max_frame_bytes: usize,
) {
    if response.messages.is_empty() {
        return;
    }
    let shell = ListMessagesResponse {
        membership_message_policy: response.membership_message_policy.clone(),
        chat_settings: response.chat_settings,
        messages: Vec::new(),
        next_cursor: Some(i64::MAX),
        prev_cursor: Some(i64::MAX),
        older_cursor: Some(i64::MAX),
        newer_cursor: Some(i64::MAX),
    };
    let shell_bytes = serde_json::to_vec(&shell)
        .expect("list messages shell serializes")
        .len();
    let budget = max_frame_bytes.saturating_sub(PAGE_ENVELOPE_RESERVE + shell_bytes);
    let sizes: Vec<usize> = response
        .messages
        .iter()
        .map(|message| {
            serde_json::to_vec(message)
                .expect("message serializes")
                .len()
        })
        .collect();

    match mode {
        MessagePageTrimMode::Before => {
            let mut start = sizes.len() - 1;
            let mut used = sizes[start];
            while start > 0 {
                let next = sizes[start - 1];
                if used + 1 + next > budget {
                    break;
                }
                used += 1 + next;
                start -= 1;
            }
            if start > 0 {
                response.messages.drain(..start);
                response.older_cursor = response.messages.first().map(|message| message.id);
                response.next_cursor = response.older_cursor;
            }
        }
        MessagePageTrimMode::After => {
            let mut keep = 1;
            let mut used = sizes[0];
            while keep < sizes.len() {
                let next = sizes[keep];
                if used + 1 + next > budget {
                    break;
                }
                used += 1 + next;
                keep += 1;
            }
            if keep < response.messages.len() {
                response.messages.truncate(keep);
                response.newer_cursor = response.messages.last().map(|message| message.id);
                response.prev_cursor = response.newer_cursor;
            }
        }
        MessagePageTrimMode::Around(target) => {
            let pivot = response
                .messages
                .iter()
                .position(|message| message.id == target)
                .or_else(|| {
                    response
                        .messages
                        .iter()
                        .position(|message| message.id > target)
                })
                .unwrap_or(sizes.len() - 1);
            let mut left = pivot;
            let mut right = pivot;
            let mut used = sizes[pivot];
            let mut prefer_right = true;
            loop {
                let try_right = |right: usize, used: usize| -> Option<usize> {
                    (right + 1 < sizes.len())
                        .then(|| used + 1 + sizes[right + 1])
                        .filter(|next| *next <= budget)
                };
                let try_left = |left: usize, used: usize| -> Option<usize> {
                    (left > 0)
                        .then(|| used + 1 + sizes[left - 1])
                        .filter(|next| *next <= budget)
                };
                if prefer_right {
                    if let Some(next_used) = try_right(right, used) {
                        right += 1;
                        used = next_used;
                    } else if let Some(next_used) = try_left(left, used) {
                        left -= 1;
                        used = next_used;
                    } else {
                        break;
                    }
                } else if let Some(next_used) = try_left(left, used) {
                    left -= 1;
                    used = next_used;
                } else if let Some(next_used) = try_right(right, used) {
                    right += 1;
                    used = next_used;
                } else {
                    break;
                }
                prefer_right = !prefer_right;
            }
            if left > 0 {
                response.older_cursor = Some(response.messages[left].id);
                response.next_cursor = response.older_cursor;
            }
            if right + 1 < response.messages.len() {
                response.newer_cursor = Some(response.messages[right].id);
                response.prev_cursor = response.newer_cursor;
            }
            if left > 0 || right + 1 < response.messages.len() {
                response.messages.truncate(right + 1);
                response.messages.drain(..left);
            }
        }
    }
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
    let (chat_settings, kind, membership_message_policy) =
        crate::services::user::load_chat_settings_for_chat(conn, uid, chat_id)?;
    let filtering = MessageVisibility {
        kind,
        show_membership_messages: chat_settings.show_membership_messages,
        can_view_membership_messages: membership_message_policy.can_view,
    }
    .hides_membership(q_thread_id);
    let base_query = || history_query(chat_id, q_thread_id, filtering);

    // around=<id>: fetch a window centered on the target message
    if let Some(target) = q.around {
        let half = max / 2;

        // Messages with id >= target, ordered ASC (target first, then newer)
        let newer_rows: Vec<Message> = base_query()
            .filter(dsl::id.ge(target))
            .order(dsl::id.asc())
            .limit(half + 2)
            .select(Message::as_select())
            .load(conn)?;

        // Messages with id < target, ordered DESC (closest to target first)
        let older_rows: Vec<Message> = base_query()
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
            if let Some(target_message) = history_query(chat_id, q_thread_id, false)
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

        let mut response = ListMessagesResponse {
            membership_message_policy,
            chat_settings,
            messages: messages_vec,
            next_cursor: older_cursor,
            prev_cursor: newer_cursor,
            older_cursor,
            newer_cursor,
        };
        fit_messages_page(
            &mut response,
            MessagePageTrimMode::Around(target),
            crate::rpc::session::MAX_FRAME_BYTES,
        );
        return Ok(response);
    }

    // after=<id>: fetch messages newer than `after`, ascending order
    if let Some(after) = q.after {
        let rows: Vec<Message> = base_query()
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

        let mut response = ListMessagesResponse {
            membership_message_policy,
            chat_settings,
            messages: messages_vec,
            next_cursor: None,
            prev_cursor: newer_cursor,
            older_cursor: None,
            newer_cursor,
        };
        fit_messages_page(
            &mut response,
            MessagePageTrimMode::After,
            crate::rpc::session::MAX_FRAME_BYTES,
        );
        return Ok(response);
    }

    // Default: before cursor, descending (newest first in response, reversed by client)
    let rows: Vec<Message> = match q.before {
        None => base_query()
            .order(dsl::id.desc())
            .limit(max + 1)
            .select(Message::as_select())
            .load(conn),
        Some(before) => base_query()
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

    let mut response = ListMessagesResponse {
        membership_message_policy,
        chat_settings,
        messages: messages_vec,
        next_cursor: older_cursor,
        prev_cursor: None,
        older_cursor,
        newer_cursor: None,
    };
    fit_messages_page(
        &mut response,
        MessagePageTrimMode::Before,
        crate::rpc::session::MAX_FRAME_BYTES,
    );
    Ok(response)
}
impl MessagesService {
    pub async fn search_messages(
        &self,
        uid: i32,
        chat_id: i64,
        params: SearchMessagesQuery,
        conn: &mut PgConnection,
    ) -> Result<SearchMessagesResponse, AppError> {
        let media = &self.message_writer.media;
        let avatars = &self.message_writer.avatars;
        let metrics = &self.message_writer.metrics;
        let message_search = &self.message_search;
        let started_at = Instant::now();
        let sort = params.sort.unwrap_or(MessageSearchSort::Relevance);
        let sort_label = sort.as_str();

        if let Err(err) = check_membership(conn, chat_id, uid) {
            record_search_query_metrics(&metrics.message_search, sort_label, "failure", started_at);
            return Err(err);
        }

        let query = match validate_search_query(&params.q) {
            Ok(query) => query,
            Err(_) => {
                record_search_query_metrics(
                    &metrics.message_search,
                    sort_label,
                    "failure",
                    started_at,
                );
                return Err(AppError::BadRequest(
                    "Search query must be at least 2 characters",
                ));
            }
        };
        let limit = search_limit(params.limit);
        let offset = match search_offset(params.offset, limit) {
            Ok(offset) => offset,
            Err(err) => {
                record_search_query_metrics(
                    &metrics.message_search,
                    sort_label,
                    "failure",
                    started_at,
                );
                return Err(err);
            }
        };

        let Some(search_service) = message_search.as_ref() else {
            record_search_query_metrics(&metrics.message_search, sort_label, "failure", started_at);
            return Err(AppError::ServiceUnavailable("Message search unavailable"));
        };

        let candidate_page = match search_service
            .search_candidates(&query, chat_id, sort, limit, offset)
            .await
        {
            Ok(page) => page,
            Err(err) => {
                record_search_query_metrics(
                    &metrics.message_search,
                    sort_label,
                    "failure",
                    started_at,
                );
                tracing::warn!(
                    chat_id,
                    sort = sort_label,
                    ?err,
                    "message search query failed"
                );
                return Err(AppError::ServiceUnavailable("Message search unavailable"));
            }
        };
        metrics
            .message_search
            .observe_candidates(sort_label, candidate_page.candidates.len());
        let next_offset = search_next_offset(candidate_page.next_offset, limit);

        if candidate_page.candidates.is_empty() {
            metrics.message_search.observe_results(sort_label, 0);
            record_search_query_metrics(&metrics.message_search, sort_label, "success", started_at);
            return Ok(SearchMessagesResponse {
                messages: Vec::new(),
                next_offset,
            });
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
                record_search_query_metrics(
                    &metrics.message_search,
                    sort_label,
                    "failure",
                    started_at,
                );
                return Err(err.into());
            }
        };

        let authoritative_hits =
            filter_authoritative_hits_with_counts(chat_id, &candidate_page.candidates, rows);
        record_search_candidate_drops(&metrics.message_search, authoritative_hits.drops);
        let messages =
            attach_metadata(conn, authoritative_hits.messages, media, avatars, uid).await;
        metrics
            .message_search
            .observe_results(sort_label, messages.len());

        record_search_query_metrics(&metrics.message_search, sort_label, "success", started_at);

        Ok(SearchMessagesResponse {
            messages,
            next_offset,
        })
    }
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
    metrics.record_candidate_drop("not_searchable", drops.not_searchable);
    metrics.record_candidate_drop("stale_version", drops.stale_version);
}
impl MessagesService {
    pub async fn get_message(
        &self,
        uid: i32,
        chat_id: i64,
        message_id: i64,
        conn: &mut PgConnection,
    ) -> Result<MessageResponse, AppError> {
        let media = &self.message_writer.media;
        let avatars = &self.message_writer.avatars;
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
}

#[cfg(test)]
mod tests;

impl MessagesService {
    pub fn get_forwarded_messages(
        &self,
        uid: i32,
        chat_id: i64,
        message_id: i64,
        conn: &mut PgConnection,
    ) -> Result<crate::dto::messages::ForwardedMessagesResponse, AppError> {
        let media = &self.message_writer.media;
        let avatars = &self.message_writer.avatars;
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
}

impl MessagesService {
    pub fn get_forwarded_bundle_messages(
        &self,
        uid: i32,
        chat_id: i64,
        message_id: i64,
        bundle_id: i64,
        conn: &mut PgConnection,
    ) -> Result<crate::dto::messages::ForwardedMessagesResponse, AppError> {
        let media = &self.message_writer.media;
        let avatars = &self.message_writer.avatars;
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

impl MessagesService {
    pub async fn post_message(
        &self,
        principal: Principal,
        chat_id: i64,
        body: CreateMessageBody,
        conn: &mut PgConnection,
    ) -> Result<MessageResponse, AppError> {
        let uid = principal.require_user_action(
            conn,
            &self.authz_service,
            AuthzAction::OnBehalfOfMessageSend,
        )?;
        validate_client_message_type(&body.message_type)?;
        let attachment_ids = parse_attachment_ids(&body.attachment_ids)?;
        let publish_immediately = !matches!(body.message_type, MessageType::Audio);
        let mut previews = crate::services::link_previews::prepare(
            matches!(
                body.message_type,
                MessageType::Text | MessageType::Audio | MessageType::File
            )
            .then_some(body.message.as_deref())
            .flatten(),
            body.metadata.as_ref(),
            Utc::now(),
        )?;
        self.link_previews.drafts.apply(uid, &mut previews);
        let (send_result, receipt_advanced) = {
            let mut transaction = AsyncTransaction::begin(conn)?;
            let conn = transaction.connection();
            let result = async {
                let target = authorize_message_send(
                    conn,
                    chat_id,
                    None,
                    uid,
                    &self.restricted_user_group_ids,
                )?;
                let send_result = self
                    .message_writer
                    .send_client_message(
                        conn,
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
                let receipt_advanced =
                    if let SendMessageOutcome::Created(send_result) = &send_result {
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

        self.ws_registry.invalidate_unread(&[uid]);
        let response = match send_result {
            SendMessageOutcome::Created(send_result) => {
                let send_result = *send_result;
                send_result
                    .side_effects
                    .fire(&self.ws_registry, &self.push_service);
                if !previews.work.is_empty() {
                    self.link_previews.enqueue(LinkPreviewJob::new(
                        &send_result.inserted_message,
                        previews.expires_at,
                        previews.work,
                    ));
                }
                if let Some(search_service) = &self.message_search {
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
                &self.ws_registry,
                chat_id,
                false,
                Some(uid),
                None,
            )?;
        }
        Ok(response)
    }
}

impl MessagesService {
    pub async fn forward_messages(
        &self,
        uid: i32,
        dest_chat_id: i64,
        body: ForwardMessagesBody,
        conn: &mut PgConnection,
    ) -> Result<MessageResponse, AppError> {
        let (send_result, receipt_advanced, subscription_changes) = {
            let mut transaction = AsyncTransaction::begin(conn)?;
            let conn = transaction.connection();
            let result = async {
                let target = authorize_message_send(
                    conn,
                    dest_chat_id,
                    body.thread_id,
                    uid,
                    &self.restricted_user_group_ids,
                )?;
                let prepared = match prepare_forward_message(
                    conn,
                    self.message_writer.id_gen.as_ref(),
                    uid,
                    dest_chat_id,
                    target.kind,
                    &body,
                )
                .await
                {
                    Err(AppError::Conflict(MESSAGE_ID_CONFLICT)) => {
                        return Err(forward_conflict(
                            conn,
                            (&self.message_writer.media, &self.message_writer.avatars),
                            &body.client_generated_id,
                            uid,
                            dest_chat_id,
                            body.thread_id,
                        )
                        .await);
                    }
                    other => other?,
                };
                let send_result = self
                    .message_writer
                    .send_client_message(conn, prepared)
                    .await?;
                let SendMessageOutcome::Created(created) = &send_result else {
                    return Ok((send_result, false, Vec::new()));
                };
                let (receipt_advanced, subscription_changes) =
                    if let Some(root) = &target.thread_root {
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
            .fire(&self.ws_registry, &self.push_service);
        if receipt_advanced {
            crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
                conn,
                &self.ws_registry,
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
                    &self.ws_registry,
                    changed_uid,
                    dest_chat_id,
                    thread_id,
                )?;
            }
            self.broadcast_thread_send_updates(
                conn,
                dest_chat_id,
                thread_id,
                &created.member_uids,
                uid,
            )
            .await;
        }
        Ok(created.response)
    }
}

impl MessagesService {
    pub async fn forward_message(
        &self,
        uid: i32,
        chat_id: i64,
        message_id: i64,
        body: ForwardMessageBody,
        conn: &mut PgConnection,
    ) -> Result<MessageResponse, AppError> {
        let (send_result, receipt_advanced, subscription_changes) = {
            let mut transaction = AsyncTransaction::begin(conn)?;
            let conn = transaction.connection();
            let result = async {
                let target = authorize_message_send(
                    conn,
                    chat_id,
                    body.thread_id,
                    uid,
                    &self.restricted_user_group_ids,
                )?;
                let prepared = match prepare_single_forward(
                    conn,
                    self.message_writer.id_gen.as_ref(),
                    uid,
                    chat_id,
                    target.kind,
                    message_id,
                    &body,
                )
                .await
                {
                    Err(AppError::Conflict(MESSAGE_ID_CONFLICT)) => {
                        return Err(forward_conflict(
                            conn,
                            (&self.message_writer.media, &self.message_writer.avatars),
                            &body.client_generated_id,
                            uid,
                            chat_id,
                            body.thread_id,
                        )
                        .await);
                    }
                    other => other?,
                };
                let send_result = match prepared {
                    PreparedSingleForward::Existing(existing) => {
                        let response = attach_metadata(
                            conn,
                            vec![*existing],
                            &self.message_writer.media,
                            &self.message_writer.avatars,
                            uid,
                        )
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
                        self.message_writer
                            .send_client_message(conn, *prepared)
                            .await?
                    }
                };
                let SendMessageOutcome::Created(created) = &send_result else {
                    return Ok((send_result, false, Vec::new()));
                };
                let (receipt_advanced, subscription_changes) =
                    if let Some(root) = &target.thread_root {
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
                            chat_id,
                            uid,
                            created.response.id,
                        )?;
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
            .fire(&self.ws_registry, &self.push_service);
        if let Some(search) = &self.message_search {
            search.upsert_message_best_effort(created.inserted_message);
        }
        if receipt_advanced {
            crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
                conn,
                &self.ws_registry,
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
                    &self.ws_registry,
                    changed_uid,
                    chat_id,
                    thread_id,
                )?;
            }
            self.broadcast_thread_send_updates(conn, chat_id, thread_id, &created.member_uids, uid)
                .await;
        }
        Ok(created.response)
    }
}

async fn forward_conflict(
    conn: &mut PgConnection,
    projection: (&MediaStore, &AvatarService),
    client_id: &str,
    uid: i32,
    chat_id: i64,
    thread_id: Option<i64>,
) -> AppError {
    let existing = messages::table
        .filter(dsl::client_generated_id.eq(client_id))
        .filter(dsl::sender_uid.eq(uid))
        .filter(dsl::chat_id.eq(chat_id))
        .filter(dsl::reply_root_id.is_not_distinct_from(thread_id))
        .select(Message::as_select())
        .first(conn)
        .optional();
    match existing {
        Ok(Some(existing)) => {
            project_message_id_conflict(conn, projection, existing, uid, chat_id, thread_id).await
        }
        _ => AppError::Conflict(MESSAGE_ID_CONFLICT),
    }
}

impl MessagesService {
    pub async fn post_thread_message(
        &self,
        uid: i32,
        chat_id: i64,
        thread_id: i64,
        body: CreateMessageBody,
        conn: &mut PgConnection,
    ) -> Result<MessageResponse, AppError> {
        validate_client_message_type(&body.message_type)?;
        let attachment_ids = parse_attachment_ids(&body.attachment_ids)?;
        let publish_immediately = !matches!(body.message_type, MessageType::Audio);
        let mut previews = crate::services::link_previews::prepare(
            matches!(
                body.message_type,
                MessageType::Text | MessageType::Audio | MessageType::File
            )
            .then_some(body.message.as_deref())
            .flatten(),
            body.metadata.as_ref(),
            Utc::now(),
        )?;
        self.link_previews.drafts.apply(uid, &mut previews);
        let (send_result, receipt_advanced, subscription_changes) = {
            let mut transaction = AsyncTransaction::begin(conn)?;
            let conn = transaction.connection();
            let result = async {
                let target = authorize_message_send(
                    conn,
                    chat_id,
                    Some(thread_id),
                    uid,
                    &self.restricted_user_group_ids,
                )?;
                let root_msg = target.thread_root.ok_or(AppError::Internal(
                    "Thread authorization did not return a thread root",
                ))?;
                let send_result = self
                    .message_writer
                    .send_client_message(
                        conn,
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
        self.ws_registry.invalidate_unread(&[uid]);
        msg_side_effects.fire(&self.ws_registry, &self.push_service);
        if !previews.work.is_empty() {
            self.link_previews.enqueue(LinkPreviewJob::new(
                &send_result.inserted_message,
                previews.expires_at,
                previews.work,
            ));
        }
        if let Some(search_service) = &self.message_search {
            search_service.upsert_response_best_effort(response.clone());
        }
        if matches!(response.message_type, MessageType::Audio) {
            crate::services::audio_transcode::enqueue_message(response.id);
        }
        if receipt_advanced {
            crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
                conn,
                &self.ws_registry,
                chat_id,
                false,
                Some(uid),
                Some(thread_id),
            )?;
        }
        for changed_uid in subscription_changes {
            crate::services::threads::broadcast_thread_membership_changed_to_user(
                conn,
                &self.ws_registry,
                changed_uid,
                chat_id,
                thread_id,
            )?;
        }
        if publish_immediately {
            self.broadcast_thread_send_updates(conn, chat_id, thread_id, &member_uids, uid)
                .await;
        }
        Ok(response)
    }
}

impl MessagesService {
    async fn broadcast_thread_send_updates(
        &self,
        conn: &mut PgConnection,
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
            if let Some(root_response) = attach_metadata(
                conn,
                vec![root],
                &self.message_writer.media,
                &self.message_writer.avatars,
                uid,
            )
            .await
            .into_iter()
            .next()
            {
                self.ws_registry.broadcast_to_uids(
                    member_uids,
                    Arc::new(ServerWsMessage::MessageUpdated(root_response)),
                );
            }
        }
        if let Err(error) = crate::services::threads::broadcast_thread_update_to_subscribers(
            conn,
            &self.ws_registry,
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
}

impl MessagesService {
    pub async fn patch_message(
        &self,
        uid: i32,
        chat_id: i64,
        message_id: i64,
        body: UpdateMessageBody,
        conn: &mut PgConnection,
    ) -> Result<MessageResponse, AppError> {
        check_membership(conn, chat_id, uid)?;
        social::require_chat_writable(conn, chat_id, uid, &self.restricted_user_group_ids)?;
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
                let mut previews = crate::services::link_previews::prepare_edit(
                    &body.message,
                    body.metadata.as_ref(),
                    message.metadata.as_ref(),
                    Utc::now(),
                )?;
                self.link_previews.drafts.apply(uid, &mut previews);
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
        if let Some(search_service) = &self.message_search {
            search_service.upsert_message_best_effort(updated_message.clone());
        }
        let edited_thread_root_id = updated_message.reply_root_id;
        let preview_job = (!previews.work.is_empty())
            .then(|| LinkPreviewJob::new(&updated_message, previews.expires_at, previews.work));
        let response = attach_metadata(
            conn,
            vec![updated_message],
            &self.message_writer.media,
            &self.message_writer.avatars,
            uid,
        )
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
        self.ws_registry.broadcast_to_uids(&member_uids, ws_msg);
        if let Some(job) = preview_job {
            self.link_previews.enqueue(job);
        }
        if let Some(root_id) = edited_thread_root_id {
            for mentioned_uid in &added_mention_uids {
                crate::services::threads::broadcast_thread_membership_changed_to_user(
                    conn,
                    &self.ws_registry,
                    *mentioned_uid,
                    chat_id,
                    root_id,
                )?;
            }
        }
        if !added_mention_uids.is_empty() {
            let actor_name =
                load_username_by_uid(conn, uid)?.unwrap_or_else(|| "Someone".to_string());
            let payload = NotificationPayload {
                notification_type: NotificationType::Mention,
                chat_id,
                message_id,
                thread_root_id: edited_thread_root_id,
                actor_uid: uid,
                actor_name: Some(actor_name),
            };
            self.ws_registry.broadcast_to_uids(
                &added_mention_uids,
                Arc::new(ServerWsMessage::Notification(payload)),
            );
        }
        Ok(response)
    }
}

impl MessagesService {
    pub async fn delete_message(
        &self,
        uid: i32,
        chat_id: i64,
        message_id: i64,
        conn: &mut PgConnection,
    ) -> Result<(), AppError> {
        check_membership(conn, chat_id, uid)?;
        social::require_chat_writable(conn, chat_id, uid, &self.restricted_user_group_ids)?;
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
        if let Some(search_service) = &self.message_search {
            search_service.delete_message_best_effort(message_id);
        }
        let response = attach_metadata(
            conn,
            vec![deleted_message],
            &self.message_writer.media,
            &self.message_writer.avatars,
            uid,
        )
        .await
        .into_iter()
        .next()
        .unwrap();
        let member_uids: Vec<i32> = if message.system_kind.is_some_and(|kind| kind.is_membership())
        {
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
        self.ws_registry.broadcast_to_uids(
            &member_uids,
            Arc::new(ServerWsMessage::MessageDeleted(response.clone())),
        );
        if let Some(reply_root_id) = response.reply_root_id {
            if let Err(err) = crate::services::threads::broadcast_thread_update_to_subscribers(
                conn,
                &self.ws_registry,
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
                let root_response = attach_metadata(
                    conn,
                    vec![root_msg],
                    &self.message_writer.media,
                    &self.message_writer.avatars,
                    uid,
                )
                .await
                .into_iter()
                .next();
                if let Some(root_response) = root_response {
                    self.ws_registry.broadcast_to_uids(
                        &member_uids,
                        Arc::new(ServerWsMessage::MessageUpdated(root_response)),
                    );
                }
            }
        }
        Ok(())
    }
}

impl MessagesService {
    pub async fn bulk_delete_messages(
        &self,
        uid: i32,
        chat_id: i64,
        body: BulkDeleteMessagesBody,
        conn: &mut PgConnection,
    ) -> Result<BulkDeletedPayload, AppError> {
        use crate::services::message_deletion::{delete_selection, validate_message_ids};
        let ids = validate_message_ids(body.message_ids)?;
        check_membership(conn, chat_id, uid)?;
        social::require_chat_writable(conn, chat_id, uid, &self.restricted_user_group_ids)?;
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
        if let Some(search) = &self.message_search {
            search.delete_message_ids_best_effort(ids);
        }
        self.ws_registry.broadcast_to_uids(
            &deletion.member_uids,
            Arc::new(ServerWsMessage::MessagesBulkDeleted(payload.clone())),
        );
        for root in &deletion.roots {
            if let Err(error) = crate::services::threads::broadcast_thread_update_to_uids(
                conn,
                &self.ws_registry,
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
        for root in attach_metadata(
            conn,
            deletion.roots,
            &self.message_writer.media,
            &self.message_writer.avatars,
            uid,
        )
        .await
        {
            self.ws_registry.broadcast_to_uids(
                &deletion.member_uids,
                Arc::new(ServerWsMessage::MessageUpdated(root)),
            );
        }
        Ok(payload)
    }
}

#[cfg(test)]
mod message_write_tests;

#[cfg(test)]
mod page_budget_tests;
