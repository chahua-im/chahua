use chrono::{DateTime, Utc};
use diesel::prelude::*;
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
use crate::handlers::chats::{
    build_message_preview, build_sender, extract_mention_uids, MessagePreviewInput,
};
use crate::models::{Attachment, Message, MessageType};
use crate::schema::{attachments, messages, stickers, thread_meta, thread_user_states};
use crate::services::media::build_public_object_url;
use crate::services::user::{lookup_user_avatars, lookup_user_profiles};
use crate::services::ws_registry::ConnectionRegistry;
use crate::AppState;
use std::sync::Arc;

/// Insert a subscription if one doesn't exist (auto-subscribe on participation).
pub fn ensure_thread_subscription(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<bool, diesel::result::Error> {
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
/// Ensure a row exists for read-position tracking (subscribed=false, for browsing users).
pub fn ensure_thread_user_state(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<bool, diesel::result::Error> {
    let inserted = diesel::insert_into(thread_user_states::table)
        .values((
            thread_user_states::chat_id.eq(chat_id),
            thread_user_states::thread_root_id.eq(thread_root_id),
            thread_user_states::uid.eq(uid),
            thread_user_states::subscribed_at.eq(DateTime::UNIX_EPOCH),
            thread_user_states::archived.eq(false),
            thread_user_states::subscribed.eq(false),
        ))
        .on_conflict_do_nothing()
        .execute(conn)?;
    Ok(inserted > 0)
}
pub fn subscribe_to_thread(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<bool, diesel::result::Error> {
    let existing = get_subscription_state(conn, chat_id, thread_root_id, uid)?;

    if let Some((archived, subscribed)) = existing {
        if !archived && subscribed {
            return Ok(false);
        }

        // Either archived or unsubscribed — re-activate
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
            thread_user_states::archived.eq(false),
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
    let _ = mark_thread_as_read(conn, chat_id, thread_root_id, uid, message_id)?;
    let last_read_message_id = get_thread_last_read_message_id(conn, chat_id, thread_root_id, uid)?;
    let unread_count = get_thread_unread_count(conn, thread_root_id, uid, last_read_message_id)?;

    Ok(ThreadReadState {
        last_read_message_id,
        unread_count,
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
            // No active replies — remove the meta row
            diesel::delete(
                thread_meta::table.filter(
                    thread_meta::chat_id
                        .eq(chat_id)
                        .and(thread_meta::thread_root_id.eq(thread_root_id)),
                ),
            )
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
                .and(messages::has_thread.eq(true))
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
    ws_registry: &Arc<ConnectionRegistry>,
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
) {
    let msg = Arc::new(ServerWsMessage::ThreadMembershipChanged(
        ThreadMembershipChangedPayload {
            thread_root_id,
            chat_id,
        },
    ));
    ws_registry.broadcast_to_uids(&[uid], msg);
}

#[derive(QueryableByName)]
#[diesel(table_name = thread_user_states)]
pub struct ThreadListRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pub chat_id: i64,
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
) -> Result<Vec<ThreadListRow>, diesel::result::Error> {
    let query = sql_query(
        "SELECT
            ts.chat_id,
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
          AND root_msg.reply_root_id IS NULL
          AND root_msg.has_thread = TRUE
          AND root_msg.is_published = TRUE
          AND ($3::timestamptz IS NULL OR COALESCE(tm.last_reply_at, ts.subscribed_at) < $3)
        ORDER BY COALESCE(tm.last_reply_at, ts.subscribed_at) DESC
        LIMIT $4",
    )
    .bind::<diesel::sql_types::Integer, _>(uid)
    .bind::<diesel::sql_types::Bool, _>(archived)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::Timestamptz>, _>(before_cursor)
    .bind::<diesel::sql_types::BigInt, _>(limit);

    query.load::<ThreadListRow>(conn)
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
/// `state` — application state (for avatar URLs, S3 URLs, etc.).
pub fn enrich_thread_list(
    conn: &mut PgConnection,
    rows: Vec<ThreadListRow>,
    has_more: bool,
    root_messages: Vec<Message>,
    uid: i32,
    state: &AppState,
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
    #[derive(QueryableByName)]
    struct LatestReplyRow {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        reply_root_id: i64,
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        id: i64,
        #[diesel(sql_type = diesel::sql_types::Text)]
        client_generated_id: String,
        #[diesel(sql_type = diesel::sql_types::Timestamptz)]
        created_at: DateTime<Utc>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
        message: Option<String>,
        #[diesel(sql_type = crate::schema::sql_types::MessageType)]
        message_type: MessageType,
        #[diesel(sql_type = diesel::sql_types::Integer)]
        sender_uid: i32,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::BigInt>)]
        sticker_id: Option<i64>,
        #[diesel(sql_type = diesel::sql_types::Bool)]
        has_attachments: bool,
    }
    let latest_reply_rows: Vec<LatestReplyRow> = sql_query(
        "SELECT DISTINCT ON (m.reply_root_id)
            m.reply_root_id, m.id, m.client_generated_id, m.created_at, m.message, m.message_type,
            m.sender_uid, m.sticker_id, m.has_attachments
         FROM messages m
         WHERE m.reply_root_id = ANY($1)
           AND m.deleted_at IS NULL
           AND m.is_published = TRUE
         ORDER BY m.reply_root_id, m.id DESC",
    )
    .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(&root_ids)
    .load(conn)?;

    // 3. Collect ALL UIDs that need profile/avatar lookup in one pass
    let mut all_uids: Vec<i32> = participant_rows.iter().map(|r| r.sender_uid).collect();
    for lr in &latest_reply_rows {
        all_uids.push(lr.sender_uid);
    }
    for msg in &root_messages {
        all_uids.push(msg.sender_uid);
    }

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
            mention_uids_per_reply.insert(lr.reply_root_id, uids);
        }
    }

    all_uids.sort_unstable();
    all_uids.dedup();

    // Single batched profile + avatar lookup
    let user_profiles = lookup_user_profiles(conn, &all_uids)?;
    let user_avatars = lookup_user_avatars(state, &all_uids);

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
        latest_reply_map.insert(
            lr.reply_root_id,
            build_message_preview(
                MessagePreviewInput {
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
                    mention_uids: mention_uids_per_reply.get(&lr.reply_root_id).cloned(),
                },
                &sticker_emoji_map,
                &user_avatars,
                &user_profiles,
            ),
        );
    }

    // 7. Assemble final response
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
                chat_name: row.chat_name,
                chat_avatar: row
                    .chat_avatar_key
                    .as_deref()
                    .map(|key| build_public_object_url(state, key)),
                thread_root_message: root_preview,
                participants: participants_map
                    .remove(&row.thread_root_id)
                    .unwrap_or_default(),
                last_reply: latest_reply_map.remove(&row.thread_root_id),
                reply_count: row.reply_count,
                last_reply_at: row.last_reply_at,
                unread_count: unread_map.get(&row.thread_root_id).copied().unwrap_or(0),
                last_read_message_id: row.last_read_message_id,
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

    fn attachment(id: i64, message_id: i64, kind: &str, order: i16) -> Attachment {
        Attachment {
            id,
            message_id: Some(message_id),
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
}
