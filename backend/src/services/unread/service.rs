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
use crate::schema::{group_membership, thread_user_states};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatUnreadMembership {
    pub chat_id: i64,
    pub last_read_message_id: Option<i64>,
    pub archived: bool,
    pub muted_until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserChatUnreadMembership {
    pub uid: i32,
    pub chat_id: i64,
    pub last_read_message_id: Option<i64>,
    pub archived: bool,
    pub muted_until: Option<DateTime<Utc>>,
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

#[derive(diesel::QueryableByName)]
struct ReactionWatermarkRow {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    watermark: i64,
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
/// membership row. The cursor is the identity `revision` allocated under the
/// per-chat watermark lock, so `revision > cursor` has strict commit-order
/// semantics (a timestamp comparison cannot order concurrent inserts).
const UNREAD_REACTIONS_MAIN_TAIL: &str = "AND m.reply_root_id IS NULL
    AND mr.revision > COALESCE((
        SELECT gm.last_reactions_read_revision
        FROM group_membership gm
        WHERE gm.chat_id = $2 AND gm.uid = $1
    ), 0)";

/// Thread-scope tail (reactions on the user's messages in thread `$3`),
/// cursor from the per-thread user state row.
const UNREAD_REACTIONS_THREAD_TAIL: &str = "AND m.reply_root_id = $3
    AND mr.revision > COALESCE((
        SELECT tus.last_reactions_read_revision
        FROM thread_user_states tus
        WHERE tus.chat_id = $2 AND tus.thread_root_id = $3 AND tus.uid = $1
    ), 0)";

#[derive(diesel::QueryableByName)]
struct UnreadReactionEntryRow {
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::BigInt>)]
    message_id: Option<i64>,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    watermark: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    unread_reactions: i64,
}

/// One page of unread-reaction ids plus the server-issued watermark covering
/// exactly the reactions belonging to those messages (see
/// [`UnreadService::list_chat_unread_reactions`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadReactionList {
    /// Message ids ordered by their oldest unread reaction (oldest-first), one
    /// entry per message.
    pub message_ids: Vec<i64>,
    /// Server boundary: every unread reaction with `revision <= watermark`
    /// belongs to one of `message_ids`. Acknowledging this watermark clears
    /// only reactions the client has actually seen.
    pub watermark: i64,
    /// Total number of distinct messages with unread reactions in this scope.
    pub unread_reactions: i64,
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
        self.count_membership_unread_summary(conn, &memberships, Utc::now())
    }

    pub fn count_users_unread_totals(
        &self,
        conn: &mut PgConnection,
        target_uids: &[i32],
    ) -> Result<HashMap<i32, i64>, DieselError> {
        let memberships = Self::load_users_chat_memberships(conn, target_uids)?;
        self.count_user_membership_unread_totals(conn, target_uids, &memberships, Utc::now())
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
    /// flag): a reaction is unread while `revision > last_reactions_read_revision`.
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
               AND mr.revision > gm.last_reactions_read_revision
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
    /// messages (cursor: `group_membership.last_reactions_read_revision`);
    /// `Some(id)` counts reactions on the user's messages in that thread
    /// (cursor: `thread_user_states.last_reactions_read_revision`). The read
    /// cursor is read here so callers never handle the revision.
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

    /// Unread-reaction message ids for a single chat plus a server-issued
    /// watermark, one entry per message regardless of how many new reactions it
    /// carries.
    ///
    /// Same derivation and scope rules as `count_chat_unread_reactions`. The
    /// limit is interpolated instead of bound so both scope variants share one
    /// placeholder layout (`limit` is a validated `i64` from `validate_limit`).
    ///
    /// Ordering and watermark contract: ids are ordered oldest-unread-first (by
    /// each message's oldest unread reaction) so the client can jump
    /// chronologically. The watermark covers exactly the reactions belonging to
    /// the returned messages — when more distinct messages match than `limit`,
    /// the watermark stops just before the oldest unlisted message's first
    /// unread reaction, so acknowledging it can never clear a reaction the
    /// client was never shown. Callers must hold
    /// [`Self::lock_chat_reaction_watermark`] (same transaction) so the
    /// watermark has commit-order meaning.
    pub fn list_chat_unread_reactions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        thread_root_id: Option<i64>,
        limit: i64,
    ) -> Result<UnreadReactionList, DieselError> {
        let sql = format!(
            "WITH matched AS (
                 SELECT mr.message_id AS message_id, mr.revision AS revision
                 {UNREAD_REACTIONS_FILTER} {}
             ), per_message AS (
                 SELECT message_id, MIN(revision) AS first_revision
                 FROM matched
                 GROUP BY message_id
             ), ordered AS (
                 SELECT message_id, first_revision,
                        ROW_NUMBER() OVER (ORDER BY first_revision ASC) AS rn
                 FROM per_message
             ), boundary AS (
                 SELECT CASE
                     WHEN (SELECT COUNT(*) FROM ordered) <= {limit}
                         THEN COALESCE((SELECT MAX(revision) FROM matched), 0)
                     ELSE COALESCE((SELECT MIN(first_revision) - 1 FROM ordered WHERE rn = {limit} + 1), 0)
                 END AS boundary
             ), summary AS (
                 SELECT COUNT(*)::BIGINT AS unread_reactions FROM per_message
             )
             SELECT o.message_id AS message_id, b.boundary AS watermark,
                    s.unread_reactions AS unread_reactions
             FROM summary s
             CROSS JOIN boundary b
             LEFT JOIN ordered o ON TRUE
             ORDER BY o.first_revision ASC
             LIMIT {limit}",
            match thread_root_id {
                Some(_) => UNREAD_REACTIONS_THREAD_TAIL,
                None => UNREAD_REACTIONS_MAIN_TAIL,
            }
        );
        let rows: Vec<UnreadReactionEntryRow> = match thread_root_id {
            Some(thread_id) => sql_query(&sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::BigInt, _>(thread_id)
                .load(conn)?,
            None => sql_query(&sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .load(conn)?,
        };
        let watermark = rows.first().map(|r| r.watermark).unwrap_or(0);
        let unread_reactions = rows
            .first()
            .map(|r| r.unread_reactions.min(MAX_UNREAD_COUNT))
            .unwrap_or(0);
        Ok(UnreadReactionList {
            message_ids: rows.into_iter().filter_map(|r| r.message_id).collect(),
            watermark,
            unread_reactions,
        })
    }

    /// Per-chat lock serializing reaction inserts with watermark readers
    /// (snapshot + acknowledge). Identity revisions are allocated at INSERT
    /// time but become visible only at COMMIT; without this lock a reaction
    /// could allocate a revision below an already-computed watermark and commit
    /// after it — acknowledging that watermark would silently clear a reaction
    /// the client never saw. Holding the lock until commit makes revision
    /// order match commit order, so "revision <= watermark" implies "the
    /// snapshot listed it".
    ///
    /// Callers must run this inside the transaction that performs the insert,
    /// snapshot, or cursor advance. No other `pg_advisory_xact_lock` keys are
    /// in use, so the raw chat id is a safe key.
    pub fn lock_chat_reaction_watermark(conn: &mut PgConnection, chat_id: i64) -> QueryResult<()> {
        sql_query("SELECT pg_advisory_xact_lock($1)")
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .execute(conn)?;
        Ok(())
    }

    /// Advance the unread-reaction cursor to `read_through` (monotonic) and
    /// return the fresh post-acknowledge state so the client can apply count,
    /// ids, and watermark in one atomic update.
    ///
    /// Because the cursor only covers reactions listed under the acknowledged
    /// watermark, reactions created after the client's snapshot (revision >
    /// watermark, guaranteed by [`Self::lock_chat_reaction_watermark`]) stay
    /// unread. An old or repeated watermark is a no-op: the cursor never
    /// regresses.
    pub fn acknowledge_chat_unread_reactions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        thread_root_id: Option<i64>,
        read_through: i64,
        limit: i64,
    ) -> Result<(i64, UnreadReactionList), DieselError> {
        conn.transaction(|conn| {
            Self::lock_chat_reaction_watermark(conn, chat_id)?;
            // The client gets a watermark from a prior list response, but it
            // remains untrusted input.  Bound it to revisions that already
            // exist while the per-chat lock is held so a forged max integer
            // cannot suppress reactions inserted in the future.
            //
            // The bound is scoped to the user's own eligible reactions (same
            // filter as the unread queries). Descending LIMIT can read via
            // idx_message_reactions_author_revision without aggregating every
            // matching row. Any future eligible reaction allocates a revision
            // above every existing one, so clamping to this scoped maximum is
            // safe. Eligibility is monotonic (delete and publish never revert),
            // so an excluded reaction cannot later hide under this bound.
            // Materialize the message scope first.  The old author/revision
            // index cannot constrain chat_id because that column lives on
            // messages; starting from the scoped messages and probing the
            // message_id/author/revision index avoids walking this user's
            // reactions from unrelated chats while holding the advisory lock.
            let scope_filter = if thread_root_id.is_some() {
                "AND m.reply_root_id = $3"
            } else {
                "AND m.reply_root_id IS NULL"
            };
            let sql = format!(
                "WITH scoped_messages AS MATERIALIZED (
                     SELECT m.id
                     FROM messages m
                     WHERE m.chat_id = $2
                       AND m.deleted_at IS NULL
                       AND m.is_published = TRUE
                       {scope_filter}
                 )
                 SELECT COALESCE(MAX(mr.revision), 0)::BIGINT AS watermark
                 FROM scoped_messages sm
                 JOIN message_reactions mr ON mr.message_id = sm.id
                 WHERE mr.message_author_uid = $1
                   AND mr.user_uid <> $1"
            );
            let watermark = match thread_root_id {
                Some(thread_id) => {
                    sql_query(sql)
                        .bind::<diesel::sql_types::Integer, _>(uid)
                        .bind::<diesel::sql_types::BigInt, _>(chat_id)
                        .bind::<diesel::sql_types::BigInt, _>(thread_id)
                        .get_result::<ReactionWatermarkRow>(conn)?
                        .watermark
                }
                None => {
                    sql_query(sql)
                        .bind::<diesel::sql_types::Integer, _>(uid)
                        .bind::<diesel::sql_types::BigInt, _>(chat_id)
                        .get_result::<ReactionWatermarkRow>(conn)?
                        .watermark
                }
            };
            let safe_read_through = watermark.min(read_through);
            match thread_root_id {
                Some(thread_id) => {
                    crate::services::threads::ensure_thread_user_state(
                        conn, chat_id, thread_id, uid, false,
                    )?;
                    diesel::update(
                        thread_user_states::table.filter(
                            thread_user_states::chat_id
                                .eq(chat_id)
                                .and(thread_user_states::thread_root_id.eq(thread_id))
                                .and(thread_user_states::uid.eq(uid))
                                .and(
                                    thread_user_states::last_reactions_read_revision
                                        .lt(safe_read_through),
                                ),
                        ),
                    )
                    .set(thread_user_states::last_reactions_read_revision.eq(safe_read_through))
                    .execute(conn)?;
                }
                None => {
                    diesel::update(
                        group_membership::table.filter(
                            group_membership::chat_id
                                .eq(chat_id)
                                .and(group_membership::uid.eq(uid))
                                .and(
                                    group_membership::last_reactions_read_revision
                                        .lt(safe_read_through),
                                ),
                        ),
                    )
                    .set(group_membership::last_reactions_read_revision.eq(safe_read_through))
                    .execute(conn)?;
                }
            }
            let list =
                self.list_chat_unread_reactions(conn, uid, chat_id, thread_root_id, limit)?;
            Ok((list.unread_reactions, list))
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
        now: DateTime<Utc>,
    ) -> Result<UnreadSummaryCounts, DieselError> {
        self.count_membership_unread_summary_with_loader(memberships, now, |chat_ids| {
            Self::load_chat_unread_snapshots(conn, chat_ids)
        })
    }

    fn count_membership_unread_summary_with_loader<E>(
        &self,
        memberships: &[ChatUnreadMembership],
        now: DateTime<Utc>,
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

            if membership
                .muted_until
                .map(|muted_until| muted_until > now)
                .unwrap_or(false)
            {
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
        now: DateTime<Utc>,
    ) -> Result<HashMap<i32, i64>, DieselError> {
        self.count_user_membership_unread_totals_with_loader(
            target_uids,
            memberships,
            now,
            |chat_ids| Self::load_chat_unread_snapshots(conn, chat_ids),
        )
    }

    fn count_user_membership_unread_totals_with_loader<E>(
        &self,
        target_uids: &[i32],
        memberships: &[UserChatUnreadMembership],
        now: DateTime<Utc>,
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
            .filter(|membership| {
                membership
                    .muted_until
                    .map(|muted_until| muted_until <= now)
                    .unwrap_or(true)
            })
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
        use crate::schema::group_membership::dsl as gm_dsl;

        let rows = group_membership::table
            .filter(gm_dsl::uid.eq(uid))
            .select((
                gm_dsl::chat_id,
                gm_dsl::last_read_message_id,
                gm_dsl::archived,
                gm_dsl::muted_until,
            ))
            .load::<(i64, Option<i64>, bool, Option<DateTime<Utc>>)>(conn)?;

        Ok(rows
            .into_iter()
            .map(
                |(chat_id, last_read_message_id, archived, muted_until)| ChatUnreadMembership {
                    chat_id,
                    last_read_message_id,
                    archived,
                    muted_until,
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

        use crate::schema::group_membership::dsl as gm_dsl;

        let rows = group_membership::table
            .filter(gm_dsl::uid.eq_any(target_uids))
            .select((
                gm_dsl::uid,
                gm_dsl::chat_id,
                gm_dsl::last_read_message_id,
                gm_dsl::archived,
                gm_dsl::muted_until,
            ))
            .load::<(i32, i64, Option<i64>, bool, Option<DateTime<Utc>>)>(conn)?;

        Ok(rows
            .into_iter()
            .map(
                |(uid, chat_id, last_read_message_id, archived, muted_until)| {
                    UserChatUnreadMembership {
                        uid,
                        chat_id,
                        last_read_message_id,
                        archived,
                        muted_until,
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
            muted_until,
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
            muted_until,
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
            service.count_membership_unread_summary_with_loader(&memberships, now, |chat_ids| {
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
                now,
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
        let now = Utc::now();
        let memberships = vec![
            user_membership(10, 1, Some(0), false, None),
            user_membership(10, 2, Some(0), false, None),
            user_membership(11, 2, Some(0), false, None),
        ];

        let totals: Result<std::collections::HashMap<i32, i64>, ()> = service
            .count_user_membership_unread_totals_with_loader(
                &[10, 11],
                &memberships,
                now,
                |chat_ids| {
                    let mut rows = Vec::new();
                    for chat_id in chat_ids {
                        match *chat_id {
                            1 => {
                                for id in 1..=(MAX_UNREAD_COUNT + 10) {
                                    rows.push(batch_snapshot(1, id, true));
                                }
                            }
                            2 => rows
                                .extend([batch_snapshot(2, 1, true), batch_snapshot(2, 2, true)]),
                            _ => {}
                        }
                    }
                    Ok(rows)
                },
            );

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

    /// Reactions created after the client's id snapshot (revision > watermark)
    /// must stay unread when the client acknowledges that watermark. This is
    /// the watermark boundary contract the PWA pass/acknowledge flow relies on.
    /// Requires a test database (`WETTY_TEST_DATABASE_URL`); skipped otherwise.
    #[test]
    fn reaction_ack_covers_only_reactions_below_the_watermark() {
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

        static SEQ: AtomicI64 = AtomicI64::new(9_876_576_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let author_msg_a = SEQ.fetch_add(1, Ordering::SeqCst);
        let author_msg_b = SEQ.fetch_add(1, Ordering::SeqCst);
        let author_msg_c = SEQ.fetch_add(1, Ordering::SeqCst);
        let author: i32 = 4245;
        let actor: i32 = 4246;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'reaction-ack-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(author)
                .execute(conn)?;
            for msg_id in [author_msg_a, author_msg_b, author_msg_c] {
                diesel::sql_query(
                    "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) \
                     VALUES ($1, 'text', $2, $3, $4, NOW())",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Text, _>(format!("cg-{chat_id}-{msg_id}"))
                .bind::<diesel::sql_types::Integer, _>(author)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            }
            let insert_reaction = |conn: &mut PgConnection, msg_id: i64| -> Result<(), diesel::result::Error> {
                diesel::sql_query(
                    "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid) \
                     VALUES ($1, $2, '👍', NOW(), $3)",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Integer, _>(actor)
                .bind::<diesel::sql_types::Integer, _>(author)
                .execute(conn)?;
                Ok(())
            };

            // Snapshot batch: reactions on messages A and B.
            insert_reaction(conn, author_msg_a)?;
            insert_reaction(conn, author_msg_b)?;

            let snapshot = service.list_chat_unread_reactions(conn, author, chat_id, None, 100)?;
            assert_eq!(snapshot.message_ids, vec![author_msg_a, author_msg_b]);
            assert!(snapshot.watermark > 0);
            assert_eq!(service.count_chat_unread_reactions(conn, author, chat_id, None)?, 2);

            // A new reaction lands on message C AFTER the snapshot: its
            // revision is above the snapshot watermark.
            insert_reaction(conn, author_msg_c)?;

            // Acknowledging the snapshot watermark clears only the listed
            // messages; message C survives.
            let (unread, post_ack) = service.acknowledge_chat_unread_reactions(
                conn, author, chat_id, None, snapshot.watermark, 100,
            )?;
            assert_eq!(unread, 1);
            assert_eq!(post_ack.message_ids, vec![author_msg_c]);
            assert_eq!(
                service.count_chat_unread_reactions(conn, author, chat_id, None)?,
                1
            );

            // A second reaction on an already-acked message still counts as one
            // distinct message unit and stays unread.
            diesel::sql_query(
                "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid) \
                 VALUES ($1, $2, '🎉', NOW(), $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(author_msg_c)
            .bind::<diesel::sql_types::Integer, _>(4247)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            assert_eq!(
                service.count_chat_unread_reactions(conn, author, chat_id, None)?,
                1
            );

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }

    /// The acknowledge cursor is monotonic: repeated or older watermarks are
    /// no-ops, and reactions created after an acknowledged watermark remain
    /// unread when the old watermark is replayed.
    /// Requires a test database (`WETTY_TEST_DATABASE_URL`); skipped otherwise.
    #[test]
    fn reaction_ack_is_idempotent_and_never_regresses() {
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

        static SEQ: AtomicI64 = AtomicI64::new(9_876_598_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let author_msg_a = SEQ.fetch_add(1, Ordering::SeqCst);
        let author_msg_b = SEQ.fetch_add(1, Ordering::SeqCst);
        let author: i32 = 4248;
        let actor: i32 = 4249;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'reaction-ack-idempotent')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(author)
                .execute(conn)?;
            for msg_id in [author_msg_a, author_msg_b] {
                diesel::sql_query(
                    "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) \
                     VALUES ($1, 'text', $2, $3, $4, NOW())",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Text, _>(format!("cg-{chat_id}-{msg_id}"))
                .bind::<diesel::sql_types::Integer, _>(author)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            }
            diesel::sql_query(
                "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid) \
                 VALUES ($1, $2, '👍', NOW(), $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(author_msg_a)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;

            let snapshot = service.list_chat_unread_reactions(conn, author, chat_id, None, 100)?;
            assert_eq!(snapshot.message_ids, vec![author_msg_a]);

            // Repeating the same acknowledge is a no-op.
            let (first, _) = service.acknowledge_chat_unread_reactions(
                conn, author, chat_id, None, snapshot.watermark, 100,
            )?;
            assert_eq!(first, 0);
            let (second, _) = service.acknowledge_chat_unread_reactions(
                conn, author, chat_id, None, snapshot.watermark, 100,
            )?;
            assert_eq!(second, 0);

            // A new reaction arrives, then the OLD watermark is replayed: the
            // cursor must not regress and the new reaction stays unread.
            diesel::sql_query(
                "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid) \
                 VALUES ($1, $2, '👍', NOW(), $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(author_msg_b)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            let (replayed, _) = service.acknowledge_chat_unread_reactions(
                conn, author, chat_id, None, snapshot.watermark, 100,
            )?;
            assert_eq!(replayed, 1);
            assert_eq!(
                service.count_chat_unread_reactions(conn, author, chat_id, None)?,
                1
            );

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }

    /// A forged `read_through` is clamped to the user's own eligible reactions
    /// only: other members' reactions (on their own messages, or
    /// self-reactions) neither raise the bound nor get cleared, and reactions
    /// that arrive later — including on the same message — stay unread.
    /// Requires a test database (`WETTY_TEST_DATABASE_URL`); skipped otherwise.
    #[test]
    fn reaction_ack_clamps_forged_read_through_to_own_eligible_reactions() {
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

        static SEQ: AtomicI64 = AtomicI64::new(9_876_631_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let author_msg = SEQ.fetch_add(1, Ordering::SeqCst);
        let other_msg = SEQ.fetch_add(1, Ordering::SeqCst);
        let author: i32 = 4254;
        let actor: i32 = 4255;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'reaction-ack-clamp-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(author)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(actor)
                .execute(conn)?;
            for (msg_id, sender) in [(author_msg, author), (other_msg, actor)] {
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
            let insert_reaction = |conn: &mut PgConnection,
                                   msg_id: i64,
                                   reactor: i32,
                                   msg_author: i32,
                                   emoji: &str|
             -> Result<(), diesel::result::Error> {
                diesel::sql_query(
                    "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid) \
                     VALUES ($1, $2, $4, NOW(), $3)",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Integer, _>(reactor)
                .bind::<diesel::sql_types::Integer, _>(msg_author)
                .bind::<diesel::sql_types::Text, _>(emoji)
                .execute(conn)?;
                Ok(())
            };

            // The author's one eligible unread reaction...
            insert_reaction(conn, author_msg, actor, author, "👍")?;
            // ...followed by reactions outside the author's unread scope that
            // carry HIGHER revisions: a reaction on the actor's own message and
            // the author's self-reaction.
            insert_reaction(conn, other_msg, actor, actor, "👍")?;
            insert_reaction(conn, author_msg, author, author, "👍")?;

            // Forged acknowledge with an absurd read_through: the cursor must
            // stop at the author's eligible maximum, not the chat-wide one.
            let (unread, post_ack) =
                service.acknowledge_chat_unread_reactions(conn, author, chat_id, None, i64::MAX, 100)?;
            assert_eq!(unread, 0);
            assert!(post_ack.message_ids.is_empty());

            // The cursor sits at the eligible bound, so a later eligible
            // reaction (new revision, above every existing one) stays unread —
            // the forged value suppressed nothing.
            insert_reaction(conn, author_msg, actor, author, "🎉")?;
            assert_eq!(
                service.count_chat_unread_reactions(conn, author, chat_id, None)?,
                1
            );

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }

    /// With more matching messages than `limit`, the watermark stops before the
    /// oldest unlisted message so acknowledging it never clears unlisted
    /// reactions, and the id list is ordered oldest-unread-first.
    /// Requires a test database (`WETTY_TEST_DATABASE_URL`); skipped otherwise.
    #[test]
    fn reaction_list_boundary_is_safe_when_truncated() {
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

        static SEQ: AtomicI64 = AtomicI64::new(9_876_610_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let msg_a = SEQ.fetch_add(1, Ordering::SeqCst);
        let msg_b = SEQ.fetch_add(1, Ordering::SeqCst);
        let msg_c = SEQ.fetch_add(1, Ordering::SeqCst);
        let author: i32 = 4250;
        let actor: i32 = 4251;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'reaction-limit-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(author)
                .execute(conn)?;
            for msg_id in [msg_a, msg_b, msg_c] {
                diesel::sql_query(
                    "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) \
                     VALUES ($1, 'text', $2, $3, $4, NOW())",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Text, _>(format!("cg-{chat_id}-{msg_id}"))
                .bind::<diesel::sql_types::Integer, _>(author)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
                diesel::sql_query(
                    "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid) \
                     VALUES ($1, $2, '👍', NOW(), $3)",
                )
                .bind::<diesel::sql_types::BigInt, _>(msg_id)
                .bind::<diesel::sql_types::Integer, _>(actor)
                .bind::<diesel::sql_types::Integer, _>(author)
                .execute(conn)?;
            }

            let page = service.list_chat_unread_reactions(conn, author, chat_id, None, 2)?;
            assert_eq!(page.message_ids, vec![msg_a, msg_b]);

            // Acknowledging the truncated page's watermark leaves the unlisted
            // message unread.
            let (unread, _) = service.acknowledge_chat_unread_reactions(
                conn, author, chat_id, None, page.watermark, 100,
            )?;
            assert_eq!(unread, 1);
            let remaining = service.list_chat_unread_reactions(conn, author, chat_id, None, 100)?;
            assert_eq!(remaining.message_ids, vec![msg_c]);

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }

    /// Thread-scope reactions use the same watermark contract, creating the
    /// per-thread cursor row on demand.
    /// Requires a test database (`WETTY_TEST_DATABASE_URL`); skipped otherwise.
    #[test]
    fn thread_scope_reaction_acknowledgement_matches_chat_scope() {
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

        static SEQ: AtomicI64 = AtomicI64::new(9_876_622_000);
        let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let thread_root_id = SEQ.fetch_add(1, Ordering::SeqCst);
        let my_thread_msg = SEQ.fetch_add(1, Ordering::SeqCst);
        let author: i32 = 4252;
        let actor: i32 = 4253;
        let service = UnreadService::new();

        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'reaction-thread-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .bind::<diesel::sql_types::Integer, _>(author)
                .execute(conn)?;
            // The thread root is authored by someone else; the reacted message
            // is the author's reply inside the thread.
            diesel::sql_query(
                "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) \
                 VALUES ($1, 'text', $2, $3, $4, NOW())",
            )
            .bind::<diesel::sql_types::BigInt, _>(thread_root_id)
            .bind::<diesel::sql_types::Text, _>(format!("cg-root-{thread_root_id}"))
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, reply_root_id) \
                 VALUES ($1, 'text', $2, $3, $4, NOW(), $5)",
            )
            .bind::<diesel::sql_types::BigInt, _>(my_thread_msg)
            .bind::<diesel::sql_types::Text, _>(format!("cg-reply-{my_thread_msg}"))
            .bind::<diesel::sql_types::Integer, _>(author)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::BigInt, _>(thread_root_id)
            .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid) \
                 VALUES ($1, $2, '👍', NOW(), $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(my_thread_msg)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;

            // No thread_user_states row yet: the snapshot lists the reaction
            // and the acknowledge creates the cursor row on demand.
            let snapshot =
                service.list_chat_unread_reactions(conn, author, chat_id, Some(thread_root_id), 100)?;
            assert_eq!(snapshot.message_ids, vec![my_thread_msg]);

            let (unread, post_ack) = service.acknowledge_chat_unread_reactions(
                conn, author, chat_id, Some(thread_root_id), snapshot.watermark, 100,
            )?;
            assert_eq!(unread, 0);
            assert!(post_ack.message_ids.is_empty());
            assert_eq!(
                service.count_chat_unread_reactions(conn, author, chat_id, Some(thread_root_id))?,
                0
            );

            Err(diesel::result::Error::RollbackTransaction)
        });

        assert!(
            matches!(result, Err(diesel::result::Error::RollbackTransaction)),
            "transaction should roll back"
        );
    }
}
