use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use diesel::prelude::*;
use diesel::result::Error as DieselError;
use diesel::sql_query;
use diesel::PgConnection;

use super::chat_index::{ChatUnreadIndex, ChatUnreadMessageSnapshot};
use crate::constants::{MAX_UNREAD_COUNT, UNREAD_CHAT_INDEX_LOAD_BATCH_SIZE};
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserChatUnreadMembership {
    pub uid: i32,
    pub chat_id: i64,
    pub last_read_message_id: Option<i64>,
    pub archived: bool,
    pub is_muted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadSummaryCounts {
    pub unread_count: i64,
    pub archived_unread_count: i64,
    pub unread_chat_count: i64,
    pub archived_unread_chat_count: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChatUnreadSnapshot {
    chat_id: i64,
    id: i64,
    is_counted: bool,
}

#[derive(Default)]
pub struct UnreadService {
    chats: DashMap<i64, Arc<Mutex<ChatUnreadCacheEntry>>>,
}

#[derive(Debug, Default)]
struct ChatUnreadCacheEntry {
    index: Option<ChatUnreadIndex>,
}

#[derive(diesel::QueryableByName)]
struct ChatUnreadSnapshotRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    chat_id: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    id: i64,
    #[diesel(sql_type = diesel::sql_types::Bool)]
    is_counted: bool,
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
        Self::default()
    }

    pub fn count_chat_unread(
        &self,
        conn: &mut PgConnection,
        chat_id: i64,
        last_read_message_id: Option<i64>,
    ) -> Result<i64, DieselError> {
        self.ensure_chats_loaded(conn, &[chat_id])?;
        Ok(self
            .loaded_chat_unread_count(chat_id, last_read_message_id)
            .unwrap_or(0))
    }

    pub fn count_membership_unreads(
        &self,
        conn: &mut PgConnection,
        memberships: &[ChatUnreadMembership],
    ) -> Result<HashMap<i64, i64>, DieselError> {
        self.count_membership_unreads_with_loader(memberships, |chat_ids| {
            Self::load_chat_unread_snapshots(conn, chat_ids)
        })
    }

    pub fn count_user_unread_summary(
        &self,
        conn: &mut PgConnection,
        uid: i32,
    ) -> Result<UnreadSummaryCounts, DieselError> {
        let memberships = Self::load_user_chat_memberships(conn, uid)?;
        self.count_membership_unread_summary(conn, &memberships)
    }

    pub fn count_users_unread_totals(
        &self,
        conn: &mut PgConnection,
        target_uids: &[i32],
    ) -> Result<HashMap<i32, i64>, DieselError> {
        let memberships = Self::load_users_chat_memberships(conn, target_uids)?;
        self.count_user_membership_unread_totals(conn, target_uids, &memberships)
    }

    /// Per-chat unread @mention counts (main scope, non-thread messages) for a user.
    ///
    /// Unlike `unread_count`, mention counts deliberately include muted (and archived)
    /// chats: a mention is a direct call-out that pierces mute and lights the global
    /// mention badge.
    pub fn count_user_chat_unread_mentions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
    ) -> Result<HashMap<i64, i64>, DieselError> {
        let rows = sql_query(
            "SELECT mm.chat_id AS chat_id, COUNT(*)::BIGINT AS mention_count
             FROM message_mentions mm
             JOIN group_membership gm
               ON gm.chat_id = mm.chat_id AND gm.uid = mm.mentioned_uid
             WHERE mm.mentioned_uid = $1
               AND mm.thread_root_id IS NULL
               AND mm.message_id > COALESCE(gm.last_read_message_id, 0)
             GROUP BY mm.chat_id",
        )
        .bind::<diesel::sql_types::Integer, _>(uid)
        .load::<UnreadMentionCountRow>(conn)?;
        Ok(rows
            .into_iter()
            .map(|r| (r.chat_id, r.mention_count.min(MAX_UNREAD_COUNT)))
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
    pub fn count_user_chat_unread_reactions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
    ) -> Result<HashMap<i64, i64>, DieselError> {
        let rows = sql_query(
            "SELECT m.chat_id AS chat_id, COUNT(DISTINCT mr.message_id)::BIGINT AS reaction_count
             FROM message_reactions mr
             JOIN messages m ON m.id = mr.message_id
             JOIN group_membership gm
               ON gm.chat_id = m.chat_id AND gm.uid = $1
             WHERE mr.message_author_uid = $1
               AND mr.user_uid <> $1
               AND m.deleted_at IS NULL
               AND m.is_published = TRUE
               AND m.reply_root_id IS NULL
               AND mr.created_at > gm.last_reactions_read_at
             GROUP BY m.chat_id",
        )
        .bind::<diesel::sql_types::Integer, _>(uid)
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
    pub fn snapshot_chat_unread_reactions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        thread_root_id: Option<i64>,
        limit: i64,
    ) -> Result<crate::dto::chats::UnreadReactionIdsResponse, DieselError> {
        conn.transaction(|conn| {
            let read_through = crate::services::reactions::lock_scope(conn, chat_id, uid)?;
            let ids = self.list_chat_unread_reactions(
                conn,
                uid,
                chat_id,
                thread_root_id,
                limit,
                read_through,
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
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        thread_root_id: Option<i64>,
        limit: i64,
        read_through: DateTime<Utc>,
    ) -> Result<Vec<i64>, DieselError> {
        let sql = format!(
            "SELECT DISTINCT mr.message_id AS message_id {UNREAD_REACTIONS_FILTER} {} \
             ORDER BY mr.message_id DESC LIMIT {limit}",
            match thread_root_id {
                Some(_) => format!("{UNREAD_REACTIONS_THREAD_TAIL} AND mr.created_at <= $4"),
                None => format!("{UNREAD_REACTIONS_MAIN_TAIL} AND mr.created_at <= $3"),
            }
        );
        let rows: Vec<UnreadReactionIdRow> = match thread_root_id {
            Some(thread_id) => sql_query(&sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::BigInt, _>(thread_id)
                .bind::<diesel::sql_types::Timestamptz, _>(read_through)
                .load(conn)?,
            None => sql_query(&sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Timestamptz, _>(read_through)
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

    pub fn observe_top_level_message(&self, chat_id: i64, message_id: i64, is_counted: bool) {
        self.update_loaded_chat(chat_id, |index| {
            index.observe_message(message_id, is_counted)
        });
    }

    pub fn observe_top_level_message_counted(
        &self,
        chat_id: i64,
        message_id: i64,
        is_counted: bool,
    ) {
        self.update_loaded_chat(chat_id, |index| index.set_counted(message_id, is_counted));
    }

    pub fn invalidate_chat(&self, chat_id: i64) {
        if let Some(entry) = self.loaded_entry(chat_id) {
            Self::lock_entry(&entry).index = None;
        }
    }

    fn count_membership_unreads_with_loader<E>(
        &self,
        memberships: &[ChatUnreadMembership],
        load: impl FnMut(&[i64]) -> Result<Vec<ChatUnreadSnapshot>, E>,
    ) -> Result<HashMap<i64, i64>, E> {
        let chat_ids = memberships
            .iter()
            .map(|membership| membership.chat_id)
            .collect::<Vec<_>>();
        self.ensure_chats_loaded_with_loader(&chat_ids, load)?;

        Ok(memberships
            .iter()
            .map(|membership| {
                (
                    membership.chat_id,
                    self.loaded_chat_unread_count(
                        membership.chat_id,
                        membership.last_read_message_id,
                    )
                    .unwrap_or(0),
                )
            })
            .collect())
    }

    fn count_membership_unread_summary(
        &self,
        conn: &mut PgConnection,
        memberships: &[ChatUnreadMembership],
    ) -> Result<UnreadSummaryCounts, DieselError> {
        self.count_membership_unread_summary_with_loader(memberships, |chat_ids| {
            Self::load_chat_unread_snapshots(conn, chat_ids)
        })
    }

    fn count_membership_unread_summary_with_loader<E>(
        &self,
        memberships: &[ChatUnreadMembership],
        load: impl FnMut(&[i64]) -> Result<Vec<ChatUnreadSnapshot>, E>,
    ) -> Result<UnreadSummaryCounts, E> {
        let counts = self.count_membership_unreads_with_loader(memberships, load)?;

        let mut unread_count = 0;
        let mut archived_unread_count = 0;
        let mut unread_chat_count = 0;
        let mut archived_unread_chat_count = 0;

        for membership in memberships {
            let count = counts.get(&membership.chat_id).copied().unwrap_or(0);
            if membership.archived {
                archived_unread_count = capped_add(archived_unread_count, count);
                if count > 0 {
                    archived_unread_chat_count = capped_add(archived_unread_chat_count, 1);
                }
                continue;
            }

            if membership.is_muted {
                continue;
            }

            unread_count = capped_add(unread_count, count);
            if count > 0 {
                unread_chat_count = capped_add(unread_chat_count, 1);
            }
        }

        Ok(UnreadSummaryCounts {
            unread_count,
            archived_unread_count,
            unread_chat_count,
            archived_unread_chat_count,
        })
    }

    fn count_user_membership_unread_totals(
        &self,
        conn: &mut PgConnection,
        target_uids: &[i32],
        memberships: &[UserChatUnreadMembership],
    ) -> Result<HashMap<i32, i64>, DieselError> {
        self.count_user_membership_unread_totals_with_loader(target_uids, memberships, |chat_ids| {
            Self::load_chat_unread_snapshots(conn, chat_ids)
        })
    }

    fn count_user_membership_unread_totals_with_loader<E>(
        &self,
        target_uids: &[i32],
        memberships: &[UserChatUnreadMembership],
        load: impl FnMut(&[i64]) -> Result<Vec<ChatUnreadSnapshot>, E>,
    ) -> Result<HashMap<i32, i64>, E> {
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

        let chat_ids = counting_memberships
            .iter()
            .map(|membership| membership.chat_id)
            .collect::<Vec<_>>();
        self.ensure_chats_loaded_with_loader(&chat_ids, load)?;

        for membership in counting_memberships {
            let count = self
                .loaded_chat_unread_count(membership.chat_id, membership.last_read_message_id)
                .unwrap_or(0);
            let current = totals.entry(membership.uid).or_insert(0);
            *current = capped_add(*current, count);
        }

        Ok(totals)
    }

    fn ensure_chats_loaded(
        &self,
        conn: &mut PgConnection,
        chat_ids: &[i64],
    ) -> Result<(), DieselError> {
        self.ensure_chats_loaded_with_loader(chat_ids, |chat_ids| {
            Self::load_chat_unread_snapshots(conn, chat_ids)
        })
    }

    fn ensure_chats_loaded_with_loader<E>(
        &self,
        chat_ids: &[i64],
        mut load: impl FnMut(&[i64]) -> Result<Vec<ChatUnreadSnapshot>, E>,
    ) -> Result<(), E> {
        let mut chat_ids = chat_ids.to_vec();
        chat_ids.sort_unstable();
        chat_ids.dedup();

        for chunk in chat_ids.chunks(UNREAD_CHAT_INDEX_LOAD_BATCH_SIZE) {
            let entries = chunk
                .iter()
                .map(|chat_id| (*chat_id, self.entry(*chat_id)))
                .collect::<Vec<_>>();

            let mut missing_entries = Vec::new();
            for (chat_id, entry) in &entries {
                let guard = Self::lock_entry(entry);
                if guard.index.is_none() {
                    missing_entries.push((*chat_id, guard));
                }
            }

            if missing_entries.is_empty() {
                continue;
            }

            let missing_chat_ids = missing_entries
                .iter()
                .map(|(chat_id, _)| *chat_id)
                .collect::<Vec<_>>();
            let mut rows_by_chat_id = group_snapshots_by_chat_id(load(&missing_chat_ids)?);

            for (chat_id, mut guard) in missing_entries {
                let rows = rows_by_chat_id.remove(&chat_id).unwrap_or_default();
                guard.index = Some(ChatUnreadIndex::from_snapshot(
                    rows.into_iter()
                        .map(|row| ChatUnreadMessageSnapshot {
                            id: row.id,
                            countable: row.is_counted,
                        })
                        .collect(),
                ));
            }
        }

        Ok(())
    }

    fn loaded_chat_unread_count(
        &self,
        chat_id: i64,
        last_read_message_id: Option<i64>,
    ) -> Option<i64> {
        let entry = self.loaded_entry(chat_id)?;
        let guard = Self::lock_entry(&entry);
        guard.index.as_ref().map(|index| {
            index
                .count_after(last_read_message_id)
                .min(MAX_UNREAD_COUNT)
        })
    }

    fn update_loaded_chat(&self, chat_id: i64, update: impl FnOnce(&mut ChatUnreadIndex) -> bool) {
        if let Some(entry) = self.loaded_entry(chat_id) {
            let mut guard = Self::lock_entry(&entry);
            if let Some(index) = guard.index.as_mut() {
                if !update(index) {
                    guard.index = None;
                }
            }
        }
    }

    fn entry(&self, chat_id: i64) -> Arc<Mutex<ChatUnreadCacheEntry>> {
        self.chats
            .entry(chat_id)
            .or_insert_with(|| Arc::new(Mutex::new(ChatUnreadCacheEntry::default())))
            .clone()
    }

    fn loaded_entry(&self, chat_id: i64) -> Option<Arc<Mutex<ChatUnreadCacheEntry>>> {
        self.chats.get(&chat_id).map(|entry| entry.clone())
    }

    fn lock_entry(
        entry: &Arc<Mutex<ChatUnreadCacheEntry>>,
    ) -> MutexGuard<'_, ChatUnreadCacheEntry> {
        entry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn load_user_chat_memberships(
        conn: &mut PgConnection,
        uid: i32,
    ) -> Result<Vec<ChatUnreadMembership>, DieselError> {
        let defaults = load_notification_defaults(conn, uid)?;
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
            ))
            .load::<(i64, Option<i64>, bool, ChatNotificationSetting, GroupKind)>(conn)?;
        Ok(rows
            .into_iter()
            .map(
                |(chat_id, last_read_message_id, archived, setting, kind)| ChatUnreadMembership {
                    chat_id,
                    last_read_message_id,
                    archived,
                    is_muted: setting.is_muted(kind, defaults, now),
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
            ))
            .load::<(
                i32,
                i64,
                Option<i64>,
                bool,
                ChatNotificationSetting,
                GroupKind,
            )>(conn)?;
        Ok(rows
            .into_iter()
            .map(
                |(uid, chat_id, last_read_message_id, archived, setting, kind)| {
                    UserChatUnreadMembership {
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

    fn load_chat_unread_snapshots(
        conn: &mut PgConnection,
        chat_ids: &[i64],
    ) -> Result<Vec<ChatUnreadSnapshot>, DieselError> {
        if chat_ids.is_empty() {
            return Ok(Vec::new());
        }

        let rows = sql_query(
            "SELECT chat_id,
                    id,
                    (deleted_at IS NULL AND is_published = TRUE) AS is_counted
             FROM messages
             WHERE chat_id = ANY($1)
               AND reply_root_id IS NULL
             ORDER BY chat_id ASC, id ASC",
        )
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(chat_ids.to_vec())
        .load::<ChatUnreadSnapshotRow>(conn)?;

        Ok(rows
            .into_iter()
            .map(|row| ChatUnreadSnapshot {
                chat_id: row.chat_id,
                id: row.id,
                is_counted: row.is_counted,
            })
            .collect())
    }
}

fn capped_add(current: i64, delta: i64) -> i64 {
    current.saturating_add(delta).min(MAX_UNREAD_COUNT)
}

fn group_snapshots_by_chat_id(
    rows: Vec<ChatUnreadSnapshot>,
) -> BTreeMap<i64, Vec<ChatUnreadSnapshot>> {
    let mut rows_by_chat_id = BTreeMap::new();
    for row in rows {
        rows_by_chat_id
            .entry(row.chat_id)
            .or_insert_with(Vec::new)
            .push(row);
    }
    rows_by_chat_id
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use chrono::{Duration, Utc};

    use super::{
        ChatUnreadMembership, ChatUnreadSnapshot, UnreadService, UserChatUnreadMembership,
    };
    use crate::constants::{MAX_UNREAD_COUNT, UNREAD_CHAT_INDEX_LOAD_BATCH_SIZE};

    fn batch_snapshot(chat_id: i64, id: i64, is_counted: bool) -> ChatUnreadSnapshot {
        ChatUnreadSnapshot {
            chat_id,
            id,
            is_counted,
        }
    }

    fn membership(
        chat_id: i64,
        last_read_message_id: Option<i64>,
        archived: bool,
        muted_until: Option<chrono::DateTime<Utc>>,
    ) -> ChatUnreadMembership {
        ChatUnreadMembership {
            chat_id,
            last_read_message_id,
            archived,
            is_muted: muted_until.is_some_and(|until| until > Utc::now()),
        }
    }

    fn user_membership(
        uid: i32,
        chat_id: i64,
        last_read_message_id: Option<i64>,
        archived: bool,
        muted_until: Option<chrono::DateTime<Utc>>,
    ) -> UserChatUnreadMembership {
        UserChatUnreadMembership {
            uid,
            chat_id,
            last_read_message_id,
            archived,
            is_muted: muted_until.is_some_and(|until| until > Utc::now()),
        }
    }

    #[test]
    fn loads_chat_once_and_reuses_index_for_later_reads() {
        let service = UnreadService::new();
        let loads = Cell::new(0);

        let first: Result<(), ()> = service.ensure_chats_loaded_with_loader(&[1], |_| {
            loads.set(loads.get() + 1);
            Ok(vec![
                batch_snapshot(1, 10, true),
                batch_snapshot(1, 20, true),
                batch_snapshot(1, 30, true),
            ])
        });
        first.unwrap();
        assert_eq!(service.loaded_chat_unread_count(1, Some(10)), Some(2));

        let second: Result<(), ()> = service.ensure_chats_loaded_with_loader(&[1], |_| {
            panic!("loaded chat should not be loaded again")
        });
        second.unwrap();
        assert_eq!(service.loaded_chat_unread_count(1, Some(20)), Some(1));
        assert_eq!(loads.get(), 1);
    }

    #[test]
    fn caps_single_chat_counts_at_public_unread_limit() {
        let service = UnreadService::new();

        let load_result: Result<(), ()> = service.ensure_chats_loaded_with_loader(&[1], |_| {
            Ok((1..=(MAX_UNREAD_COUNT + 10))
                .map(|id| batch_snapshot(1, id, true))
                .collect::<Vec<_>>())
        });
        load_result.unwrap();

        assert_eq!(
            service.loaded_chat_unread_count(1, Some(0)),
            Some(MAX_UNREAD_COUNT)
        );
    }

    #[test]
    fn applies_append_and_counted_mutations_to_loaded_chat() {
        let service = UnreadService::new();

        let load_result: Result<(), ()> = service.ensure_chats_loaded_with_loader(&[1], |_| {
            Ok(vec![
                batch_snapshot(1, 10, true),
                batch_snapshot(1, 20, false),
            ])
        });
        load_result.unwrap();
        assert_eq!(service.loaded_chat_unread_count(1, None), Some(1));

        service.observe_top_level_message(1, 30, true);
        service.observe_top_level_message_counted(1, 20, true);
        service.observe_top_level_message_counted(1, 10, false);

        assert_eq!(service.loaded_chat_unread_count(1, None), Some(2));
    }

    #[test]
    fn invalidates_loaded_chat_when_mutation_cannot_be_applied() {
        let service = UnreadService::new();
        let loads = Cell::new(0);

        let load_result: Result<(), ()> = service.ensure_chats_loaded_with_loader(&[1], |_| {
            loads.set(loads.get() + 1);
            Ok(vec![
                batch_snapshot(1, 10, true),
                batch_snapshot(1, 30, true),
            ])
        });
        load_result.unwrap();
        assert_eq!(service.loaded_chat_unread_count(1, None), Some(2));

        service.observe_top_level_message(1, 20, true);

        let reload_result: Result<(), ()> = service.ensure_chats_loaded_with_loader(&[1], |_| {
            loads.set(loads.get() + 1);
            Ok(vec![
                batch_snapshot(1, 10, true),
                batch_snapshot(1, 20, true),
                batch_snapshot(1, 30, true),
            ])
        });
        reload_result.unwrap();
        assert_eq!(service.loaded_chat_unread_count(1, None), Some(3));
        assert_eq!(loads.get(), 2);
    }

    #[test]
    fn batch_loader_loads_only_missing_chats_and_caches_empty_chats() {
        let service = UnreadService::new();
        let calls = RefCell::new(Vec::<Vec<i64>>::new());

        let result: Result<(), ()> =
            service.ensure_chats_loaded_with_loader(&[1, 2, 3], |chat_ids| {
                calls.borrow_mut().push(chat_ids.to_vec());
                Ok(vec![
                    batch_snapshot(1, 10, true),
                    batch_snapshot(1, 20, true),
                    batch_snapshot(3, 30, false),
                ])
            });
        result.unwrap();

        assert_eq!(calls.borrow().as_slice(), &[vec![1, 2, 3]]);
        assert_eq!(service.loaded_chat_unread_count(1, Some(10)), Some(1));
        assert_eq!(service.loaded_chat_unread_count(2, None), Some(0));
        assert_eq!(service.loaded_chat_unread_count(3, None), Some(0));

        let result: Result<(), ()> = service.ensure_chats_loaded_with_loader(&[2, 3], |_| {
            panic!("empty and loaded chats should not be loaded again")
        });
        result.unwrap();
        assert_eq!(calls.borrow().len(), 1);
    }

    #[test]
    fn batch_loader_uses_shared_batch_size_constant() {
        let service = UnreadService::new();
        let chat_ids = (1..=(UNREAD_CHAT_INDEX_LOAD_BATCH_SIZE as i64 + 1)).collect::<Vec<_>>();
        let calls = RefCell::new(Vec::<Vec<i64>>::new());

        let result: Result<(), ()> = service.ensure_chats_loaded_with_loader(&chat_ids, |ids| {
            calls.borrow_mut().push(ids.to_vec());
            Ok(ids
                .iter()
                .map(|chat_id| batch_snapshot(*chat_id, chat_id * 10, true))
                .collect())
        });
        result.unwrap();

        let calls = calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].len(), UNREAD_CHAT_INDEX_LOAD_BATCH_SIZE);
        assert_eq!(calls[1].len(), 1);
    }

    #[test]
    fn membership_projection_returns_per_chat_unreads_without_mute_filtering() {
        let service = UnreadService::new();
        let now = Utc::now();
        let memberships = vec![
            membership(1, Some(10), false, None),
            membership(2, Some(0), false, Some(now + Duration::minutes(5))),
        ];

        let counts: Result<std::collections::HashMap<i64, i64>, ()> = service
            .count_membership_unreads_with_loader(&memberships, |chat_ids| {
                Ok(chat_ids
                    .iter()
                    .flat_map(|chat_id| {
                        [
                            batch_snapshot(*chat_id, 10, true),
                            batch_snapshot(*chat_id, 20, true),
                            batch_snapshot(*chat_id, 30, true),
                        ]
                    })
                    .collect())
            });

        let counts = counts.unwrap();
        assert_eq!(counts.get(&1), Some(&2));
        assert_eq!(counts.get(&2), Some(&3));
    }

    #[test]
    fn membership_summary_splits_active_archived_muted_and_caps_counts() {
        let service = UnreadService::new();
        let now = Utc::now();
        let memberships = vec![
            membership(1, Some(0), false, None),
            membership(2, Some(0), false, Some(now + Duration::minutes(5))),
            membership(3, Some(0), true, Some(now + Duration::minutes(5))),
            membership(4, Some(100), false, None),
        ];

        let summary: Result<_, ()> =
            service.count_membership_unread_summary_with_loader(&memberships, |chat_ids| {
                let mut rows = Vec::new();
                for chat_id in chat_ids {
                    match *chat_id {
                        1 => {
                            for id in 1..=(MAX_UNREAD_COUNT + 10) {
                                rows.push(batch_snapshot(1, id, true));
                            }
                        }
                        2 => rows.extend([
                            batch_snapshot(2, 1, true),
                            batch_snapshot(2, 2, true),
                            batch_snapshot(2, 3, true),
                        ]),
                        3 => rows.push(batch_snapshot(3, 1, true)),
                        4 => rows.push(batch_snapshot(4, 1, true)),
                        _ => {}
                    }
                }
                Ok(rows)
            });

        let summary = summary.unwrap();
        assert_eq!(summary.unread_count, MAX_UNREAD_COUNT);
        assert_eq!(summary.unread_chat_count, 1);
        assert_eq!(summary.archived_unread_count, 1);
        assert_eq!(summary.archived_unread_chat_count, 1);
    }

    #[test]
    fn multi_user_totals_reuse_shared_chat_indexes_and_filter_badge_scope() {
        let service = UnreadService::new();
        let now = Utc::now();
        let memberships = vec![
            user_membership(10, 1, Some(10), false, None),
            user_membership(10, 2, Some(0), false, Some(now + Duration::minutes(5))),
            user_membership(10, 3, Some(0), true, None),
            user_membership(11, 1, Some(20), false, None),
            user_membership(11, 4, Some(0), false, None),
        ];
        let calls = RefCell::new(Vec::<Vec<i64>>::new());

        let totals: Result<std::collections::HashMap<i32, i64>, ()> = service
            .count_user_membership_unread_totals_with_loader(
                &[10, 11, 12],
                &memberships,
                |chat_ids| {
                    calls.borrow_mut().push(chat_ids.to_vec());
                    let mut rows = Vec::new();
                    for chat_id in chat_ids {
                        match *chat_id {
                            1 => rows.extend([
                                batch_snapshot(1, 10, true),
                                batch_snapshot(1, 20, true),
                                batch_snapshot(1, 30, true),
                            ]),
                            2 => rows
                                .extend([batch_snapshot(2, 1, true), batch_snapshot(2, 2, true)]),
                            3 => rows.push(batch_snapshot(3, 1, true)),
                            4 => rows.push(batch_snapshot(4, 1, true)),
                            _ => {}
                        }
                    }
                    Ok(rows)
                },
            );

        let totals = totals.unwrap();
        assert_eq!(calls.borrow().as_slice(), &[vec![1, 4]]);
        assert_eq!(totals.get(&10), Some(&2));
        assert_eq!(totals.get(&11), Some(&2));
        assert_eq!(totals.get(&12), Some(&0));
    }

    #[test]
    fn multi_user_totals_cap_each_user_independently() {
        let service = UnreadService::new();
        let memberships = vec![
            user_membership(10, 1, Some(0), false, None),
            user_membership(10, 2, Some(0), false, None),
            user_membership(11, 2, Some(0), false, None),
        ];

        let totals: Result<std::collections::HashMap<i32, i64>, ()> = service
            .count_user_membership_unread_totals_with_loader(&[10, 11], &memberships, |chat_ids| {
                let mut rows = Vec::new();
                for chat_id in chat_ids {
                    match *chat_id {
                        1 => {
                            for id in 1..=(MAX_UNREAD_COUNT + 10) {
                                rows.push(batch_snapshot(1, id, true));
                            }
                        }
                        2 => rows.extend([batch_snapshot(2, 1, true), batch_snapshot(2, 2, true)]),
                        _ => {}
                    }
                }
                Ok(rows)
            });

        let totals = totals.unwrap();
        assert_eq!(totals.get(&10), Some(&MAX_UNREAD_COUNT));
        assert_eq!(totals.get(&11), Some(&2));
    }

    /// Verifies `message_mentions` are counted as unread and auto-clear once the
    /// chat read pointer advances past the mentioned message. Requires a test
    /// database (`WETTY_TEST_DATABASE_URL`); skipped otherwise. Runs inside a
    /// transaction that always rolls back, so it leaves no persistent data.
    #[test]
    fn message_mentions_unread_count_and_auto_clear_on_read() {
        use diesel::Connection;
        use diesel::PgConnection;
        use diesel::RunQueryDsl;
        use std::sync::atomic::{AtomicI64, Ordering};

        let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(u) => u,
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");

        static SEQ: AtomicI64 = AtomicI64::new(9_876_543_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let msg_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let user: i32 = 4242;
        let sender: i32 = 1717;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'mention-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(user)
                .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) \
                 VALUES ($1, 'text', $2, $3, $4, NOW())",
            )
            .bind::<diesel::sql_types::BigInt, _>(msg_id)
            .bind::<diesel::sql_types::Text, _>(format!("cg-{chat_id}-{msg_id}"))
            .bind::<diesel::sql_types::Integer, _>(sender)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO message_mentions (message_id, mentioned_uid, chat_id, thread_root_id, created_at) \
                 VALUES ($1, $2, $3, NULL, NOW())",
            )
            .bind::<diesel::sql_types::BigInt, _>(msg_id)
            .bind::<diesel::sql_types::Integer, _>(user)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .execute(conn)?;

            // last_read_message_id is NULL -> treated as 0 -> mention is unread.
            let counts = service.count_user_chat_unread_mentions(conn, user)?;
            assert_eq!(counts.get(&chat_id).copied(), Some(1));

            // Reading up to the mentioned message clears the unread mention.
            diesel::sql_query(
                "UPDATE group_membership SET last_read_message_id = $1 \
                 WHERE chat_id = $2 AND uid = $3",
            )
            .bind::<diesel::sql_types::BigInt, _>(msg_id)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::Integer, _>(user)
            .execute(conn)?;
            let counts_after = service.count_user_chat_unread_mentions(conn, user)?;
            assert!(counts_after.get(&chat_id).copied().is_none());

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }

    #[test]
    fn list_chat_unread_mentions_returns_newest_first_and_respects_scope_and_cursor() {
        use diesel::Connection;
        use diesel::PgConnection;
        use diesel::RunQueryDsl;
        use std::sync::atomic::{AtomicI64, Ordering};

        let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(u) => u,
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");

        static SEQ: AtomicI64 = AtomicI64::new(9_876_554_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let thread_root_id = SEQ.fetch_add(1, Ordering::SeqCst);
        // main-scope mentions, older -> newer; main_old/main_mid will be read (<= cursor).
        let main_old = SEQ.fetch_add(1, Ordering::SeqCst);
        let main_mid = SEQ.fetch_add(1, Ordering::SeqCst);
        let main_new = SEQ.fetch_add(1, Ordering::SeqCst);
        // thread-scope mention.
        let thread_msg = SEQ.fetch_add(1, Ordering::SeqCst);
        let user: i32 = 4243;
        let sender: i32 = 1718;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'mention-list-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(user)
                .execute(conn)?;

            for msg_id in [main_old, main_mid, main_new, thread_msg] {
                diesel::sql_query(
                    "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) \
                     VALUES ($1, 'text', $2, $3, $4, NOW())",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Text, _>(format!("cg-{chat_id}-{msg_id}"))
                .bind::<diesel::sql_types::Integer, _>(sender)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            }

            // main_old / main_mid / main_new are main-scope (thread_root_id NULL).
            for msg_id in [main_old, main_mid, main_new] {
                diesel::sql_query(
                    "INSERT INTO message_mentions (message_id, mentioned_uid, chat_id, thread_root_id, created_at) \
                     VALUES ($1, $2, $3, NULL, NOW())",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Integer, _>(user)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            }
            // thread_msg is thread-scoped (thread_root_id set).
            diesel::sql_query(
                "INSERT INTO message_mentions (message_id, mentioned_uid, chat_id, thread_root_id, created_at) \
                 VALUES ($1, $2, $3, $4, NOW())",
            )
            .bind::<diesel::sql_types::BigInt, _>(thread_msg)
            .bind::<diesel::sql_types::Integer, _>(user)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::BigInt, _>(thread_root_id)
            .execute(conn)?;

            // Cursor NULL -> all main-scope mentions unread, newest-first.
            let main_ids = service.list_chat_unread_mentions(
                conn, user, chat_id, None, None, 100,
            )?;
            assert_eq!(main_ids, vec![main_new, main_mid, main_old]);

            // Thread scope excludes main-scope mentions.
            let thread_ids = service.list_chat_unread_mentions(
                conn, user, chat_id, None, Some(thread_root_id), 100,
            )?;
            assert_eq!(thread_ids, vec![thread_msg]);

            // Advancing the cursor to main_mid marks main_old + main_mid as read.
            let after_mid = service.list_chat_unread_mentions(
                conn, user, chat_id, Some(main_mid), None, 100,
            )?;
            assert_eq!(after_mid, vec![main_new]);

            // LIMIT caps the result.
            let limited = service.list_chat_unread_mentions(
                conn, user, chat_id, None, None, 2,
            )?;
            assert_eq!(limited, vec![main_new, main_mid]);

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }

    /// Reply rows (kind='reply') ride the same unread-mention pipeline as
    /// @mentions: they count towards unread mentions, appear in the jump list
    /// for both main and thread scope, and clear when the read cursor advances.
    /// Requires a test database (`WETTY_TEST_DATABASE_URL`); skipped otherwise.
    #[test]
    fn reply_kind_mention_rows_flow_through_unread_pipeline() {
        use diesel::Connection;
        use diesel::PgConnection;
        use diesel::RunQueryDsl;
        use std::sync::atomic::{AtomicI64, Ordering};

        let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(u) => u,
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");

        static SEQ: AtomicI64 = AtomicI64::new(9_876_565_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let thread_root_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let mention_msg = SEQ.fetch_add(1, Ordering::SeqCst);
        let reply_msg = SEQ.fetch_add(1, Ordering::SeqCst);
        let thread_reply_msg = SEQ.fetch_add(1, Ordering::SeqCst);
        let user: i32 = 4244;
        let sender: i32 = 1719;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'reply-mention-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(user)
                .execute(conn)?;

            for msg_id in [mention_msg, reply_msg, thread_reply_msg] {
                diesel::sql_query(
                    "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) \
                     VALUES ($1, 'text', $2, $3, $4, NOW())",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Text, _>(format!("cg-{chat_id}-{msg_id}"))
                .bind::<diesel::sql_types::Integer, _>(sender)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            }

            // One explicit @mention row and two reply rows (main + thread scope).
            diesel::sql_query(
                "INSERT INTO message_mentions (message_id, mentioned_uid, chat_id, thread_root_id, created_at, kind) \
                 VALUES ($1, $2, $3, NULL, NOW(), 'mention')",
            )
            .bind::<diesel::sql_types::BigInt, _>(mention_msg)
            .bind::<diesel::sql_types::Integer, _>(user)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO message_mentions (message_id, mentioned_uid, chat_id, thread_root_id, created_at, kind) \
                 VALUES ($1, $2, $3, NULL, NOW(), 'reply')",
            )
            .bind::<diesel::sql_types::BigInt, _>(reply_msg)
            .bind::<diesel::sql_types::Integer, _>(user)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO message_mentions (message_id, mentioned_uid, chat_id, thread_root_id, created_at, kind) \
                 VALUES ($1, $2, $3, $4, NOW(), 'reply')",
            )
            .bind::<diesel::sql_types::BigInt, _>(thread_reply_msg)
            .bind::<diesel::sql_types::Integer, _>(user)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::BigInt, _>(thread_root_id)
            .execute(conn)?;

            // Reply rows count as unread mentions alongside the @mention.
            let counts = service.count_user_chat_unread_mentions(conn, user)?;
            assert_eq!(counts.get(&chat_id).copied(), Some(2));

            // The jump list includes reply rows, newest-first, scope-respected.
            let main_ids =
                service.list_chat_unread_mentions(conn, user, chat_id, None, None, 100)?;
            assert_eq!(main_ids, vec![reply_msg, mention_msg]);
            let thread_ids = service.list_chat_unread_mentions(
                conn, user, chat_id, None, Some(thread_root_id), 100,
            )?;
            assert_eq!(thread_ids, vec![thread_reply_msg]);

            // Reading up to the reply message clears both rows.
            diesel::sql_query(
                "UPDATE group_membership SET last_read_message_id = $1 \
                 WHERE chat_id = $2 AND uid = $3",
            )
            .bind::<diesel::sql_types::BigInt, _>(reply_msg)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::Integer, _>(user)
            .execute(conn)?;
            let counts_after = service.count_user_chat_unread_mentions(conn, user)?;
            assert!(counts_after.get(&chat_id).copied().is_none());

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }

    #[test]
    fn mention_categories_include_unloaded_scopes_and_separate_archives() {
        let (total, active, archived) = super::mention_summary(vec![
            super::MentionScopeCount {
                kind: crate::models::GroupKind::Group,
                archived: false,
                is_thread: false,
                count: 1,
            },
            super::MentionScopeCount {
                kind: crate::models::GroupKind::Dm,
                archived: true,
                is_thread: false,
                count: 2,
            },
            super::MentionScopeCount {
                kind: crate::models::GroupKind::Group,
                archived: false,
                is_thread: true,
                count: 3,
            },
        ]);
        assert_eq!(total, 6);
        assert_eq!(
            active,
            crate::dto::chats::MentionBadges {
                groups: true,
                friends: false,
                threads: true,
            }
        );
        assert_eq!(
            archived,
            crate::dto::chats::MentionBadges {
                groups: false,
                friends: true,
                threads: false,
            }
        );
    }

    struct MentionSummaryFixture {
        uid: i32,
        next_id: i64,
    }

    impl MentionSummaryFixture {
        fn chat(
            &mut self,
            conn: &mut diesel::PgConnection,
            kind: &str,
            archived: bool,
            member: bool,
        ) -> diesel::QueryResult<i64> {
            use diesel::RunQueryDsl;

            let chat_id = self.next_id;
            self.next_id += 1;
            diesel::sql_query(
                "INSERT INTO groups (id, name, kind, dm_uid1, dm_uid2)
                 VALUES (
                     $1, 'mention-summary-test', $2::group_kind,
                     CASE WHEN $2 = 'dm' THEN $3 ELSE NULL END,
                     CASE WHEN $2 = 'dm' THEN ($1 % 1000000000)::INTEGER ELSE NULL END
                 )",
            )
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::Text, _>(kind)
            .bind::<diesel::sql_types::Integer, _>(self.uid)
            .execute(conn)?;
            if member {
                diesel::sql_query(
                    "INSERT INTO group_membership (chat_id, uid, archived, muted_until)
                     VALUES ($1, $2, $3, 'infinity')",
                )
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(self.uid)
                .bind::<diesel::sql_types::Bool, _>(archived)
                .execute(conn)?;
            }
            Ok(chat_id)
        }

        fn thread(
            &mut self,
            conn: &mut diesel::PgConnection,
            chat_id: i64,
            archived: bool,
            subscribed: Option<bool>,
        ) -> diesel::QueryResult<i64> {
            use diesel::RunQueryDsl;

            let root_id = self.next_id;
            self.next_id += 1;
            diesel::sql_query(
                "INSERT INTO messages
                    (id, message_type, client_generated_id, sender_uid, chat_id,
                     has_thread, is_published, created_at)
                 VALUES ($1, 'text', $1::text, $2, $3, TRUE, TRUE, NOW())",
            )
            .bind::<diesel::sql_types::BigInt, _>(root_id)
            .bind::<diesel::sql_types::Integer, _>(self.uid)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .execute(conn)?;
            if let Some(subscribed) = subscribed {
                diesel::sql_query(
                    "INSERT INTO thread_user_states
                        (chat_id, thread_root_id, uid, archived, subscribed, subscribed_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())",
                )
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::BigInt, _>(root_id)
                .bind::<diesel::sql_types::Integer, _>(self.uid)
                .bind::<diesel::sql_types::Bool, _>(archived)
                .bind::<diesel::sql_types::Bool, _>(subscribed)
                .execute(conn)?;
            }
            Ok(root_id)
        }

        fn mentions(
            &mut self,
            conn: &mut diesel::PgConnection,
            chat_id: i64,
            root_id: Option<i64>,
            count: i64,
        ) -> diesel::QueryResult<(i64, i64)> {
            use diesel::RunQueryDsl;

            let first_id = self.next_id;
            self.next_id += count;
            diesel::sql_query(
                "WITH inserted AS (
                     INSERT INTO messages
                         (id, message_type, client_generated_id, sender_uid,
                          chat_id, reply_root_id, is_published, created_at)
                     SELECT $1 + n, 'text', ($1 + n)::text, $5, $3, $4, TRUE, NOW()
                     FROM generate_series(0::BIGINT, $2 - 1) n
                     RETURNING id
                 )
                 INSERT INTO message_mentions
                     (message_id, mentioned_uid, chat_id, thread_root_id, created_at)
                 SELECT id, $5, $3, $4, NOW() FROM inserted",
            )
            .bind::<diesel::sql_types::BigInt, _>(first_id)
            .bind::<diesel::sql_types::BigInt, _>(count)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::Nullable<diesel::sql_types::BigInt>, _>(root_id)
            .bind::<diesel::sql_types::Integer, _>(self.uid)
            .execute(conn)?;
            Ok((first_id, self.next_id - 1))
        }

        fn read(
            &self,
            conn: &mut diesel::PgConnection,
            chat_id: i64,
            root_id: Option<i64>,
            message_id: i64,
        ) -> diesel::QueryResult<()> {
            use diesel::RunQueryDsl;

            if let Some(root_id) = root_id {
                diesel::sql_query(
                    "UPDATE thread_user_states SET last_read_message_id = $1
                     WHERE uid = $2 AND chat_id = $3 AND thread_root_id = $4",
                )
                .bind::<diesel::sql_types::BigInt, _>(message_id)
                .bind::<diesel::sql_types::Integer, _>(self.uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::BigInt, _>(root_id)
                .execute(conn)?;
            } else {
                diesel::sql_query(
                    "UPDATE group_membership SET last_read_message_id = $1
                     WHERE uid = $2 AND chat_id = $3",
                )
                .bind::<diesel::sql_types::BigInt, _>(message_id)
                .bind::<diesel::sql_types::Integer, _>(self.uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            }
            Ok(())
        }

        fn assert_summary(
            &self,
            conn: &mut diesel::PgConnection,
            total: i64,
            active: [bool; 3],
            archived: [bool; 3],
        ) -> diesel::QueryResult<()> {
            let (actual_total, actual_active, actual_archived) =
                UnreadService::new().count_user_mention_summary(conn, self.uid)?;
            assert_eq!(
                (
                    actual_total,
                    [
                        actual_active.groups,
                        actual_active.friends,
                        actual_active.threads,
                    ],
                    [
                        actual_archived.groups,
                        actual_archived.friends,
                        actual_archived.threads,
                    ],
                ),
                (total, active, archived),
            );
            Ok(())
        }
    }

    fn with_mention_summary_fixture(
        uid: i32,
        first_id: i64,
        test: impl FnOnce(
            &mut diesel::PgConnection,
            &mut MentionSummaryFixture,
        ) -> diesel::QueryResult<()>,
    ) {
        use diesel::Connection;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = diesel::PgConnection::establish(&url).expect("connect to test database");
        // Separate fixture users/ID ranges avoid interference with other DB tests.
        // test_transaction rolls back every write, including on assertion failure.
        conn.test_transaction::<(), diesel::result::Error, _>(|conn| {
            test(
                conn,
                &mut MentionSummaryFixture {
                    uid,
                    next_id: first_id,
                },
            )
        });
    }

    #[test]
    fn mention_summary_respects_scope_cursors_membership_and_root_visibility() {
        use diesel::RunQueryDsl;

        with_mention_summary_fixture(-541_001, 9_876_800_000, |conn, fixture| {
            let active_group = fixture.chat(conn, "group", false, true)?;
            let active_dm = fixture.chat(conn, "dm", false, true)?;
            let archived_group = fixture.chat(conn, "group", true, true)?;
            let archived_dm = fixture.chat(conn, "dm", true, true)?;
            let departed = fixture.chat(conn, "group", false, false)?;

            // A mention exactly at each cursor is read; only its successor counts.
            for chat_id in [active_group, active_dm, archived_group, archived_dm] {
                let (_, last) = fixture.mentions(conn, chat_id, None, 17)?;
                fixture.read(conn, chat_id, None, last - 1)?;
            }
            // Thread archive state, not the parent chat's archive state, wins.
            let active_thread = fixture.thread(conn, archived_group, false, Some(true))?;
            let archived_thread = fixture.thread(conn, active_dm, true, Some(true))?;
            for (chat_id, root_id) in [
                (archived_group, active_thread),
                (active_dm, archived_thread),
            ] {
                let (_, last) = fixture.mentions(conn, chat_id, Some(root_id), 17)?;
                fixture.read(conn, chat_id, Some(root_id), last - 1)?;
            }
            // Preserve the existing root visibility policy: deletion alone does
            // not hide an otherwise published, top-level threaded root.
            diesel::sql_query("UPDATE messages SET deleted_at = NOW() WHERE id = $1")
                .bind::<diesel::sql_types::BigInt, _>(active_thread)
                .execute(conn)?;

            let unsubscribed = fixture.thread(conn, active_group, false, Some(false))?;
            let no_state = fixture.thread(conn, active_group, false, None)?;
            let no_thread = fixture.thread(conn, active_group, false, Some(true))?;
            let unpublished = fixture.thread(conn, active_group, false, Some(true))?;
            let nested = fixture.thread(conn, active_group, false, Some(true))?;
            let departed_thread = fixture.thread(conn, departed, false, Some(true))?;
            diesel::sql_query(
                "UPDATE messages
                 SET has_thread = (id <> $1), is_published = (id <> $2),
                     reply_root_id = CASE WHEN id = $3 THEN $4 ELSE NULL END
                 WHERE id IN ($1, $2, $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(no_thread)
            .bind::<diesel::sql_types::BigInt, _>(unpublished)
            .bind::<diesel::sql_types::BigInt, _>(nested)
            .bind::<diesel::sql_types::BigInt, _>(unsubscribed)
            .execute(conn)?;
            for root_id in [unsubscribed, no_state, no_thread, unpublished, nested] {
                fixture.mentions(conn, active_group, Some(root_id), 3)?;
            }
            fixture.mentions(conn, departed, None, 3)?;
            fixture.mentions(conn, departed, Some(departed_thread), 3)?;

            fixture.assert_summary(conn, 6, [true; 3], [true; 3])?;
            // Advancing main cursors must leave both thread scopes unread.
            for chat_id in [active_group, active_dm, archived_group, archived_dm] {
                fixture.read(conn, chat_id, None, fixture.next_id)?;
            }
            fixture.assert_summary(conn, 2, [false, false, true], [false, false, true])?;
            fixture.read(conn, archived_group, Some(active_thread), fixture.next_id)?;
            fixture.read(conn, active_dm, Some(archived_thread), fixture.next_id)?;
            fixture.assert_summary(conn, 0, [false; 3], [false; 3])
        });
    }

    #[test]
    fn mention_summary_saturation_preserves_all_categories_and_remaining_counts() {
        with_mention_summary_fixture(-541_002, 9_876_900_000, |conn, fixture| {
            let active_group = fixture.chat(conn, "group", false, true)?;
            let active_dm = fixture.chat(conn, "dm", false, true)?;
            let archived_group = fixture.chat(conn, "group", true, true)?;
            let archived_dm = fixture.chat(conn, "dm", true, true)?;
            let active_thread = fixture.thread(conn, archived_group, false, Some(true))?;
            let archived_thread = fixture.thread(conn, active_group, true, Some(true))?;
            let mut saturated_scopes = Vec::new();
            // Both branches have read history followed by more than the cap.
            for (chat_id, root_id) in [(active_group, None), (archived_group, Some(active_thread))]
            {
                let (first, last) =
                    fixture.mentions(conn, chat_id, root_id, MAX_UNREAD_COUNT * 2 + 11)?;
                fixture.read(conn, chat_id, root_id, first + MAX_UNREAD_COUNT - 1)?;
                saturated_scopes.push((chat_id, root_id, last));
            }
            for (chat_id, root_id) in [
                (active_dm, None),
                (archived_group, None),
                (archived_dm, None),
                (active_group, Some(archived_thread)),
            ] {
                fixture.mentions(conn, chat_id, root_id, 1)?;
            }
            fixture.assert_summary(conn, MAX_UNREAD_COUNT, [true; 3], [true; 3])?;
            let (chat_id, root_id, last) = saturated_scopes[0];
            fixture.read(conn, chat_id, root_id, last)?;
            fixture.assert_summary(conn, MAX_UNREAD_COUNT, [false, true, true], [true; 3])?;
            let (chat_id, root_id, last) = saturated_scopes[1];
            fixture.read(conn, chat_id, root_id, last)?;
            fixture.assert_summary(conn, 4, [false, true, false], [true; 3])
        });
    }

    /// Chat-level reaction read state: ordinary message/thread reads do not
    /// advance the reaction cursor; the explicit acknowledge clears the scope;
    /// a reaction created after the acknowledge stays unread; chat and thread
    /// scopes are independent. Requires a test database; skipped otherwise.
    #[test]
    fn reaction_read_cursor_is_chat_level_and_decoupled_from_message_reads() {
        use diesel::Connection;
        use diesel::PgConnection;
        use diesel::RunQueryDsl;
        use std::sync::atomic::{AtomicI64, Ordering};

        let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(u) => u,
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");

        static SEQ: AtomicI64 = AtomicI64::new(9_876_700_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let msg_a = SEQ.fetch_add(1, Ordering::SeqCst);
        let msg_b = SEQ.fetch_add(1, Ordering::SeqCst);
        let thread_root = SEQ.fetch_add(1, Ordering::SeqCst);
        let thread_reply = SEQ.fetch_add(1, Ordering::SeqCst);
        let author: i32 = 4301;
        let actor: i32 = 4302;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'reaction-read-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            for uid in [author, actor] {
                diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                    .bind::<diesel::sql_types::BigInt, _>(chat_id)
                    .bind::<diesel::sql_types::Integer, _>(uid)
                    .execute(conn)?;
            }
            for (msg_id, reply_root) in [
                (msg_a, None),
                (msg_b, None),
                (thread_root, None),
                (thread_reply, Some(thread_root)),
            ] {
                diesel::sql_query(
                    "INSERT INTO messages
                        (id, message_type, client_generated_id, sender_uid, chat_id, reply_root_id, created_at)
                     VALUES ($1, 'text', $2, $3, $4, $5, NOW())",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Text, _>(format!("cg-reaction-{msg_id}"))
                .bind::<diesel::sql_types::Integer, _>(author)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Nullable<diesel::sql_types::BigInt>, _>(reply_root)
                .execute(conn)?;
            }

            // Start with an ancient cursor so the pre-ack reaction is unread.
            diesel::sql_query(
                "UPDATE group_membership SET last_reactions_read_at = '-infinity'
                 WHERE chat_id = $1 AND uid = $2",
            )
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO message_reactions
                    (message_id, user_uid, emoji, created_at, message_author_uid)
                 VALUES ($1, $2, '👍', NOW() - interval '1 hour', $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(msg_a)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            assert_eq!(service.count_chat_unread_reactions(conn, author, chat_id, None)?, 1);

            // Ordinary message reads must not clear reactions.
            crate::services::chat::mark_chat_as_read(conn, chat_id, author, msg_a)?;
            assert_eq!(service.count_chat_unread_reactions(conn, author, chat_id, None)?, 1);

            // A reaction arriving after the GET snapshot must survive its ACK.
            let boundary = Utc::now() - chrono::Duration::minutes(45);
            diesel::sql_query(
                "INSERT INTO message_reactions
                    (message_id, user_uid, emoji, created_at, message_author_uid)
                 VALUES ($1, $2, '🍀', $3, $4)",
            )
            .bind::<diesel::sql_types::BigInt, _>(msg_b)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::Timestamptz, _>(boundary + chrono::Duration::minutes(15))
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            assert_eq!(
                service.list_chat_unread_reactions(conn, author, chat_id, None, 1000, boundary)?,
                vec![msg_a],
            );
            assert_eq!(
                service.acknowledge_chat_unread_reactions(conn, author, chat_id, None, Some(boundary))?,
                1,
            );

            // Explicit chat-level acknowledge clears the scope.
            assert_eq!(
                service.acknowledge_chat_unread_reactions(conn, author, chat_id, None, None)?,
                0
            );

            // A reaction created after the acknowledge is unread again.
            diesel::sql_query(
                "INSERT INTO message_reactions
                    (message_id, user_uid, emoji, created_at, message_author_uid)
                 VALUES ($1, $2, '🎉', NOW() + interval '1 hour', $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(msg_b)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            assert_eq!(service.count_chat_unread_reactions(conn, author, chat_id, None)?, 1);

            // Thread scope is independent: an unread thread reaction does not
            // affect the main count, and reading the thread must not clear it.
            diesel::sql_query(
                "INSERT INTO thread_user_states
                    (chat_id, thread_root_id, uid, subscribed_at, last_reactions_read_at)
                 VALUES ($1, $2, $3, NOW(), '-infinity')",
            )
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::BigInt, _>(thread_root)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO message_reactions
                    (message_id, user_uid, emoji, created_at, message_author_uid)
                 VALUES ($1, $2, '❤️', NOW() - interval '1 hour', $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(thread_reply)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            assert_eq!(
                service.count_chat_unread_reactions(conn, author, chat_id, Some(thread_root))?,
                1
            );
            assert_eq!(service.count_chat_unread_reactions(conn, author, chat_id, None)?, 1);

            crate::services::threads::mark_thread_as_read(
                conn,
                chat_id,
                thread_root,
                author,
                thread_reply,
            )?;
            assert_eq!(
                service.count_chat_unread_reactions(conn, author, chat_id, Some(thread_root))?,
                1
            );

            assert_eq!(
                service.acknowledge_chat_unread_reactions(conn, author, chat_id, Some(thread_root), None)?,
                0
            );
            // The main-scope reaction from message B is untouched.
            assert_eq!(service.count_chat_unread_reactions(conn, author, chat_id, None)?, 1);

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }
}
