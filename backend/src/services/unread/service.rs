use std::collections::HashMap;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::result::Error as DieselError;
use diesel::sql_query;
use diesel::PgConnection;

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

#[derive(Default)]
pub struct UnreadService;

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
        Self
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
        Ok(Self::count_chat_unread_cursors(
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
        let counts = Self::count_chat_unread_cursors(
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

    fn count_membership_unread_summary(
        &self,
        conn: &mut PgConnection,
        memberships: &[ChatUnreadMembership],
    ) -> Result<UnreadSummaryCounts, DieselError> {
        let counts = Self::count_chat_unread_cursors(
            conn,
            memberships.iter().map(|membership| ChatUnreadCursor {
                hide_membership_messages: membership.hide_membership_messages,
                chat_id: membership.chat_id,
                last_read_message_id: unread_cursor(membership.last_read_message_id),
            }),
        )?;
        Ok(summarize_membership_unreads(memberships, &counts))
    }

    fn count_user_membership_unread_totals(
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
        let counts = Self::count_chat_unread_cursors(
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
            *current = capped_add(*current, count);
        }

        Ok(totals)
    }

    /// Deduplicates `(chat_id, cursor, visibility)` and batches each visibility
    /// into a fixed-predicate statement. Each range probe stops at the unread cap.
    pub(super) fn count_chat_unread_cursors(
        conn: &mut PgConnection,
        cursors: impl IntoIterator<Item = ChatUnreadCursor>,
    ) -> Result<HashMap<ChatUnreadCursor, i64>, DieselError> {
        let (hidden, shown): (Vec<_>, Vec<_>) = cursors
            .into_iter()
            .partition(|cursor| cursor.hide_membership_messages);
        let mut counts = Self::count_chat_unread_cursors_with_filter(conn, hidden, true)?;
        counts.extend(Self::count_chat_unread_cursors_with_filter(
            conn, shown, false,
        )?);
        Ok(counts)
    }

    fn count_chat_unread_cursors_with_filter(
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
                     LIMIT $3
                 ) unread
             ) counts",
        ))
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(chat_ids)
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(last_read_message_ids)
        .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT)
        .load::<ChatUnreadCountRow>(conn)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    ChatUnreadCursor {
                        hide_membership_messages,
                        chat_id: row.chat_id,
                        last_read_message_id: row.last_read_message_id,
                    },
                    row.unread_count,
                )
            })
            .collect())
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
            )>(conn)?;
        Ok(rows
            .into_iter()
            .map(
                |(uid, chat_id, last_read_message_id, archived, setting, kind, allowed, show)| {
                    UserChatUnreadMembership {
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
mod tests {
    use chrono::{Duration, Utc};

    use super::{
        summarize_membership_unreads, ChatUnreadCursor, ChatUnreadMembership, UnreadService,
    };
    use crate::constants::MAX_UNREAD_COUNT;

    fn membership(
        chat_id: i64,
        last_read_message_id: Option<i64>,
        archived: bool,
        muted_until: Option<chrono::DateTime<Utc>>,
    ) -> ChatUnreadMembership {
        ChatUnreadMembership {
            hide_membership_messages: false,
            chat_id,
            last_read_message_id,
            archived,
            is_muted: muted_until.is_some_and(|until| until > Utc::now()),
        }
    }

    #[test]
    fn summary_separates_archives_and_excludes_currently_muted_chats() {
        let now = Utc::now();
        let memberships = [
            membership(1, Some(10), false, None),
            membership(2, None, false, Some(now + Duration::minutes(1))),
            membership(3, None, true, Some(now + Duration::minutes(1))),
        ];
        let counts = [
            (
                ChatUnreadCursor {
                    hide_membership_messages: false,
                    chat_id: 1,
                    last_read_message_id: 10,
                },
                MAX_UNREAD_COUNT,
            ),
            (
                ChatUnreadCursor {
                    hide_membership_messages: false,
                    chat_id: 2,
                    last_read_message_id: i64::MIN,
                },
                3,
            ),
            (
                ChatUnreadCursor {
                    hide_membership_messages: false,
                    chat_id: 3,
                    last_read_message_id: i64::MIN,
                },
                1,
            ),
        ]
        .into_iter()
        .collect();

        assert_eq!(
            summarize_membership_unreads(&memberships, &counts),
            super::UnreadSummaryCounts {
                unread_count: MAX_UNREAD_COUNT,
                archived_unread_count: 1,
                unread_chat_count: 1,
                archived_unread_chat_count: 1,
            }
        );
    }

    #[test]
    fn chat_unread_uses_visible_messages_and_live_mutations() {
        use diesel::Connection;
        use diesel::RunQueryDsl;
        use std::sync::atomic::{AtomicI64, Ordering};

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = diesel::PgConnection::establish(&url).expect("connect to test database");
        static SEQ: AtomicI64 = AtomicI64::new(9_876_400_000);
        let chat_id = SEQ.fetch_add(MAX_UNREAD_COUNT + 10, Ordering::SeqCst);
        let first_id = chat_id + 1;

        conn.test_transaction::<(), diesel::result::Error, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'unread-visible-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO messages
                    (id, message_type, client_generated_id, sender_uid, chat_id, is_published, created_at)
                 SELECT $1 + n, 'text', ($1 + n)::text, -5, $2, TRUE, NOW()
                 FROM generate_series(0::BIGINT, $3) n",
            )
            .bind::<diesel::sql_types::BigInt, _>(first_id)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT + 4)
            .execute(conn)?;

            let service = UnreadService::new();
            assert_eq!(service.count_chat_unread(conn, 1717, chat_id, None)?, MAX_UNREAD_COUNT);
            let cursor = first_id + MAX_UNREAD_COUNT;
            assert_eq!(service.count_chat_unread(conn, 1717, chat_id, Some(cursor))?, 4);

            diesel::sql_query(
                "INSERT INTO group_membership (chat_id, uid, last_read_message_id, archived, muted_until)
                 VALUES ($1, 891001, $2, FALSE, NULL),
                        ($1, 891002, $2 - 1, FALSE, NULL),
                        ($1, 891003, $2, FALSE, NOW() + INTERVAL '1 hour'),
                        ($1, 891004, NULL, TRUE, NULL),
                        ($1, 891005, $2, FALSE, NULL),
                        ($1, 891007, NULL, FALSE, NULL)",
            )
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::BigInt, _>(cursor)
            .execute(conn)?;
            let totals = service.count_users_unread_totals(
                conn,
                &[891001, 891002, 891003, 891004, 891005, 891006, 891007],
            )?;
            assert_eq!(totals[&891001], 4);
            assert_eq!(totals[&891002], 5);
            assert_eq!(totals[&891003], 0);
            assert_eq!(totals[&891004], 0);
            assert_eq!(totals[&891005], 4);
            assert_eq!(totals[&891006], 0);
            assert_eq!(totals[&891007], MAX_UNREAD_COUNT);

            diesel::sql_query(
                "UPDATE messages
                 SET deleted_at = CASE WHEN id = $2 THEN NOW() ELSE deleted_at END,
                     is_published = CASE WHEN id = $3 THEN FALSE ELSE is_published END,
                     reply_root_id = CASE WHEN id = $4 THEN $1 ELSE reply_root_id END
                 WHERE id IN ($2, $3, $4)",
            )
            .bind::<diesel::sql_types::BigInt, _>(first_id)
            .bind::<diesel::sql_types::BigInt, _>(cursor + 1)
            .bind::<diesel::sql_types::BigInt, _>(cursor + 2)
            .bind::<diesel::sql_types::BigInt, _>(cursor + 3)
            .execute(conn)?;
            assert_eq!(service.count_chat_unread(conn, 1717, chat_id, Some(cursor))?, 1);

            diesel::sql_query("UPDATE messages SET is_published = TRUE WHERE id = $1")
                .bind::<diesel::sql_types::BigInt, _>(cursor + 2)
                .execute(conn)?;
            assert_eq!(service.count_chat_unread(conn, 1717, chat_id, Some(cursor))?, 2);
            diesel::sql_query("UPDATE messages SET deleted_at = NOW() WHERE id = $1")
                .bind::<diesel::sql_types::BigInt, _>(cursor + 4)
                .execute(conn)?;
            assert_eq!(service.count_chat_unread(conn, 1717, chat_id, Some(cursor))?, 1);
            Ok(())
        });
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
