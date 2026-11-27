//! Main-chat unread counts share the latest `MAX_UNREAD_COUNT` eligible live IDs
//! per chat, membership-message visibility variant, and database revision.
//! Descending-order binary search gives exact counts below the cap and saturated
//! counts for older cursors, without retaining message history per user.
//!
//! Every request validates revisions in a batch. A missing window loads its IDs
//! and revision in one SQL snapshot; changed revisions reload the entire bounded
//! window, including after deletion or delayed publication. Notifications are not
//! required for cache correctness. The cache has a 64 MiB weighted eviction budget
//! for ID storage plus estimated entry overhead; in-flight loads are separate.
//! Transactions and unversioned scopes bypass shared windows. Thread, mention,
//! and reaction counts use their own query paths.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use diesel::connection::{AnsiTransactionManager, TransactionManager};
use diesel::prelude::*;
use diesel::result::Error as DieselError;
use diesel::sql_query;
use diesel::PgConnection;
use moka::sync::Cache;

use crate::constants::MAX_UNREAD_COUNT;
use crate::models::GroupKind;
use crate::schema::{group_membership, groups};
use crate::services::notification_preferences::{
    load_notification_defaults, load_notification_defaults_for_users, ChatNotificationSetting,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatUnreadMembership {
    pub chat_id: i64,
    pub last_read_message_id: Option<i64>,
    pub archived: bool,
    pub is_muted: bool,
    pub hide_membership_messages: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserChatUnreadMembership {
    pub uid: i32,
    pub chat_id: i64,
    pub last_read_message_id: Option<i64>,
    pub archived: bool,
    pub is_muted: bool,
    pub hide_membership_messages: bool,
    pub show_unread_message_count: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadSummaryCounts {
    pub unread_count: i64,
    pub archived_unread_count: i64,
    pub unread_chat_count: i64,
    pub archived_unread_chat_count: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct ChatUnreadCursor {
    pub(super) hide_membership_messages: bool,
    pub(super) chat_id: i64,
    pub(super) last_read_message_id: i64,
}

#[derive(diesel::QueryableByName)]
struct ChatUnreadCountRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    chat_id: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    last_read_message_id: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    unread_count: i64,
}

#[derive(diesel::QueryableByName)]
struct ChatUnreadWindowRow {
    #[diesel(sql_type = diesel::sql_types::Array<diesel::sql_types::BigInt>)]
    ids: Vec<i64>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::BigInt>)]
    revision: Option<i64>,
}

pub struct UnreadService {
    // Immutable descending live-ID windows shared across every user's cursor.
    // Revision keys prevent a late load from replacing a newer snapshot.
    windows: Cache<(i64, bool, i64), Arc<[i64]>>,
    single_flight: Cache<(i64, bool), Arc<Mutex<()>>>,
}

impl Default for UnreadService {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(diesel::QueryableByName)]
struct ChatRevisionRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    chat_id: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    revision: i64,
}

#[derive(diesel::QueryableByName)]
struct UnreadMentionCountRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    chat_id: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    mention_count: i64,
}

#[derive(diesel::QueryableByName)]
struct UnreadReactionCountRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    chat_id: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    reaction_count: i64,
}

#[derive(diesel::QueryableByName)]
struct ReactionTotalRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    reaction_count: i64,
}

/// Shared filter for the unread-reaction queries: reactions on the user's
/// non-deleted, published messages in one chat, excluding self-reactions.
/// `$1` = uid, `$2` = chat id.
const UNREAD_REACTIONS_FILTER: &str = "FROM message_reactions mr
    JOIN messages m ON m.id = mr.message_id
    WHERE mr.message_author_uid = $1
      AND mr.user_uid <> $1
      AND m.chat_id = $2
      AND m.deleted_at IS NULL
      AND m.is_published = TRUE";

/// Main-scope tail (reactions on top-level messages), cursor from the chat
/// membership row.
const UNREAD_REACTIONS_MAIN_TAIL: &str = "AND m.reply_root_id IS NULL
    AND mr.created_at > COALESCE((
        SELECT gm.last_reactions_read_at
        FROM group_membership gm
        WHERE gm.chat_id = $2 AND gm.uid = $1
    ), '-infinity'::timestamptz)";

/// Thread-scope tail (reactions on the user's messages in thread `$3`),
/// cursor from the per-thread user state row.
const UNREAD_REACTIONS_THREAD_TAIL: &str = "AND m.reply_root_id = $3
    AND mr.created_at > COALESCE((
        SELECT tus.last_reactions_read_at
        FROM thread_user_states tus
        WHERE tus.chat_id = $2 AND tus.thread_root_id = $3 AND tus.uid = $1
    ), '-infinity'::timestamptz)";

#[derive(diesel::QueryableByName)]
struct UnreadReactionIdRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    message_id: i64,
}

#[derive(diesel::QueryableByName)]
struct MentionScopeCount {
    #[diesel(sql_type = crate::schema::sql_types::GroupKind)]
    kind: crate::models::GroupKind,
    #[diesel(sql_type = diesel::sql_types::Bool)]
    archived: bool,
    #[diesel(sql_type = diesel::sql_types::Bool)]
    is_thread: bool,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    count: i64,
}

fn mention_summary(
    rows: Vec<MentionScopeCount>,
) -> (
    i64,
    crate::dto::chats::MentionBadges,
    crate::dto::chats::MentionBadges,
) {
    let mut active = crate::dto::chats::MentionBadges::default();
    let mut archived = crate::dto::chats::MentionBadges::default();
    let mut total: i64 = 0;
    for row in rows {
        total = total.saturating_add(row.count).min(MAX_UNREAD_COUNT);
        let badges = if row.archived {
            &mut archived
        } else {
            &mut active
        };
        if row.is_thread {
            badges.threads |= row.count > 0;
        } else {
            match row.kind {
                crate::models::GroupKind::Group => badges.groups |= row.count > 0,
                crate::models::GroupKind::Dm => badges.friends |= row.count > 0,
            }
        }
    }
    (total, active, archived)
}

impl UnreadService {
    pub fn new() -> Self {
        Self {
            windows: Cache::builder()
                .max_capacity(64 * 1024 * 1024)
                .weigher(|_: &(i64, bool, i64), ids: &Arc<[i64]>| {
                    (std::mem::size_of_val(ids.as_ref()) + 64) as u32
                })
                .build(),
            single_flight: Cache::new(10_000),
        }
    }

    /// Counts visible top-level messages newer than this chat cursor. A missing
    /// cursor is represented by `i64::MIN`, because real message IDs are positive.
    pub fn count_chat_unread(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        last_read_message_id: Option<i64>,
    ) -> Result<i64, DieselError> {
        let hide_membership_messages =
            crate::services::system_messages::load_membership_message_filter(conn, uid, chat_id)?;
        Ok(self
            .count_chat_unread_cursors(
                conn,
                [ChatUnreadCursor {
                    hide_membership_messages,
                    chat_id,
                    last_read_message_id: unread_cursor(last_read_message_id),
                }],
            )?
            .get(&ChatUnreadCursor {
                hide_membership_messages,
                chat_id,
                last_read_message_id: unread_cursor(last_read_message_id),
            })
            .copied()
            .unwrap_or(0))
    }

    pub fn count_membership_unreads(
        &self,
        conn: &mut PgConnection,
        memberships: &[ChatUnreadMembership],
    ) -> Result<HashMap<i64, i64>, DieselError> {
        let counts = self.count_chat_unread_cursors(
            conn,
            memberships.iter().map(|membership| ChatUnreadCursor {
                hide_membership_messages: membership.hide_membership_messages,
                chat_id: membership.chat_id,
                last_read_message_id: unread_cursor(membership.last_read_message_id),
            }),
        )?;
        Ok(memberships
            .iter()
            .map(|membership| {
                (
                    membership.chat_id,
                    counts
                        .get(&ChatUnreadCursor {
                            hide_membership_messages: membership.hide_membership_messages,
                            chat_id: membership.chat_id,
                            last_read_message_id: unread_cursor(membership.last_read_message_id),
                        })
                        .copied()
                        .unwrap_or(0),
                )
            })
            .collect())
    }

    pub fn count_user_unread_summary(
        &self,
        conn: &mut PgConnection,
        uid: i32,
    ) -> Result<UnreadSummaryCounts, DieselError> {
        let memberships = Self::load_user_chat_memberships(conn, uid)?;
        self.count_membership_unread_summary(conn, &memberships)
    }

    /// Preference-selected Main badge for APNs; excludes archived/muted chats and all replies.
    pub fn count_users_app_badges(
        &self,
        conn: &mut PgConnection,
        target_uids: &[i32],
    ) -> Result<HashMap<i32, i64>, DieselError> {
        let memberships = Self::load_users_chat_memberships(conn, target_uids)?;
        self.count_user_membership_app_badges(conn, target_uids, &memberships)
    }

    /// Per-chat unread @mention counts (main scope, non-thread messages) for a user.
    ///
    /// Unlike `unread_count`, mention counts deliberately include muted (and archived)
    /// chats: a mention is a direct call-out that pierces mute and lights the global
    /// mention badge.
    pub fn count_chat_unread_mentions_for_memberships(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        memberships: &[ChatUnreadMembership],
    ) -> Result<HashMap<i64, i64>, DieselError> {
        if memberships.is_empty() {
            return Ok(HashMap::new());
        }
        // LATERAL keeps each probe within the existing mention cursor index.
        let rows = sql_query(
            "SELECT gm.chat_id, counts.mention_count
             FROM group_membership gm
             CROSS JOIN LATERAL (
                 SELECT COUNT(*)::BIGINT AS mention_count FROM (
                     SELECT 1 FROM message_mentions mm
                     WHERE mm.mentioned_uid = gm.uid AND mm.chat_id = gm.chat_id
                       AND mm.thread_root_id IS NULL
                       AND mm.message_id > COALESCE(gm.last_read_message_id, 0)
                     ORDER BY mm.thread_root_id, mm.message_id LIMIT $3
                 ) unread
             ) counts
             WHERE gm.uid = $1 AND gm.chat_id = ANY($2) AND counts.mention_count > 0",
        )
        .bind::<diesel::sql_types::Integer, _>(uid)
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(
            memberships.iter().map(|m| m.chat_id).collect::<Vec<_>>(),
        )
        .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT)
        .load::<UnreadMentionCountRow>(conn)?;
        Ok(rows
            .into_iter()
            .map(|r| (r.chat_id, r.mention_count))
            .collect())
    }

    /// Full category presence, independent of list pagination. Raw SQL keeps each
    /// scope's LATERAL range seek parameterized by its membership/thread cursor:
    /// message_mentions_unread_idx (mentioned_uid, chat_id, thread_root_id,
    /// message_id) skips read history, and the inner LIMIT bounds work before
    /// COUNT. Per-scope caps preserve the capped total without hiding categories.
    /// Keep thread_root_id in ORDER BY even for IS NULL to align index ordering.
    pub fn count_user_mention_summary(
        &self,
        conn: &mut PgConnection,
        uid: i32,
    ) -> Result<
        (
            i64,
            crate::dto::chats::MentionBadges,
            crate::dto::chats::MentionBadges,
        ),
        DieselError,
    > {
        let rows = sql_query(
            "SELECT kind, archived, is_thread, SUM(count)::BIGINT AS count
             FROM (
                 SELECT g.kind, gm.archived, FALSE AS is_thread, mentions.count
                 FROM group_membership gm
                 JOIN groups g ON g.id = gm.chat_id
                 CROSS JOIN LATERAL (
                     SELECT COUNT(*)::BIGINT AS count
                     FROM (
                         SELECT 1
                         FROM message_mentions mm
                         WHERE mm.mentioned_uid = gm.uid
                           AND mm.chat_id = gm.chat_id
                           AND mm.thread_root_id IS NULL
                           AND mm.message_id > COALESCE(gm.last_read_message_id, 0)
                         ORDER BY mm.thread_root_id, mm.message_id
                         LIMIT $2
                     ) unread
                 ) mentions
                 WHERE gm.uid = $1
                 UNION ALL
                 SELECT g.kind, ts.archived, TRUE AS is_thread, mentions.count
                 FROM thread_user_states ts
                 JOIN group_membership gm ON gm.chat_id = ts.chat_id AND gm.uid = ts.uid
                 JOIN groups g ON g.id = ts.chat_id
                 JOIN messages root ON root.id = ts.thread_root_id
                 CROSS JOIN LATERAL (
                     SELECT COUNT(*)::BIGINT AS count
                     FROM (
                         SELECT 1
                         FROM message_mentions mm
                         WHERE mm.mentioned_uid = ts.uid
                           AND mm.chat_id = ts.chat_id
                           AND mm.thread_root_id = ts.thread_root_id
                           AND mm.message_id > COALESCE(ts.last_read_message_id, 0)
                         ORDER BY mm.thread_root_id, mm.message_id
                         LIMIT $2
                     ) unread
                 ) mentions
                 WHERE ts.uid = $1 AND ts.subscribed = TRUE
                   AND root.reply_root_id IS NULL
                   AND root.has_thread = TRUE AND root.is_published = TRUE
             ) scopes
             GROUP BY kind, archived, is_thread",
        )
        .bind::<diesel::sql_types::Integer, _>(uid)
        .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT)
        .load::<MentionScopeCount>(conn)?;
        Ok(mention_summary(rows))
    }

    /// Unread @mention count for a single chat, given the user's read pointer.
    ///
    /// `thread_root_id`: `None` counts main-scope mentions (`thread_root_id IS NULL`);
    /// `Some(id)` counts thread-scope mentions. Mirrors `list_chat_unread_mentions`.
    /// Used by the per-chat unread endpoint, the chat mark-as-read response, and
    /// the thread mark-as-read response.
    pub fn count_chat_unread_mentions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        last_read_message_id: Option<i64>,
        thread_root_id: Option<i64>,
    ) -> Result<i64, DieselError> {
        use crate::schema::message_mentions::dsl as mm_dsl;
        let count: i64 = match thread_root_id {
            Some(thread_id) => mm_dsl::message_mentions
                .filter(mm_dsl::mentioned_uid.eq(uid))
                .filter(mm_dsl::chat_id.eq(chat_id))
                .filter(mm_dsl::thread_root_id.eq(thread_id))
                .filter(mm_dsl::message_id.gt(last_read_message_id.unwrap_or(0)))
                .count()
                .get_result(conn)?,
            None => mm_dsl::message_mentions
                .filter(mm_dsl::mentioned_uid.eq(uid))
                .filter(mm_dsl::chat_id.eq(chat_id))
                .filter(mm_dsl::thread_root_id.is_null())
                .filter(mm_dsl::message_id.gt(last_read_message_id.unwrap_or(0)))
                .count()
                .get_result(conn)?,
        };
        Ok(count.min(MAX_UNREAD_COUNT))
    }

    /// Unread @mention message ids for a single chat, newest-first.
    ///
    /// `thread_root_id`: `None` selects main-scope mentions (`thread_root_id IS NULL`);
    /// `Some(id)` selects thread-scope mentions. Mirrors `count_chat_unread_mentions`
    /// but returns ids instead of a count. Served by `message_mentions_unread_idx`.
    pub fn list_chat_unread_mentions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        last_read_message_id: Option<i64>,
        thread_root_id: Option<i64>,
        limit: i64,
    ) -> Result<Vec<i64>, DieselError> {
        use crate::schema::message_mentions::dsl as mm_dsl;

        let read_cursor = last_read_message_id.unwrap_or(0);

        let ids: Vec<i64> = match thread_root_id {
            Some(thread_id) => mm_dsl::message_mentions
                .filter(mm_dsl::mentioned_uid.eq(uid))
                .filter(mm_dsl::chat_id.eq(chat_id))
                .filter(mm_dsl::thread_root_id.eq(thread_id))
                .filter(mm_dsl::message_id.gt(read_cursor))
                .select(mm_dsl::message_id)
                .order(mm_dsl::message_id.desc())
                .limit(limit)
                .load(conn)?,
            None => mm_dsl::message_mentions
                .filter(mm_dsl::mentioned_uid.eq(uid))
                .filter(mm_dsl::chat_id.eq(chat_id))
                .filter(mm_dsl::thread_root_id.is_null())
                .filter(mm_dsl::message_id.gt(read_cursor))
                .select(mm_dsl::message_id)
                .order(mm_dsl::message_id.desc())
                .limit(limit)
                .load(conn)?,
        };

        Ok(ids)
    }

    /// Per-chat unread-reaction counts (main scope: reactions on the user's
    /// top-level messages) for a user, aggregated per message.
    ///
    /// Unread reactions are derived from `message_reactions` (no per-row read
    /// flag): a reaction is unread while `created_at > last_reactions_read_at`.
    /// Self-reactions never count. Like mentions, this deliberately ignores
    /// mute/archive; unlike mentions it is NOT folded into the global unread
    /// message count — it only feeds list badges.
    pub fn count_chat_unread_reactions_for_memberships(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        memberships: &[ChatUnreadMembership],
    ) -> Result<HashMap<i64, i64>, DieselError> {
        if memberships.is_empty() {
            return Ok(HashMap::new());
        }
        // Keep membership estimates out of the reaction/message join: otherwise
        // some pages favor hashing entire chat histories before checking reads.
        // Any unread reaction must be newer than the earliest cursor on this
        // page. Apply that safe bound before loading historical message rows;
        // the per-chat cursor below remains the authoritative read check.
        let rows = sql_query(
            "WITH reacted_messages AS MATERIALIZED (
                 SELECT m.chat_id, mr.message_id, mr.created_at
                 FROM message_reactions mr
                 JOIN messages m ON m.id = mr.message_id
                 WHERE mr.message_author_uid = $1 AND m.chat_id = ANY($2)
                   AND mr.created_at > (
                       SELECT MIN(last_reactions_read_at)
                       FROM group_membership
                       WHERE uid = $1 AND chat_id = ANY($2)
                   )
                   AND mr.user_uid <> $1
                   AND m.deleted_at IS NULL AND m.is_published = TRUE
                   AND m.reply_root_id IS NULL
             )
             SELECT reacted.chat_id, COUNT(DISTINCT reacted.message_id)::BIGINT AS reaction_count
             FROM reacted_messages reacted
             JOIN group_membership gm ON gm.chat_id = reacted.chat_id AND gm.uid = $1
             WHERE reacted.created_at > gm.last_reactions_read_at
             GROUP BY reacted.chat_id",
        )
        .bind::<diesel::sql_types::Integer, _>(uid)
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(
            memberships.iter().map(|m| m.chat_id).collect::<Vec<_>>(),
        )
        .load::<UnreadReactionCountRow>(conn)?;
        Ok(rows
            .into_iter()
            .map(|r| (r.chat_id, r.reaction_count.min(MAX_UNREAD_COUNT)))
            .collect())
    }

    /// Unread-reaction message count for a single chat, aggregated per message.
    ///
    /// `thread_root_id`: `None` counts reactions on the user's top-level
    /// messages (cursor: `group_membership.last_reactions_read_at`);
    /// `Some(id)` counts reactions on the user's messages in that thread
    /// (cursor: `thread_user_states.last_reactions_read_at`). The read cursor
    /// is read here so callers never handle the timestamp.
    pub fn count_chat_unread_reactions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        thread_root_id: Option<i64>,
    ) -> Result<i64, DieselError> {
        let sql = format!(
            "SELECT COUNT(DISTINCT mr.message_id)::BIGINT AS reaction_count {UNREAD_REACTIONS_FILTER} {}",
            match thread_root_id {
                Some(_) => UNREAD_REACTIONS_THREAD_TAIL,
                None => UNREAD_REACTIONS_MAIN_TAIL,
            }
        );
        let row: ReactionTotalRow = match thread_root_id {
            Some(thread_id) => sql_query(&sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::BigInt, _>(thread_id)
                .get_result(conn)?,
            None => sql_query(&sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .get_result(conn)?,
        };
        Ok(row.reaction_count.min(MAX_UNREAD_COUNT))
    }

    /// Capture the boundary and IDs while holding the same lock as reaction writes.
    /// `after` narrows the snapshot without advancing the user's read cursor.
    pub fn snapshot_chat_unread_reactions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        thread_root_id: Option<i64>,
        limit: i64,
        after: Option<DateTime<Utc>>,
    ) -> Result<crate::dto::chats::UnreadReactionIdsResponse, DieselError> {
        conn.transaction(|conn| {
            let read_through = crate::services::reactions::lock_scope(conn, chat_id, uid)?;
            let ids = Self::list_chat_unread_reactions(
                conn,
                uid,
                chat_id,
                thread_root_id,
                limit,
                read_through,
                after,
            )?;
            Ok(crate::dto::chats::UnreadReactionIdsResponse {
                read_through,
                message_ids: ids.into_iter().map(|id| id.to_string()).collect(),
            })
        })
    }

    /// Unread-reaction message ids for a single chat, newest-first, one entry
    /// per message regardless of how many new reactions it carries.
    ///
    /// Same derivation and scope rules as `count_chat_unread_reactions`. The
    /// limit is interpolated instead of bound so both scope variants share one
    /// placeholder layout (`limit` is a validated `i64` from `validate_limit`).
    fn list_chat_unread_reactions(
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        thread_root_id: Option<i64>,
        limit: i64,
        read_through: DateTime<Utc>,
        after: Option<DateTime<Utc>>,
    ) -> Result<Vec<i64>, DieselError> {
        let sql = format!(
            "SELECT DISTINCT mr.message_id AS message_id {UNREAD_REACTIONS_FILTER} {} \
             ORDER BY mr.message_id DESC LIMIT {limit}",
            match thread_root_id {
                Some(_) => format!("{UNREAD_REACTIONS_THREAD_TAIL} AND mr.created_at <= $4 AND mr.created_at > COALESCE($5, '-infinity'::timestamptz)"),
                None => format!("{UNREAD_REACTIONS_MAIN_TAIL} AND mr.created_at <= $3 AND mr.created_at > COALESCE($4, '-infinity'::timestamptz)"),
            }
        );
        let rows: Vec<UnreadReactionIdRow> = match thread_root_id {
            Some(thread_id) => sql_query(&sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::BigInt, _>(thread_id)
                .bind::<diesel::sql_types::Timestamptz, _>(read_through)
                .bind::<diesel::sql_types::Nullable<diesel::sql_types::Timestamptz>, _>(after)
                .load(conn)?,
            None => sql_query(&sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Timestamptz, _>(read_through)
                .bind::<diesel::sql_types::Nullable<diesel::sql_types::Timestamptz>, _>(after)
                .load(conn)?,
        };
        Ok(rows.into_iter().map(|r| r.message_id).collect())
    }

    /// Mark the conversation scope's reactions read (chat-level read state).
    ///
    /// This is the only writer of the reaction cursor now: ordinary message
    /// reads are decoupled. The cursor only advances (`GREATEST`), so a stale or
    /// repeated call is a no-op. Callers must already have authorized `uid` for
    /// the chat and, for a thread scope, for the thread root.
    pub fn acknowledge_chat_unread_reactions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        thread_root_id: Option<i64>,
        read_through: Option<DateTime<Utc>>,
    ) -> Result<i64, DieselError> {
        conn.transaction(|conn| {
            let now = crate::services::reactions::lock_scope(conn, chat_id, uid)?;
            let read_through = read_through.unwrap_or(now).min(now);
            match thread_root_id {
                Some(thread_id) => {
                    let inserted = crate::services::threads::ensure_thread_user_state(
                        conn, chat_id, thread_id, uid, false,
                    )?;
                    sql_query(
                        "UPDATE thread_user_states
                         SET last_reactions_read_at =
                             CASE WHEN $5 THEN $4 ELSE
                             GREATEST(COALESCE(last_reactions_read_at, '-infinity'::timestamptz), $4) END
                         WHERE chat_id = $1 AND thread_root_id = $2 AND uid = $3",
                    )
                    .bind::<diesel::sql_types::BigInt, _>(chat_id)
                    .bind::<diesel::sql_types::BigInt, _>(thread_id)
                    .bind::<diesel::sql_types::Integer, _>(uid)
                    .bind::<diesel::sql_types::Timestamptz, _>(read_through)
                    .bind::<diesel::sql_types::Bool, _>(inserted)
                    .execute(conn)?;
                }
                None => {
                    sql_query(
                        "UPDATE group_membership
                         SET last_reactions_read_at =
                             GREATEST(COALESCE(last_reactions_read_at, '-infinity'::timestamptz), $3)
                         WHERE chat_id = $1 AND uid = $2",
                    )
                    .bind::<diesel::sql_types::BigInt, _>(chat_id)
                    .bind::<diesel::sql_types::Integer, _>(uid)
                    .bind::<diesel::sql_types::Timestamptz, _>(read_through)
                    .execute(conn)?;
                }
            }
            self.count_chat_unread_reactions(conn, uid, chat_id, thread_root_id)
        })
    }

    fn count_membership_unread_summary(
        &self,
        conn: &mut PgConnection,
        memberships: &[ChatUnreadMembership],
    ) -> Result<UnreadSummaryCounts, DieselError> {
        let counts = self.count_chat_unread_cursors(
            conn,
            memberships.iter().map(|membership| ChatUnreadCursor {
                hide_membership_messages: membership.hide_membership_messages,
                chat_id: membership.chat_id,
                last_read_message_id: unread_cursor(membership.last_read_message_id),
            }),
        )?;
        Ok(summarize_membership_unreads(memberships, &counts))
    }

    fn count_user_membership_app_badges(
        &self,
        conn: &mut PgConnection,
        target_uids: &[i32],
        memberships: &[UserChatUnreadMembership],
    ) -> Result<HashMap<i32, i64>, DieselError> {
        let mut totals = HashMap::with_capacity(target_uids.len());
        for uid in target_uids {
            totals.entry(*uid).or_insert(0);
        }

        let counting_memberships = memberships
            .iter()
            .filter(|membership| totals.contains_key(&membership.uid))
            .filter(|membership| !membership.archived)
            .filter(|membership| !membership.is_muted)
            .collect::<Vec<_>>();
        let counts = self.count_chat_unread_cursors(
            conn,
            counting_memberships
                .iter()
                .map(|membership| ChatUnreadCursor {
                    hide_membership_messages: membership.hide_membership_messages,
                    chat_id: membership.chat_id,
                    last_read_message_id: unread_cursor(membership.last_read_message_id),
                }),
        )?;

        for membership in counting_memberships {
            let count = counts
                .get(&ChatUnreadCursor {
                    hide_membership_messages: membership.hide_membership_messages,
                    chat_id: membership.chat_id,
                    last_read_message_id: unread_cursor(membership.last_read_message_id),
                })
                .copied()
                .unwrap_or(0);
            let current = totals.entry(membership.uid).or_insert(0);
            if membership.show_unread_message_count {
                *current = capped_add(*current, count);
            } else if count > 0 {
                *current += 1;
            }
        }

        Ok(totals)
    }

    /// Validate revisions in one batch, then share bounded live-ID windows across
    /// users. Transactions and unversioned scopes retain authoritative SQL counts.
    pub(super) fn count_chat_unread_cursors(
        &self,
        conn: &mut PgConnection,
        cursors: impl IntoIterator<Item = ChatUnreadCursor>,
    ) -> Result<HashMap<ChatUnreadCursor, i64>, DieselError> {
        let mut cursors: Vec<_> = cursors.into_iter().collect();
        cursors.sort_unstable_by_key(|c| {
            (
                c.chat_id,
                c.last_read_message_id,
                c.hide_membership_messages,
            )
        });
        cursors.dedup();
        if cursors.is_empty() {
            return Ok(HashMap::new());
        }
        // Transactions must observe their own writes and must never publish
        // uncommitted counts into the process-wide cache.
        let in_transaction = <AnsiTransactionManager as TransactionManager<PgConnection>>::transaction_manager_status_mut(conn)
            .transaction_depth()?.is_some();
        let revisions: HashMap<_, _> = if in_transaction {
            HashMap::new()
        } else {
            sql_query(
                "SELECT chat_id, revision FROM chat_unread_revisions
                       WHERE chat_id = ANY($1)
                         AND to_regclass('pg_temp.messages') IS NULL
                         AND to_regclass('pg_temp.groups') IS NULL
                         AND pg_current_xact_id_if_assigned() IS NULL",
            )
            .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(
                cursors.iter().map(|c| c.chat_id).collect::<Vec<_>>(),
            )
            .load::<ChatRevisionRow>(conn)?
            .into_iter()
            .map(|row| (row.chat_id, row.revision))
            .collect()
        };
        let mut counts = HashMap::with_capacity(cursors.len());
        let mut misses = Vec::new();
        let mut windows = HashMap::new();
        for cursor in cursors {
            let Some(&revision) = revisions.get(&cursor.chat_id) else {
                misses.push(cursor);
                continue;
            };
            let scope = (cursor.chat_id, cursor.hide_membership_messages);
            let ids = match windows.entry(scope) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(self.chat_unread_window(conn, scope, revision)?)
                }
            };
            counts.insert(
                cursor,
                ids.partition_point(|id| *id > cursor.last_read_message_id) as i64,
            );
        }
        let (hidden, shown): (Vec<_>, Vec<_>) = misses
            .into_iter()
            .partition(|cursor| cursor.hide_membership_messages);
        counts.extend(self.count_chat_unread_cursors_with_filter(conn, hidden, true)?);
        counts.extend(self.count_chat_unread_cursors_with_filter(conn, shown, false)?);
        Ok(counts)
    }

    fn chat_unread_window(
        &self,
        conn: &mut PgConnection,
        scope: (i64, bool),
        revision: i64,
    ) -> Result<Arc<[i64]>, DieselError> {
        let key = (scope.0, scope.1, revision);
        if let Some(ids) = self.windows.get(&key) {
            return Ok(ids);
        }
        let flight = self
            .single_flight
            .get_with(scope, || Arc::new(Mutex::new(())));
        let _guard = flight.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(ids) = self.windows.get(&key) {
            return Ok(ids);
        }
        let predicate = if scope.1 {
            crate::services::system_messages::NON_MEMBERSHIP_PREDICATE
        } else {
            "TRUE"
        };
        // IDs and revision must come from the same statement snapshot. A commit
        // after the revision probe may mean this load observes a newer revision.
        // ARRAY preserves ordering and returns an empty array for an empty chat.
        let row = sql_query(format!(
            "SELECT ARRAY(
                 SELECT id FROM messages
                 WHERE chat_id = $1 AND deleted_at IS NULL AND is_published = TRUE
                   AND reply_root_id IS NULL AND {predicate}
                 ORDER BY id DESC LIMIT $2
             ) AS ids,
             (SELECT revision FROM chat_unread_revisions WHERE chat_id = $1
                AND to_regclass('pg_temp.messages') IS NULL
                AND to_regclass('pg_temp.groups') IS NULL
                AND pg_current_xact_id_if_assigned() IS NULL) AS revision"
        ))
        .bind::<diesel::sql_types::BigInt, _>(scope.0)
        .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT)
        .get_result::<ChatUnreadWindowRow>(conn)?;
        let ids: Arc<[i64]> = row.ids.into();
        if let Some(revision) = row.revision {
            self.windows
                .insert((scope.0, scope.1, revision), ids.clone());
        }
        Ok(ids)
    }

    fn count_chat_unread_cursors_with_filter(
        &self,
        conn: &mut PgConnection,
        mut cursors: Vec<ChatUnreadCursor>,
        hide_membership_messages: bool,
    ) -> Result<HashMap<ChatUnreadCursor, i64>, DieselError> {
        cursors.sort_unstable_by_key(|cursor| (cursor.chat_id, cursor.last_read_message_id));
        cursors.dedup();
        if cursors.is_empty() {
            return Ok(HashMap::new());
        }

        let chat_ids = cursors
            .iter()
            .map(|cursor| cursor.chat_id)
            .collect::<Vec<_>>();
        let last_read_message_ids = cursors
            .iter()
            .map(|cursor| cursor.last_read_message_id)
            .collect::<Vec<_>>();
        let predicate = if hide_membership_messages {
            crate::services::system_messages::NON_MEMBERSHIP_PREDICATE
        } else {
            "TRUE"
        };
        let rows = sql_query(format!(
            "SELECT requested.chat_id, requested.last_read_message_id, counts.unread_count
             FROM UNNEST($1::BIGINT[], $2::BIGINT[])
                 AS requested(chat_id, last_read_message_id)
             CROSS JOIN LATERAL (
                 SELECT COUNT(*)::BIGINT AS unread_count
                 FROM (
                     SELECT 1 FROM messages
                     WHERE chat_id = requested.chat_id
                       AND id > requested.last_read_message_id
                       AND deleted_at IS NULL
                       AND is_published = TRUE
                       AND reply_root_id IS NULL
                       AND (deleted_at IS NULL OR has_thread = true)
                       AND {predicate}
                     ORDER BY id DESC LIMIT $3
                 ) unread
             ) counts",
        ))
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(chat_ids)
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(last_read_message_ids)
        .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT)
        .load::<ChatUnreadCountRow>(conn)?;

        let mut counts = HashMap::with_capacity(rows.len());
        for row in rows {
            let cursor = ChatUnreadCursor {
                hide_membership_messages,
                chat_id: row.chat_id,
                last_read_message_id: row.last_read_message_id,
            };
            counts.insert(cursor, row.unread_count);
        }
        Ok(counts)
    }

    fn load_user_chat_memberships(
        conn: &mut PgConnection,
        uid: i32,
    ) -> Result<Vec<ChatUnreadMembership>, DieselError> {
        let defaults = load_notification_defaults(conn, uid)?;
        let show_membership_messages =
            crate::services::user::load_chat_settings(conn, uid)?.show_membership_messages;
        let now = Utc::now();
        let rows = group_membership::table
            .inner_join(groups::table)
            .filter(group_membership::uid.eq(uid))
            .select((
                group_membership::chat_id,
                group_membership::last_read_message_id,
                group_membership::archived,
                (
                    group_membership::muted_until,
                    group_membership::mute_override,
                ),
                groups::kind,
                crate::services::system_messages::membership_allowed(),
            ))
            .load::<(
                i64,
                Option<i64>,
                bool,
                ChatNotificationSetting,
                GroupKind,
                bool,
            )>(conn)?;
        Ok(rows
            .into_iter()
            .map(
                |(chat_id, last_read_message_id, archived, setting, kind, allowed)| {
                    ChatUnreadMembership {
                        chat_id,
                        last_read_message_id,
                        archived,
                        is_muted: setting.is_muted(kind, defaults, now),
                        hide_membership_messages:
                            crate::services::system_messages::hides_membership_messages(
                                show_membership_messages && allowed,
                                kind,
                                None,
                            ),
                    }
                },
            )
            .collect())
    }

    fn load_users_chat_memberships(
        conn: &mut PgConnection,
        target_uids: &[i32],
    ) -> Result<Vec<UserChatUnreadMembership>, DieselError> {
        if target_uids.is_empty() {
            return Ok(Vec::new());
        }
        let defaults = load_notification_defaults_for_users(conn, target_uids)?;
        let now = Utc::now();
        let rows = group_membership::table
            .inner_join(groups::table)
            .left_join(
                crate::schema::user_extra::table
                    .on(crate::schema::user_extra::uid.eq(group_membership::uid)),
            )
            .filter(group_membership::uid.eq_any(target_uids))
            .select((
                group_membership::uid,
                group_membership::chat_id,
                group_membership::last_read_message_id,
                group_membership::archived,
                (
                    group_membership::muted_until,
                    group_membership::mute_override,
                ),
                groups::kind,
                crate::services::system_messages::membership_allowed(),
                crate::schema::user_extra::show_membership_messages.nullable(),
                crate::schema::user_extra::show_unread_message_count.nullable(),
            ))
            .load::<(
                i32,
                i64,
                Option<i64>,
                bool,
                ChatNotificationSetting,
                GroupKind,
                bool,
                Option<bool>,
                Option<bool>,
            )>(conn)?;
        Ok(rows
            .into_iter()
            .map(
                |(
                    uid,
                    chat_id,
                    last_read_message_id,
                    archived,
                    setting,
                    kind,
                    allowed,
                    show,
                    show_unread_message_count,
                )| {
                    UserChatUnreadMembership {
                        show_unread_message_count: show_unread_message_count.unwrap_or(false),
                        hide_membership_messages:
                            crate::services::system_messages::hides_membership_messages(
                                show.unwrap_or(true) && allowed,
                                kind,
                                None,
                            ),
                        uid,
                        chat_id,
                        last_read_message_id,
                        archived,
                        is_muted: setting.is_muted(
                            kind,
                            defaults.get(&uid).copied().unwrap_or_default(),
                            now,
                        ),
                    }
                },
            )
            .collect())
    }
}

fn capped_add(current: i64, delta: i64) -> i64 {
    current.saturating_add(delta).min(MAX_UNREAD_COUNT)
}

pub(super) fn unread_cursor(last_read_message_id: Option<i64>) -> i64 {
    last_read_message_id.unwrap_or(i64::MIN)
}

fn summarize_membership_unreads(
    memberships: &[ChatUnreadMembership],
    counts: &HashMap<ChatUnreadCursor, i64>,
) -> UnreadSummaryCounts {
    let mut summary = UnreadSummaryCounts {
        unread_count: 0,
        archived_unread_count: 0,
        unread_chat_count: 0,
        archived_unread_chat_count: 0,
    };

    for membership in memberships {
        let count = counts
            .get(&ChatUnreadCursor {
                hide_membership_messages: membership.hide_membership_messages,
                chat_id: membership.chat_id,
                last_read_message_id: unread_cursor(membership.last_read_message_id),
            })
            .copied()
            .unwrap_or(0);
        if membership.archived {
            summary.archived_unread_count = capped_add(summary.archived_unread_count, count);
            if count > 0 {
                summary.archived_unread_chat_count =
                    capped_add(summary.archived_unread_chat_count, 1);
            }
        } else if !membership.is_muted {
            summary.unread_count = capped_add(summary.unread_count, count);
            if count > 0 {
                summary.unread_chat_count = capped_add(summary.unread_chat_count, 1);
            }
        }
    }

    summary
}

#[cfg(test)]
mod tests;
