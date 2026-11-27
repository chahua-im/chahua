use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use diesel::PgConnection;
use diesel::{pg::Pg, prelude::*};

use crate::dto::attachments::{
    ChatAttachmentKindFilter, ChatAttachmentResponse, ListChatAttachmentsQuery,
    ListChatAttachmentsResponse,
};
use crate::errors::AppError;
use crate::models::Attachment;
use crate::schema::{attachments, messages};
use crate::services::api::members::check_membership;
use crate::services::avatars::AvatarService;
use crate::services::media::MediaStore;
use crate::services::messages::build_sender;
use crate::services::user::lookup_user_profiles;
use crate::utils::pagination::validate_limit;

const MAX_CHAT_ATTACHMENTS_LIMIT: i64 = 100;

#[derive(Debug, Clone)]
struct AttachmentMessageRow {
    message_id: i64,
    sender_uid: i32,
    message_created_at: DateTime<Utc>,
}

type AttachmentBoxedQuery<'a> = attachments::BoxedQuery<'a, Pg>;

const MAX_ATTACHMENTS_PER_MESSAGE: i64 = 20;

pub fn get_chat_attachments(
    uid: i32,
    chat_id: i64,
    query: ListChatAttachmentsQuery,
    conn: &mut PgConnection,
    media_store: &MediaStore,
    avatars: &AvatarService,
) -> Result<ListChatAttachmentsResponse, AppError> {
    if query.before.is_some() && query.after.is_some() {
        return Err(AppError::BadRequest(
            "before and after cursors are mutually exclusive",
        ));
    }

    check_membership(conn, chat_id, uid)?;

    let limit = validate_limit(query.limit, MAX_CHAT_ATTACHMENTS_LIMIT);
    let (message_rows, has_more) =
        load_attachment_messages(conn, chat_id, query.kind, limit, query.before, query.after)?;
    let message_ids: Vec<i64> = message_rows
        .iter()
        .map(|message| message.message_id)
        .collect();
    let attachments = load_matching_attachments(conn, &message_ids, query.kind)?;
    let (older_cursor, newer_cursor) =
        attachment_cursors(&message_rows, has_more, query.before, query.after);

    let sender_uids: Vec<i32> = message_rows
        .iter()
        .map(|message| message.sender_uid)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let user_avatars = avatars.lookup(&sender_uids);
    let user_profiles = lookup_user_profiles(conn, &sender_uids).unwrap_or_default();
    let message_map: HashMap<i64, AttachmentMessageRow> = message_rows
        .into_iter()
        .map(|message| (message.message_id, message))
        .collect();

    let mut response_attachments = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let Some(message_id) = attachment.message_id else {
            continue;
        };
        let Some(message) = message_map.get(&message_id) else {
            continue;
        };

        response_attachments.push(ChatAttachmentResponse {
            id: attachment.id,
            message_id,
            message_created_at: message.message_created_at,
            sender: build_sender(message.sender_uid, &user_avatars, &user_profiles),
            url: media_store.public_url(&attachment.external_reference),
            kind: attachment.kind,
            size: attachment.size,
            file_name: attachment.file_name,
            width: attachment.width,
            height: attachment.height,
            order: attachment.order,
        });
    }

    Ok(ListChatAttachmentsResponse {
        attachments: response_attachments,
        older_cursor,
        newer_cursor,
    })
}

fn apply_kind_filter<'a>(
    query: AttachmentBoxedQuery<'a>,
    kind: ChatAttachmentKindFilter,
) -> AttachmentBoxedQuery<'a> {
    use crate::schema::attachments::dsl as a_dsl;

    match kind {
        ChatAttachmentKindFilter::Image => query.filter(a_dsl::kind.like("image/%")),
        ChatAttachmentKindFilter::Video => query.filter(a_dsl::kind.like("video/%")),
        ChatAttachmentKindFilter::Other => query
            .filter(a_dsl::kind.not_like("image/%"))
            .filter(a_dsl::kind.not_like("video/%")),
        ChatAttachmentKindFilter::All => query,
    }
}

fn load_attachment_messages(
    conn: &mut PgConnection,
    chat_id: i64,
    kind: ChatAttachmentKindFilter,
    limit: i64,
    before: Option<i64>,
    after: Option<i64>,
) -> QueryResult<(Vec<AttachmentMessageRow>, bool)> {
    use crate::schema::attachments::dsl as a_dsl;
    use crate::schema::messages::dsl as m_dsl;

    let mut query = messages::table
        .inner_join(attachments::table.on(a_dsl::message_id.eq(m_dsl::id.nullable())))
        .into_boxed::<Pg>()
        .filter(m_dsl::chat_id.eq(chat_id))
        .filter(m_dsl::deleted_at.is_null())
        .filter(m_dsl::is_published.eq(true))
        .filter(m_dsl::has_attachments.eq(true))
        .filter(a_dsl::deleted_at.is_null());

    query = match kind {
        ChatAttachmentKindFilter::Image => query.filter(a_dsl::kind.like("image/%")),
        ChatAttachmentKindFilter::Video => query.filter(a_dsl::kind.like("video/%")),
        ChatAttachmentKindFilter::Other => query
            .filter(a_dsl::kind.not_like("image/%"))
            .filter(a_dsl::kind.not_like("video/%")),
        ChatAttachmentKindFilter::All => query,
    };

    // Bound both merge-join inputs so attachments can seek to the cursor too.
    if let Some(before) = before {
        query = query
            .filter(m_dsl::id.lt(before))
            .filter(a_dsl::message_id.lt(before));
    }
    if let Some(after) = after {
        query = query
            .filter(m_dsl::id.gt(after))
            .filter(a_dsl::message_id.gt(after));
    }

    if after.is_some() {
        query = query.order(m_dsl::id.asc());
    } else {
        query = query.order(m_dsl::id.desc());
    }

    let rows: Vec<(i64, i32, DateTime<Utc>, i64)> = query
        .limit(limit + MAX_ATTACHMENTS_PER_MESSAGE + 1)
        .select((m_dsl::id, m_dsl::sender_uid, m_dsl::created_at, a_dsl::id))
        .load(conn)?;

    let mut messages = Vec::new();
    let mut seen_message_ids = HashSet::new();
    let mut selected_attachment_count = 0_i64;
    let mut final_message_id = None;
    let mut has_more = false;

    for (message_id, sender_uid, message_created_at, _attachment_id) in rows {
        if let Some(done_message_id) = final_message_id {
            if message_id != done_message_id {
                has_more = true;
                break;
            }
        }

        if seen_message_ids.insert(message_id) {
            messages.push(AttachmentMessageRow {
                message_id,
                sender_uid,
                message_created_at,
            });
        }
        selected_attachment_count += 1;

        if selected_attachment_count >= limit {
            final_message_id = Some(message_id);
        }
    }

    messages.sort_by_key(|message| std::cmp::Reverse(message.message_id));

    Ok((messages, has_more))
}

fn load_matching_attachments(
    conn: &mut PgConnection,
    message_ids: &[i64],
    kind: ChatAttachmentKindFilter,
) -> QueryResult<Vec<Attachment>> {
    use crate::schema::attachments::dsl as a_dsl;

    if message_ids.is_empty() {
        return Ok(Vec::new());
    }

    apply_kind_filter(
        attachments::table
            .into_boxed::<Pg>()
            .filter(a_dsl::message_id.eq_any(message_ids))
            .filter(a_dsl::deleted_at.is_null()),
        kind,
    )
    .order((
        a_dsl::message_id.desc(),
        a_dsl::order.asc(),
        a_dsl::id.asc(),
    ))
    .select(Attachment::as_select())
    .load(conn)
}

fn attachment_cursors(
    messages: &[AttachmentMessageRow],
    has_more: bool,
    before: Option<i64>,
    after: Option<i64>,
) -> (Option<i64>, Option<i64>) {
    let newest = messages.first().map(|message| message.message_id);
    let oldest = messages.last().map(|message| message.message_id);

    let older_cursor = if has_more || after.is_some() {
        oldest
    } else {
        None
    };
    let newer_cursor = if has_more && after.is_some() || before.is_some() {
        newest
    } else {
        None
    };

    (older_cursor, newer_cursor)
}

#[cfg(test)]
mod tests;
