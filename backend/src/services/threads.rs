use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::query_dsl::positional_order_dsl::PositionalOrderDsl;
use diesel::sql_query;
use diesel::PgConnection;
use std::collections::HashMap;

use crate::constants::MAX_UNREAD_COUNT;
use crate::dto::{
    messages::{MessagePreview, MessagePreviewAttachment},
    threads::{ListThreadsResponse, ThreadListItem},
    users::User,
    ws::{ServerWsMessage, ThreadMembershipChangedPayload, ThreadUpdatePayload},
};
use crate::models::{Attachment, GroupKind, Message};
use crate::schema::{attachments, messages, stickers, thread_meta, thread_user_states};
use crate::services::avatars::AvatarService;
use crate::services::media::MediaStore;
use crate::services::messages::{
    build_message_preview, build_sender, extract_mention_uids, MessagePreviewInput,
};
use crate::services::read_receipts;
use crate::services::user::lookup_user_profiles;
use crate::services::ws_registry::ConnectionRegistry;
use std::sync::Arc;

pub(crate) struct ThreadSendState {
    pub receipt_advanced: bool,
    pub subscription_changes: Vec<i32>,
}

/// Persist thread state in the same transaction as a newly created message.
/// Forwards share this path but their quoted mentions are display-only.
pub(crate) fn record_thread_send(
    conn: &mut PgConnection,
    response: &crate::dto::messages::MessageResponse,
    member_uids: &[i32],
    root: &Message,
    publish_immediately: bool,
    notify_mentions: bool,
) -> QueryResult<ThreadSendState> {
    let chat_id = response.chat_id;
    let thread_id = root.id;
    let uid = response.sender.uid;
    let mut subscription_changes = Vec::new();
    if ensure_thread_subscription(conn, chat_id, thread_id, uid)? {
        subscription_changes.push(uid);
    }
    mark_thread_as_read(conn, chat_id, thread_id, uid, response.id)?;
    let receipt_advanced = crate::services::read_receipts::advance_thread_read_receipt(
        conn,
        chat_id,
        thread_id,
        uid,
        response.id,
    )?;
    if root.sender_uid != uid
        && member_uids.contains(&root.sender_uid)
        && ensure_thread_user_state(conn, chat_id, thread_id, root.sender_uid, true)?
    {
        subscription_changes.push(root.sender_uid);
    }
    if notify_mentions {
        if let Some(text) = &response.message {
            for mentioned_uid in extract_mention_uids(text) {
                if mentioned_uid != uid
                    && member_uids.contains(&mentioned_uid)
                    && ensure_thread_subscription(conn, chat_id, thread_id, mentioned_uid)?
                {
                    subscription_changes.push(mentioned_uid);
                }
            }
        }
    }
    if publish_immediately {
        increment_thread_meta(conn, chat_id, thread_id, response.created_at)?;
        diesel::update(messages::table.filter(messages::id.eq(thread_id)))
            .set(messages::has_thread.eq(true))
            .execute(conn)?;
    }
    Ok(ThreadSendState {
        receipt_advanced,
        subscription_changes,
    })
}

/// Ensure a thread-user state row exists. This is an insert-only helper:
/// conflicts preserve the user's current subscription, archive, and read state.
///
/// Expected behavior:
/// - browsing/read tracking inserts `subscribed=false, archived=false`;
/// - first participant tracking inserts `subscribed=true, archived=false`;
/// - existing rows are never modified.
pub fn ensure_thread_user_state(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
    subscribed: bool,
) -> Result<bool, diesel::result::Error> {
    let subscribed_at = if subscribed {
        Utc::now()
    } else {
        DateTime::UNIX_EPOCH
    };
    let inserted = diesel::insert_into(thread_user_states::table)
        .values((
            thread_user_states::chat_id.eq(chat_id),
            thread_user_states::thread_root_id.eq(thread_root_id),
            thread_user_states::uid.eq(uid),
            thread_user_states::subscribed_at.eq(subscribed_at),
            thread_user_states::archived.eq(false),
            thread_user_states::subscribed.eq(subscribed),
        ))
        .on_conflict_do_nothing()
        .execute(conn)?;
    Ok(inserted > 0)
}

/// Ensure the user is subscribed to the thread. This may create a row or flip
/// `subscribed` back to true, but archive state is owned only by archive and
/// unarchive actions.
pub fn ensure_thread_subscription(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<bool, diesel::result::Error> {
    let existing = get_subscription_state(conn, chat_id, thread_root_id, uid)?;

    if let Some((_, subscribed)) = existing {
        if subscribed {
            return Ok(false);
        }

        let updated = diesel::update(
            thread_user_states::table.filter(
                thread_user_states::chat_id
                    .eq(chat_id)
                    .and(thread_user_states::thread_root_id.eq(thread_root_id))
                    .and(thread_user_states::uid.eq(uid)),
            ),
        )
        .set((
            thread_user_states::subscribed_at.eq(Utc::now()),
            thread_user_states::subscribed.eq(true),
        ))
        .execute(conn)?;
        return Ok(updated > 0);
    }

    let inserted = diesel::insert_into(thread_user_states::table)
        .values((
            thread_user_states::chat_id.eq(chat_id),
            thread_user_states::thread_root_id.eq(thread_root_id),
            thread_user_states::uid.eq(uid),
            thread_user_states::subscribed_at.eq(Utc::now()),
            thread_user_states::archived.eq(false),
            thread_user_states::subscribed.eq(true),
        ))
        .on_conflict_do_nothing()
        .execute(conn)?;
    Ok(inserted > 0)
}

/// Explicit unsubscribe (for "Unfollow thread" button).
pub fn unsubscribe_from_thread(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<bool, diesel::result::Error> {
    let updated = diesel::update(
        thread_user_states::table.filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::thread_root_id.eq(thread_root_id))
                .and(thread_user_states::uid.eq(uid))
                .and(thread_user_states::subscribed.eq(true)),
        ),
    )
    .set(thread_user_states::subscribed.eq(false))
    .execute(conn)?;
    Ok(updated > 0)
}

/// Remove every active thread subscription for a user who no longer belongs to
/// a chat. Read state remains available if they rejoin and subscribe again.
pub fn unsubscribe_user_from_chat(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<usize, diesel::result::Error> {
    diesel::update(
        thread_user_states::table.filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::uid.eq(uid))
                .and(thread_user_states::subscribed.eq(true)),
        ),
    )
    .set(thread_user_states::subscribed.eq(false))
    .execute(conn)
}
/// Returns `(archived, subscribed)` for the given user/thread, or `None` if no row exists.
pub fn get_subscription_state(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<Option<(bool, bool)>, diesel::result::Error> {
    thread_user_states::table
        .filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::thread_root_id.eq(thread_root_id))
                .and(thread_user_states::uid.eq(uid)),
        )
        .select((thread_user_states::archived, thread_user_states::subscribed))
        .first(conn)
        .optional()
}
#[derive(QueryableByName)]
struct ThreadUnreadCountRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    unread_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadReadState {
    pub last_read_message_id: Option<i64>,
    pub unread_count: i64,
    pub receipt_advanced: bool,
}
pub fn get_thread_unread_count(
    conn: &mut PgConnection,
    thread_root_id: i64,
    uid: i32,
    last_read_message_id: Option<i64>,
) -> Result<i64, diesel::result::Error> {
    let query = sql_query(
        "SELECT COUNT(unread_messages.marker)::bigint AS unread_count
         FROM (
             SELECT 1 AS marker
             FROM thread_user_states ts
             JOIN messages m ON m.reply_root_id = ts.thread_root_id
                            AND m.deleted_at IS NULL
                            AND m.is_published = TRUE
                            AND m.id > COALESCE($3, 0)
             WHERE ts.thread_root_id = $1
               AND ts.uid = $2
             LIMIT $4
         ) AS unread_messages",
    )
    .bind::<diesel::sql_types::BigInt, _>(thread_root_id)
    .bind::<diesel::sql_types::Integer, _>(uid)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::BigInt>, _>(last_read_message_id)
    .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT);

    query
        .get_result::<ThreadUnreadCountRow>(conn)
        .map(|row| row.unread_count.min(MAX_UNREAD_COUNT))
}
pub fn mark_thread_read(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
    message_id: i64,
) -> Result<ThreadReadState, diesel::result::Error> {
    let receipt_advanced = conn.transaction(|conn| {
        mark_thread_as_read(conn, chat_id, thread_root_id, uid, message_id)?;
        crate::services::read_receipts::advance_thread_read_receipt(
            conn,
            chat_id,
            thread_root_id,
            uid,
            message_id,
        )
    })?;
    let last_read_message_id = get_thread_last_read_message_id(conn, chat_id, thread_root_id, uid)?;
    let unread_count = get_thread_unread_count(conn, thread_root_id, uid, last_read_message_id)?;

    Ok(ThreadReadState {
        last_read_message_id,
        unread_count,
        receipt_advanced,
    })
}

/// Update `last_read_message_id` on `thread_user_states` (only advances forward).
pub fn mark_thread_as_read(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
    message_id: i64,
) -> Result<bool, diesel::result::Error> {
    let updated = diesel::update(
        thread_user_states::table.filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::thread_root_id.eq(thread_root_id))
                .and(thread_user_states::uid.eq(uid))
                .and(
                    thread_user_states::last_read_message_id
                        .is_null()
                        .or(thread_user_states::last_read_message_id.lt(message_id)),
                ),
        ),
    )
    .set(thread_user_states::last_read_message_id.eq(Some(message_id)))
    .execute(conn)?;
    // Unread reactions are NOT acknowledged here: the thread reaction cursor
    // is independent of the message read position and only advances through
    // the explicit reaction-acknowledge endpoint.
    Ok(updated > 0)
}

/// Read `last_read_message_id` from `thread_user_states`.
pub fn get_thread_last_read_message_id(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<Option<i64>, diesel::result::Error> {
    thread_user_states::table
        .filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::thread_root_id.eq(thread_root_id))
                .and(thread_user_states::uid.eq(uid)),
        )
        .select(thread_user_states::last_read_message_id)
        .first::<Option<i64>>(conn)
        .optional()
        .map(|row| row.flatten())
}

/// After a thread reply is soft-deleted, any `thread_user_states.last_read_message_id`
/// anchored on it dangles — the PWA thread resume flow fetches
/// `around=<last_read_message_id>` and strands scroll when that id is absent
/// from the window (the around filter is `reply_root_id == thread_root_id AND
/// deleted_at IS NULL AND is_published`). Shift every anchored pointer to the
/// newest surviving reply strictly older than the deleted one (or NULL when
/// none survives).
///
/// `deleted_message_ids` must already be soft-deleted before this runs, so the
/// clamp subquery's `deleted_at IS NULL` filter excludes them — letting one
/// batched UPDATE handle multi-reply deletes correctly. `thread_root_id` is a
/// globally unique message id, so it alone scopes the update.
///
/// Served by `idx_messages_thread_reply_stats` (reply_root_id, id DESC) WHERE
/// deleted_at IS NULL AND is_published.
pub fn shift_thread_read_pointers_on_delete(
    conn: &mut PgConnection,
    thread_root_id: i64,
    deleted_message_ids: &[i64],
) -> Result<usize, diesel::result::Error> {
    if deleted_message_ids.is_empty() {
        return Ok(0);
    }
    diesel::sql_query(
        "UPDATE thread_user_states
         SET last_read_message_id = (
             SELECT id FROM messages
             WHERE reply_root_id = $1
               AND id < thread_user_states.last_read_message_id
               AND deleted_at IS NULL
               AND is_published
             ORDER BY id DESC
             LIMIT 1
         )
         WHERE thread_root_id = $1
           AND last_read_message_id = ANY($2)",
    )
    .bind::<diesel::sql_types::BigInt, _>(thread_root_id)
    .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(deleted_message_ids)
    .execute(conn)
}
/// Get all UIDs subscribed to a given thread.
pub fn get_thread_subscriber_uids(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
) -> Result<Vec<i32>, diesel::result::Error> {
    thread_user_states::table
        .filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::thread_root_id.eq(thread_root_id))
                .and(thread_user_states::subscribed.eq(true)),
        )
        .select(thread_user_states::uid)
        .load(conn)
}

/// Seek thread roots using the partial (chat_id, id) browse index.
/// Deleted roots remain visible while they have surviving replies, as in the inbox.
pub fn get_chat_threads(
    conn: &mut PgConnection,
    chat_id: i64,
    cursor: Option<i64>,
    order: crate::dto::threads::ThreadOrder,
    limit: i64,
) -> QueryResult<Vec<Message>> {
    use crate::dto::threads::ThreadOrder;

    let mut query = messages::table
        .filter(messages::chat_id.eq(chat_id))
        .filter(messages::reply_root_id.is_null())
        .filter(messages::has_thread.eq(true))
        .filter(messages::is_published.eq(true))
        .into_boxed();
    if let Some(cursor) = cursor {
        query = match order {
            ThreadOrder::Oldest => query.filter(messages::id.gt(cursor)),
            ThreadOrder::Newest => query.filter(messages::id.lt(cursor)),
        };
    }
    query = match order {
        ThreadOrder::Oldest => query.order(messages::id.asc()),
        ThreadOrder::Newest => query.order(messages::id.desc()),
    };
    query.limit(limit).select(Message::as_select()).load(conn)
}

/// Participants are authors, not subscribers. Match the inbox definition:
/// root author plus authors of surviving published replies, deduplicated by UID.
pub fn get_thread_participant_uids(
    conn: &mut PgConnection,
    thread_root_id: i64,
    cursor: Option<i32>,
    limit: i64,
) -> QueryResult<Vec<i32>> {
    let mut replies = messages::table
        .filter(messages::reply_root_id.eq(thread_root_id))
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .into_boxed();
    let mut root = messages::table
        .filter(messages::id.eq(thread_root_id))
        .filter(messages::reply_root_id.is_null())
        .filter(messages::has_thread.eq(true))
        .filter(messages::is_published.eq(true))
        .into_boxed();
    if let Some(cursor) = cursor {
        replies = replies.filter(messages::sender_uid.gt(cursor));
        root = root.filter(messages::sender_uid.gt(cursor));
    }
    replies
        .select(messages::sender_uid)
        .distinct()
        .order(messages::sender_uid.asc())
        .limit(limit)
        .union(root.select(messages::sender_uid))
        .positional_order_by(1)
        .limit(limit)
        .load(conn)
}

// --- thread_meta maintenance ---

/// Upsert thread_meta after a new reply is created.
pub fn increment_thread_meta(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    reply_at: DateTime<Utc>,
) -> Result<(), diesel::result::Error> {
    diesel::insert_into(thread_meta::table)
        .values((
            thread_meta::chat_id.eq(chat_id),
            thread_meta::thread_root_id.eq(thread_root_id),
            thread_meta::reply_count.eq(1i64),
            thread_meta::last_reply_at.eq(Some(reply_at)),
        ))
        .on_conflict((thread_meta::chat_id, thread_meta::thread_root_id))
        .do_update()
        .set((
            thread_meta::reply_count.eq(thread_meta::reply_count + 1),
            thread_meta::last_reply_at.eq(Some(reply_at)),
        ))
        .execute(conn)?;
    Ok(())
}

/// Recalculate thread_meta from messages after a reply is deleted.
pub fn recalculate_thread_meta(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
) -> Result<(), diesel::result::Error> {
    let stats: Option<(i64, Option<DateTime<Utc>>)> = messages::table
        .filter(
            messages::reply_root_id
                .eq(thread_root_id)
                .and(messages::deleted_at.is_null())
                .and(messages::is_published.eq(true)),
        )
        .select((
            diesel::dsl::count_star(),
            diesel::dsl::max(messages::created_at),
        ))
        .first(conn)
        .optional()?;

    match stats {
        Some((count, last_at)) if count > 0 => {
            diesel::insert_into(thread_meta::table)
                .values((
                    thread_meta::chat_id.eq(chat_id),
                    thread_meta::thread_root_id.eq(thread_root_id),
                    thread_meta::reply_count.eq(count),
                    thread_meta::last_reply_at.eq(last_at),
                ))
                .on_conflict((thread_meta::chat_id, thread_meta::thread_root_id))
                .do_update()
                .set((
                    thread_meta::reply_count.eq(count),
                    thread_meta::last_reply_at.eq(last_at),
                ))
                .execute(conn)?;
        }
        _ => {
            // No active replies — remove the meta row and reset has_thread
            diesel::delete(
                thread_meta::table.filter(
                    thread_meta::chat_id
                        .eq(chat_id)
                        .and(thread_meta::thread_root_id.eq(thread_root_id)),
                ),
            )
            .execute(conn)?;

            diesel::update(messages::table.filter(messages::id.eq(thread_root_id)))
                .set(messages::has_thread.eq(false))
                .execute(conn)?;
        }
    }

    Ok(())
}

pub fn build_thread_update_payload(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
) -> Result<Option<ThreadUpdatePayload>, diesel::result::Error> {
    let root_created_at = messages::table
        .filter(
            messages::id
                .eq(thread_root_id)
                .and(messages::chat_id.eq(chat_id))
                .and(messages::reply_root_id.is_null())
                .and(messages::is_published.eq(true)),
        )
        .select(messages::created_at)
        .first::<DateTime<Utc>>(conn)
        .optional()?;

    let Some(root_created_at) = root_created_at else {
        return Ok(None);
    };

    let meta_row = thread_meta::table
        .filter(
            thread_meta::chat_id
                .eq(chat_id)
                .and(thread_meta::thread_root_id.eq(thread_root_id)),
        )
        .select((thread_meta::reply_count, thread_meta::last_reply_at))
        .first::<(i64, Option<DateTime<Utc>>)>(conn)
        .optional()?;

    let (reply_count, last_reply_at) = match meta_row {
        Some((reply_count, last_reply_at)) => {
            (reply_count, last_reply_at.unwrap_or(root_created_at))
        }
        None => (0, root_created_at),
    };

    Ok(Some(ThreadUpdatePayload {
        thread_root_id,
        chat_id,
        last_reply_at,
        reply_count,
    }))
}

pub fn broadcast_thread_update_to_uids(
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
    target_uids: &[i32],
    chat_id: i64,
    thread_root_id: i64,
) -> Result<(), diesel::result::Error> {
    if target_uids.is_empty() {
        return Ok(());
    }

    if let Some(payload) = build_thread_update_payload(conn, chat_id, thread_root_id)? {
        let msg = Arc::new(ServerWsMessage::ThreadUpdate(payload));
        ws_registry.broadcast_to_uids(target_uids, msg);
    }

    Ok(())
}

pub fn broadcast_thread_update_to_subscribers(
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
    chat_id: i64,
    thread_root_id: i64,
) -> Result<(), diesel::result::Error> {
    let subscriber_uids = get_thread_subscriber_uids(conn, chat_id, thread_root_id)?;
    broadcast_thread_update_to_uids(conn, ws_registry, &subscriber_uids, chat_id, thread_root_id)
}

pub fn broadcast_thread_membership_changed_to_user(
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
) -> Result<(), diesel::result::Error> {
    let (archived, subscribed) =
        get_subscription_state(conn, chat_id, thread_root_id, uid)?.unwrap_or((false, false));
    let msg = Arc::new(ServerWsMessage::ThreadMembershipChanged(
        ThreadMembershipChangedPayload {
            status: Some(crate::dto::threads::ThreadSubscriptionStatusResponse {
                subscribed,
                archived,
            }),
            thread_root_id,
            chat_id,
        },
    ));
    ws_registry.broadcast_to_uids(&[uid], msg);
    Ok(())
}

#[derive(QueryableByName)]
#[diesel(table_name = thread_user_states)]
pub struct ThreadListRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pub chat_id: i64,
    #[diesel(sql_type = crate::schema::sql_types::GroupKind)]
    pub chat_kind: GroupKind,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pub thread_root_id: i64,
    #[diesel(sql_type = diesel::sql_types::Text)]
    pub chat_name: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    pub chat_avatar_key: Option<String>,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pub reply_count: i64,
    #[diesel(sql_type = diesel::sql_types::Timestamptz)]
    pub last_reply_at: DateTime<Utc>,
    #[diesel(sql_type = diesel::sql_types::Timestamptz)]
    pub subscribed_at: DateTime<Utc>,
    #[diesel(sql_type = diesel::sql_types::Bool)]
    pub archived: bool,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::BigInt>)]
    pub last_read_message_id: Option<i64>,
}

/// List threads the user is subscribed to, ordered by most recent reply.
pub fn get_user_threads(
    conn: &mut PgConnection,
    uid: i32,
    limit: i64,
    before_cursor: Option<DateTime<Utc>>,
    archived: bool,
    root_id: Option<i64>,
) -> Result<Vec<ThreadListRow>, diesel::result::Error> {
    // Exact root lookups use the existing root and user indexes, without scanning list pages.
    let root_filter = if root_id.is_some() {
        "AND ts.thread_root_id = $5"
    } else {
        ""
    };
    let sql = format!(
        "SELECT
            ts.chat_id,
            g.kind AS chat_kind,
            ts.thread_root_id,
            g.name AS chat_name,
            avatar_media.storage_key AS chat_avatar_key,
            COALESCE(tm.reply_count, 0)::bigint AS reply_count,
            COALESCE(tm.last_reply_at, ts.subscribed_at) AS last_reply_at,
            ts.subscribed_at,
            ts.archived,
            ts.last_read_message_id
        FROM thread_user_states ts
        LEFT JOIN thread_meta tm ON tm.chat_id = ts.chat_id AND tm.thread_root_id = ts.thread_root_id
        JOIN groups g ON g.id = ts.chat_id
        LEFT JOIN media avatar_media ON g.avatar_image_id = avatar_media.id AND avatar_media.deleted_at IS NULL
        JOIN messages root_msg ON root_msg.id = ts.thread_root_id
        WHERE ts.uid = $1
          AND ts.archived = $2
          AND ts.subscribed = TRUE
          {root_filter}
          AND root_msg.reply_root_id IS NULL
          AND root_msg.has_thread = TRUE
          AND root_msg.is_published = TRUE
          AND ($3::timestamptz IS NULL OR COALESCE(tm.last_reply_at, ts.subscribed_at) < $3)
        ORDER BY COALESCE(tm.last_reply_at, ts.subscribed_at) DESC
        LIMIT $4",
    );
    let query = sql_query(sql)
        .bind::<diesel::sql_types::Integer, _>(uid)
        .bind::<diesel::sql_types::Bool, _>(archived)
        .bind::<diesel::sql_types::Nullable<diesel::sql_types::Timestamptz>, _>(before_cursor)
        .bind::<diesel::sql_types::BigInt, _>(limit);

    match root_id {
        Some(id) => query.bind::<diesel::sql_types::BigInt, _>(id).load(conn),
        None => query.load(conn),
    }
}

#[derive(QueryableByName)]
pub struct UnreadThreadSummaryCounts {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pub unread_thread_count: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pub archived_unread_thread_count: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pub unread_message_count: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pub archived_unread_message_count: i64,
}

/// Counts unread subscribed threads and unread replies for the current user.
///
/// Thread counts preserve the historical exact-count behavior. Message counts are badge-style
/// counts capped at `MAX_UNREAD_COUNT`.
pub fn get_unread_summary_counts(
    conn: &mut PgConnection,
    uid: i32,
) -> Result<UnreadThreadSummaryCounts, diesel::result::Error> {
    let query = sql_query(
        "WITH qualified_subscriptions AS MATERIALIZED (
             SELECT ts.thread_root_id, ts.archived,
                    COALESCE(ts.last_read_message_id, 0) AS last_read_message_id
             FROM thread_user_states ts
             JOIN messages root_msg ON root_msg.id = ts.thread_root_id
             WHERE ts.uid = $1
               AND ts.subscribed = TRUE
               AND root_msg.reply_root_id IS NULL
               AND root_msg.has_thread = TRUE
               AND root_msg.is_published = TRUE
         ),
         active_unread_threads AS (
             SELECT 1 AS marker
             FROM qualified_subscriptions ts
             WHERE ts.archived = FALSE
               AND EXISTS (
                 SELECT 1
                 FROM messages m
                 WHERE m.reply_root_id = ts.thread_root_id
                   AND m.deleted_at IS NULL
                   AND m.is_published = TRUE
                   AND m.id > ts.last_read_message_id
               )
         ),
         archived_unread_threads AS (
             SELECT 1 AS marker
             FROM qualified_subscriptions ts
             WHERE ts.archived = TRUE
               AND EXISTS (
                 SELECT 1
                 FROM messages m
                 WHERE m.reply_root_id = ts.thread_root_id
                   AND m.deleted_at IS NULL
                   AND m.is_published = TRUE
                   AND m.id > ts.last_read_message_id
               )
         ),
         active_unread_messages AS (
             SELECT 1
             FROM qualified_subscriptions ts
             JOIN LATERAL (
                 SELECT 1
                 FROM messages m
                 WHERE m.reply_root_id = ts.thread_root_id
                   AND m.deleted_at IS NULL
                   AND m.is_published = TRUE
                   AND m.id > ts.last_read_message_id
                 LIMIT $2
             ) unread_message ON TRUE
             WHERE ts.archived = FALSE
             LIMIT $2
         ),
         archived_unread_messages AS (
             SELECT 1
             FROM qualified_subscriptions ts
             JOIN LATERAL (
                 SELECT 1
                 FROM messages m
                 WHERE m.reply_root_id = ts.thread_root_id
                   AND m.deleted_at IS NULL
                   AND m.is_published = TRUE
                   AND m.id > ts.last_read_message_id
                 LIMIT $2
             ) unread_message ON TRUE
             WHERE ts.archived = TRUE
             LIMIT $2
         )
         SELECT
           (SELECT COUNT(*)::bigint FROM active_unread_threads) AS unread_thread_count,
           (SELECT COUNT(*)::bigint FROM archived_unread_threads) AS archived_unread_thread_count,
           (SELECT COUNT(*)::bigint FROM active_unread_messages) AS unread_message_count,
           (SELECT COUNT(*)::bigint FROM archived_unread_messages) AS archived_unread_message_count",
    )
    .bind::<diesel::sql_types::Integer, _>(uid)
    .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT);

    query.get_result::<UnreadThreadSummaryCounts>(conn)
}

// --- Thread list enrichment types and logic ---

fn attachment_preview_map(atts: Vec<Attachment>) -> HashMap<i64, Vec<MessagePreviewAttachment>> {
    let mut map: HashMap<i64, Vec<MessagePreviewAttachment>> = HashMap::new();
    for att in atts {
        if let Some(msg_id) = att.message_id {
            map.entry(msg_id)
                .or_default()
                .push(MessagePreviewAttachment { kind: att.kind });
        }
    }
    map
}

// Raw row types for batch queries
#[derive(QueryableByName)]
struct ParticipantRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    reply_root_id: i64,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    sender_uid: i32,
}

/// Enrich a list of thread rows with participants, latest replies, user profiles,
/// and assemble the final `ListThreadsResponse`.
///
/// `rows` — the thread subscription rows (already trimmed to the page size).
/// `has_more` — whether there are more results beyond this page.
/// `root_messages` — raw root `Message` rows (no heavy enrichment needed).
/// `media` / `avatars` — URL construction for attachments and user avatars.
pub fn enrich_thread_list(
    conn: &mut PgConnection,
    rows: Vec<ThreadListRow>,
    has_more: bool,
    root_messages: Vec<Message>,
    uid: i32,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<ListThreadsResponse, diesel::result::Error> {
    let root_ids: Vec<i64> = rows.iter().map(|r| r.thread_root_id).collect();

    if root_ids.is_empty() {
        return Ok(ListThreadsResponse {
            threads: vec![],
            next_cursor: None,
        });
    }

    let root_msg_map: HashMap<i64, &Message> = root_messages.iter().map(|m| (m.id, m)).collect();

    // 0. Batch query: unread counts per thread (only for the returned page)
    #[derive(QueryableByName)]
    struct UnreadRow {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        thread_root_id: i64,
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        unread_count: i64,
    }
    let unread_rows: Vec<UnreadRow> = sql_query(
        "SELECT ts.thread_root_id,
                COUNT(unread_messages.marker)::bigint AS unread_count
         FROM thread_user_states ts
         LEFT JOIN LATERAL (
             SELECT 1 AS marker
             FROM messages m
             WHERE m.reply_root_id = ts.thread_root_id
               AND m.deleted_at IS NULL
               AND m.is_published = TRUE
               AND m.id > COALESCE(ts.last_read_message_id, 0)
             LIMIT $4
         ) AS unread_messages ON TRUE
         WHERE ts.uid = $1
           AND ts.archived = $2
           AND ts.thread_root_id = ANY($3)
         GROUP BY ts.thread_root_id",
    )
    .bind::<diesel::sql_types::Integer, _>(uid)
    .bind::<diesel::sql_types::Bool, _>(rows.first().map(|row| row.archived).unwrap_or(false))
    .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(&root_ids)
    .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT)
    .load(conn)?;
    let unread_map: HashMap<i64, i64> = unread_rows
        .into_iter()
        .map(|r| (r.thread_root_id, r.unread_count))
        .collect();

    // 0b. Batch query: unread @mention counts per thread (for the returned page)
    #[derive(QueryableByName)]
    struct UnreadMentionRow {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        thread_root_id: i64,
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        mention_count: i64,
    }
    let mention_rows: Vec<UnreadMentionRow> = sql_query(
        "SELECT mm.thread_root_id,
                COUNT(*)::bigint AS mention_count
         FROM message_mentions mm
         JOIN thread_user_states tus
           ON tus.chat_id = mm.chat_id
          AND tus.thread_root_id = mm.thread_root_id
          AND tus.uid = mm.mentioned_uid
         WHERE mm.mentioned_uid = $1
           AND mm.thread_root_id = ANY($2)
           AND mm.message_id > COALESCE(tus.last_read_message_id, 0)
         GROUP BY mm.thread_root_id",
    )
    .bind::<diesel::sql_types::Integer, _>(uid)
    .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(&root_ids)
    .load(conn)?;
    let mention_map: HashMap<i64, i64> = mention_rows
        .into_iter()
        .map(|r| (r.thread_root_id, r.mention_count.min(MAX_UNREAD_COUNT)))
        .collect();

    // 0c. Batch query: unread-reaction counts per thread (reactions on the
    // user's messages in each thread, aggregated per message; cursor is the
    // per-(thread, user) reaction timestamp). Rows without a thread_user_states
    // row produce no count, mirroring the mention join semantics.
    #[derive(QueryableByName)]
    struct UnreadReactionRow {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        thread_root_id: i64,
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        reaction_count: i64,
    }
    let reaction_rows: Vec<UnreadReactionRow> = sql_query(
        "SELECT my_msgs.thread_root_id,
                COUNT(DISTINCT mr.message_id)::bigint AS reaction_count
         FROM (
             SELECT m.id AS message_id, m.chat_id AS chat_id, m.reply_root_id AS thread_root_id, m.sender_uid
             FROM messages m
             WHERE m.reply_root_id = ANY($2)
               AND m.deleted_at IS NULL
               AND m.is_published = TRUE
               AND m.sender_uid = $1
         ) my_msgs
         JOIN thread_user_states tus
           ON tus.chat_id = my_msgs.chat_id
          AND tus.thread_root_id = my_msgs.thread_root_id
          AND tus.uid = my_msgs.sender_uid
         JOIN message_reactions mr
           ON mr.message_id = my_msgs.message_id
          AND mr.user_uid <> my_msgs.sender_uid
          AND mr.created_at > tus.last_reactions_read_at
         GROUP BY my_msgs.thread_root_id",
    )
    .bind::<diesel::sql_types::Integer, _>(uid)
    .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(&root_ids)
    .load(conn)?;
    let reaction_map: HashMap<i64, i64> = reaction_rows
        .into_iter()
        .map(|r| (r.thread_root_id, r.reaction_count.min(MAX_UNREAD_COUNT)))
        .collect();

    // 1. Batch query: distinct participants per thread (replies + root message author)
    let participant_rows: Vec<ParticipantRow> = sql_query(
        "SELECT DISTINCT reply_root_id, sender_uid FROM (
            SELECT m.reply_root_id, m.sender_uid
            FROM messages m
            WHERE m.reply_root_id = ANY($1)
              AND m.deleted_at IS NULL
              AND m.is_published = TRUE
            UNION ALL
            SELECT root.id AS reply_root_id, root.sender_uid
            FROM messages root
            WHERE root.id = ANY($1)
              AND root.reply_root_id IS NULL
              AND root.has_thread = TRUE
              AND root.is_published = TRUE
         ) combined
         ORDER BY reply_root_id, sender_uid",
    )
    .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(&root_ids)
    .load(conn)?;

    // 2. Batch query: latest reply per thread (DISTINCT ON)
    let latest_reply_rows = messages::table
        .filter(messages::reply_root_id.eq_any(&root_ids))
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .distinct_on(messages::reply_root_id)
        .order((messages::reply_root_id.asc(), messages::id.desc()))
        .select(Message::as_select())
        .load::<Message>(conn)?;
    let forward_origins = crate::services::single_forwarding::ForwardOrigins::load_attribution(
        conn,
        root_messages.iter().chain(latest_reply_rows.iter()),
    )?;

    // 3. Collect ALL UIDs that need profile/avatar lookup in one pass
    let mut all_uids: Vec<i32> = participant_rows.iter().map(|r| r.sender_uid).collect();
    for lr in &latest_reply_rows {
        all_uids.push(lr.sender_uid);
    }
    for msg in &root_messages {
        all_uids.push(msg.sender_uid);
    }

    let mut origin_uids = std::collections::HashSet::new();
    forward_origins.collect_uids(&mut origin_uids);
    all_uids.extend(origin_uids);

    // Pre-scan mentions from both root messages and latest replies
    let mut mention_uids_per_root: HashMap<i64, Vec<i32>> = HashMap::new();
    let mut mention_uids_per_reply: HashMap<i64, Vec<i32>> = HashMap::new();
    for msg in &root_messages {
        if msg.deleted_at.is_some() {
            continue;
        }
        if let Some(ref text) = msg.message {
            let uids = extract_mention_uids(text);
            all_uids.extend(&uids);
            mention_uids_per_root.insert(msg.id, uids);
        }
    }
    for lr in &latest_reply_rows {
        if let Some(ref text) = lr.message {
            let uids = extract_mention_uids(text);
            all_uids.extend(&uids);
            mention_uids_per_reply.insert(lr.id, uids);
        }
    }

    all_uids.sort_unstable();
    all_uids.dedup();

    // Single batched profile + avatar lookup
    let user_profiles = lookup_user_profiles(conn, &all_uids)?;
    let user_avatars = avatars.lookup(&all_uids);

    let make_sender = |uid: i32| -> User { build_sender(uid, &user_avatars, &user_profiles) };

    // 4. Build participants map: thread_root_id -> Vec<User>
    let mut participants_map: HashMap<i64, Vec<User>> = HashMap::new();
    for row in &participant_rows {
        participants_map
            .entry(row.reply_root_id)
            .or_default()
            .push(make_sender(row.sender_uid));
    }

    // 5. Load sticker emoji for root messages and latest replies
    let sticker_ids: Vec<i64> = latest_reply_rows
        .iter()
        .filter_map(|r| r.sticker_id)
        .chain(
            root_messages
                .iter()
                .filter(|m| m.deleted_at.is_none())
                .filter_map(|m| m.sticker_id),
        )
        .collect();
    let sticker_emoji_map: HashMap<i64, String> = if sticker_ids.is_empty() {
        HashMap::new()
    } else {
        stickers::table
            .filter(stickers::id.eq_any(&sticker_ids))
            .select((stickers::id, stickers::emoji))
            .load::<(i64, String)>(conn)
            .unwrap_or_default()
            .into_iter()
            .collect()
    };

    // 6. Batch load first attachment kind for both root messages and latest replies
    let mut attachment_msg_ids: Vec<i64> = latest_reply_rows
        .iter()
        .filter(|r| r.has_attachments)
        .map(|r| r.id)
        .collect();
    for msg in &root_messages {
        if msg.deleted_at.is_none() && msg.has_attachments {
            attachment_msg_ids.push(msg.id);
        }
    }
    let (_first_attachment_map, attachment_preview_all_map): (
        HashMap<i64, String>,
        HashMap<i64, Vec<MessagePreviewAttachment>>,
    ) = if attachment_msg_ids.is_empty() {
        (HashMap::new(), HashMap::new())
    } else {
        let atts: Vec<Attachment> = attachments::table
            .filter(attachments::message_id.eq_any(&attachment_msg_ids))
            .filter(attachments::deleted_at.is_null())
            .order((
                attachments::message_id.asc(),
                attachments::order.asc(),
                attachments::id.asc(),
            ))
            .select(Attachment::as_select())
            .load(conn)
            .unwrap_or_default();
        let preview_map = attachment_preview_map(atts);
        let kind_map: HashMap<i64, String> = preview_map
            .iter()
            .filter_map(|(&msg_id, previews)| previews.first().map(|p| (msg_id, p.kind.clone())))
            .collect();
        (kind_map, preview_map)
    };

    // 7. Build latest reply map
    let mut latest_reply_map: HashMap<i64, MessagePreview> = HashMap::new();
    for lr in latest_reply_rows {
        let Some(thread_root_id) = lr.reply_root_id else {
            continue;
        };
        latest_reply_map.insert(
            thread_root_id,
            build_message_preview(
                MessagePreviewInput {
                    forwarded_from_name: forward_origins.name_for(&lr, &user_profiles),
                    id: lr.id,
                    client_generated_id: lr.client_generated_id,
                    created_at: lr.created_at,
                    sender: make_sender(lr.sender_uid),
                    message: lr.message,
                    message_type: lr.message_type,
                    sticker_id: lr.sticker_id,
                    attachments: attachment_preview_all_map
                        .get(&lr.id)
                        .cloned()
                        .unwrap_or_default(),
                    deleted_at: None,
                    mention_source: None,
                    mention_uids: mention_uids_per_reply.get(&lr.id).cloned(),
                },
                &sticker_emoji_map,
                &user_avatars,
                &user_profiles,
            ),
        );
    }

    // 7. Assemble final response
    let scopes: Vec<(i64, i64)> = rows
        .iter()
        .map(|row| (row.chat_id, row.thread_root_id))
        .collect();
    let peer_receipts = read_receipts::visible_thread_receipts(conn, uid, &scopes)?;
    let next_cursor = if has_more {
        rows.last().map(|r| r.last_reply_at.to_rfc3339())
    } else {
        None
    };

    let threads: Vec<ThreadListItem> = rows
        .into_iter()
        .filter_map(|row| {
            let root_msg = root_msg_map.get(&row.thread_root_id)?;
            let root_preview = build_message_preview(
                MessagePreviewInput {
                    forwarded_from_name: forward_origins.name_for(root_msg, &user_profiles),
                    id: root_msg.id,
                    client_generated_id: root_msg.client_generated_id.clone(),
                    created_at: root_msg.created_at,
                    sender: make_sender(root_msg.sender_uid),
                    message: root_msg.message.clone(),
                    message_type: root_msg.message_type.clone(),
                    sticker_id: root_msg.sticker_id,
                    attachments: if root_msg.deleted_at.is_none() && root_msg.has_attachments {
                        attachment_preview_all_map
                            .get(&root_msg.id)
                            .cloned()
                            .unwrap_or_default()
                    } else {
                        vec![]
                    },
                    deleted_at: root_msg.deleted_at,
                    mention_source: None,
                    mention_uids: mention_uids_per_root.get(&root_msg.id).cloned(),
                },
                &sticker_emoji_map,
                &user_avatars,
                &user_profiles,
            );
            Some(ThreadListItem {
                chat_id: row.chat_id,
                chat_kind: row.chat_kind,
                chat_name: row.chat_name,
                chat_avatar: row
                    .chat_avatar_key
                    .as_deref()
                    .map(|key| media.public_url(key)),
                thread_root_message: root_preview,
                participants: participants_map
                    .remove(&row.thread_root_id)
                    .unwrap_or_default(),
                last_reply: latest_reply_map.remove(&row.thread_root_id),
                reply_count: row.reply_count,
                last_reply_at: row.last_reply_at,
                unread_count: unread_map.get(&row.thread_root_id).copied().unwrap_or(0),
                unread_mentions: mention_map.get(&row.thread_root_id).copied().unwrap_or(0),
                unread_reactions: reaction_map.get(&row.thread_root_id).copied().unwrap_or(0),
                last_read_message_id: row.last_read_message_id,
                peer_last_read_message_id: peer_receipts.get(&row.thread_root_id).copied(),
                subscribed_at: row.subscribed_at,
                archived: row.archived,
            })
        })
        .collect();

    Ok(ListThreadsResponse {
        threads,
        next_cursor,
    })
}

pub fn archive_thread(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<bool, diesel::result::Error> {
    let updated = diesel::update(
        thread_user_states::table.filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::thread_root_id.eq(thread_root_id))
                .and(thread_user_states::uid.eq(uid)),
        ),
    )
    .set(thread_user_states::archived.eq(true))
    .execute(conn)?;
    Ok(updated > 0)
}

pub fn unarchive_thread(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<bool, diesel::result::Error> {
    let updated = diesel::update(
        thread_user_states::table.filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::thread_root_id.eq(thread_root_id))
                .and(thread_user_states::uid.eq(uid)),
        ),
    )
    .set(thread_user_states::archived.eq(false))
    .execute(conn)?;
    Ok(updated > 0)
}

#[cfg(test)]
mod tests {
    use super::attachment_preview_map;
    use crate::dto::messages::MessagePreviewAttachment;
    use crate::models::Attachment;
    use chrono::Utc;

    #[test]
    fn thread_browse_keysets_filter_and_deduplicate_authors() {
        use super::*;
        use crate::dto::threads::ThreadOrder;
        use diesel::connection::SimpleConnection;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id, name) VALUES (9876730000, 'thread-browse'), (9876740000, 'other');
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      created_at, has_thread, is_published, deleted_at)
                 SELECT 9876730000 + n, 9876730000, 1, 'text', 'browse-root-' || n,
                        NOW(), n <> 5, n <> 4, CASE WHEN n = 3 THEN NOW() END
                 FROM generate_series(1, 5) n;
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      created_at, has_thread)
                 VALUES (9876740001, 9876740000, 200, 'text', 'browse-other-root', NOW(), TRUE);
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      created_at, reply_root_id)
                 SELECT 9876731000 + n, 9876730000, n, 'text', 'browse-reply-' || n,
                        NOW(), 9876730001 FROM generate_series(1, 105) n;
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      created_at, reply_root_id, deleted_at, is_published)
                 VALUES (9876732000, 9876730000, 50, 'text', 'browse-duplicate', NOW(), 9876730001, NULL, TRUE),
                        (9876732001, 9876730000, 106, 'text', 'browse-deleted', NOW(), 9876730001, NOW(), TRUE),
                        (9876732002, 9876730000, 107, 'text', 'browse-unpublished', NOW(), 9876730001, NULL, FALSE);
                 INSERT INTO thread_user_states(chat_id, thread_root_id, uid, subscribed)
                 VALUES (9876730000, 9876730001, 108, TRUE);"
            )?;
            let ids = |rows: Vec<Message>| rows.into_iter().map(|m| m.id).collect::<Vec<_>>();
            assert_eq!(
                ids(get_chat_threads(conn, 9876730000, None, ThreadOrder::Newest, 2)?),
                vec![9876730003, 9876730002]
            );
            assert_eq!(
                ids(get_chat_threads(conn, 9876730000, Some(9876730002), ThreadOrder::Newest, 2)?),
                vec![9876730001]
            );
            assert_eq!(
                ids(get_chat_threads(conn, 9876730000, None, ThreadOrder::Oldest, 2)?),
                vec![9876730001, 9876730002]
            );
            assert_eq!(
                ids(get_chat_threads(conn, 9876730000, Some(9876730002), ThreadOrder::Oldest, 2)?),
                vec![9876730003]
            );
            assert_eq!(
                get_thread_participant_uids(conn, 9876730001, None, 100)?,
                (1..=100).collect::<Vec<_>>()
            );
            assert_eq!(
                get_thread_participant_uids(conn, 9876730001, Some(100), 100)?,
                vec![101, 102, 103, 104, 105]
            );
            assert!(get_thread_participant_uids(conn, 9876730001, Some(105), 100)?.is_empty());
            // Deleted roots retain their author, matching the existing inbox contract.
            assert_eq!(get_thread_participant_uids(conn, 9876730003, None, 100)?, vec![1]);
            Err(diesel::result::Error::RollbackTransaction)
        });
        assert!(matches!(
            result,
            Err(diesel::result::Error::RollbackTransaction)
        ));
    }

    fn attachment(id: i64, message_id: i64, kind: &str, order: i16) -> Attachment {
        Attachment {
            id,
            message_id: Some(message_id),
            uploader_uid: Some(1),
            file_name: format!("{id}.bin"),
            kind: kind.to_string(),
            external_reference: format!("attachments/{id}.bin"),
            size: 123,
            created_at: Utc::now(),
            deleted_at: None,
            width: None,
            height: None,
            order,
        }
    }

    #[test]
    fn attachment_preview_map_returns_all_attachments_per_message() {
        let map = attachment_preview_map(vec![
            attachment(2, 10, "image/png", 1),
            attachment(1, 10, "video/mp4", 0),
            attachment(4, 20, "audio/webm", 1),
            attachment(3, 20, "image/jpeg", 0),
        ]);

        let msg10 = map.get(&10).unwrap();
        assert_eq!(msg10.len(), 2);
        assert_eq!(
            msg10,
            &[
                MessagePreviewAttachment {
                    kind: "image/png".to_string()
                },
                MessagePreviewAttachment {
                    kind: "video/mp4".to_string()
                },
            ]
        );

        let msg20 = map.get(&20).unwrap();
        assert_eq!(msg20.len(), 2);
        assert_eq!(
            msg20,
            &[
                MessagePreviewAttachment {
                    kind: "audio/webm".to_string()
                },
                MessagePreviewAttachment {
                    kind: "image/jpeg".to_string()
                },
            ]
        );
    }

    #[tokio::test]
    async fn database_thread_previews_preserve_forward_authors() {
        use super::*;
        use crate::config::MediaConfig;
        use crate::services::avatars::AvatarMetrics;
        use diesel::connection::SimpleConnection;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (76200, 'forward-thread-test'), (76300, 'source');
             INSERT INTO discuz.common_member(uid, username, loginname)
             VALUES (76200, 'forwarder', 'forwarder'), (76201, 'root author', 'root-author'),
                    (76202, 'reply author', 'reply-author');
             INSERT INTO group_membership(chat_id, uid) VALUES (76200, 76200);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at)
             VALUES (76301, 76300, 76201, 'text', 'root', 'thread-origin-root', NOW()),
                    (76302, 76300, 76202, 'text', 'reply', 'thread-origin-reply', NOW());
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, forwarded_from_message_id,
                                  reply_root_id, has_thread)
             VALUES (76201, 76200, 76200, 'text', 'root', 'thread-copy-root', NOW(), 76301, NULL, true),
                    (76202, 76200, 76200, 'text', 'reply', 'thread-copy-reply', NOW(), 76302, 76201, false);
             INSERT INTO thread_user_states(chat_id, thread_root_id, uid, subscribed)
             VALUES (76200, 76201, 76200, true);",
        ).unwrap();
        let media = MediaStore::new(
            aws_sdk_s3::Client::from_conf(
                aws_sdk_s3::Config::builder()
                    .behavior_version_latest()
                    .build(),
            ),
            Arc::new(MediaConfig {
                bucket: "test".into(),
                attachment_prefix: "attachments".into(),
                base_url: None,
                endpoint_url: None,
                max_attachment_file_size_bytes: 1,
            }),
        );
        let avatars = AvatarService::new(
            None,
            Arc::new(AvatarMetrics::new(&prometheus::Registry::new())),
        );
        let load = |conn: &mut PgConnection| {
            let roots = messages::table
                .filter(messages::id.eq(76201))
                .select(Message::as_select())
                .load(conn)
                .unwrap();
            let rows = get_user_threads(conn, 76200, 20, None, false, None).unwrap();
            enrich_thread_list(conn, rows, false, roots, 76200, &media, &avatars)
                .unwrap()
                .threads
                .remove(0)
        };
        let thread = load(&mut conn);
        assert_eq!(
            thread.thread_root_message.forwarded_from_name.as_deref(),
            Some("root author")
        );
        assert_eq!(
            thread.last_reply.unwrap().forwarded_from_name.as_deref(),
            Some("reply author")
        );

        // Attribution survives source deletion, and never changes the copy's sender.
        conn.batch_execute("UPDATE messages SET deleted_at = NOW() WHERE chat_id = 76300;")
            .unwrap();
        let thread = load(&mut conn);
        assert_eq!(thread.thread_root_message.sender.uid, 76200);
        assert_eq!(
            thread.thread_root_message.forwarded_from_name.as_deref(),
            Some("root author")
        );
        assert_eq!(
            thread.last_reply.unwrap().forwarded_from_name.as_deref(),
            Some("reply author")
        );

        // Redact a deleted root; an ordinary latest reply has no attribution.
        conn.batch_execute(
            "UPDATE messages SET deleted_at = NOW() WHERE id = 76201;
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, reply_root_id)
             VALUES (76203, 76200, 76200, 'text', 'ordinary reply', 'thread-ordinary-reply', NOW(), 76201);",
        ).unwrap();
        let thread = load(&mut conn);
        assert!(thread.thread_root_message.is_deleted);
        assert!(thread.thread_root_message.forwarded_from_name.is_none());
        let reply = thread.last_reply.unwrap();
        assert_eq!(reply.id, 76203);
        assert!(reply.forwarded_from_name.is_none());
        conn.batch_execute("ROLLBACK").unwrap();
    }
}
