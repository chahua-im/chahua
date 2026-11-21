use std::collections::HashSet;

use chrono::{DateTime, Utc};
use diesel::{
    prelude::*,
    sql_types::{BigInt, Integer},
};
use uuid::Uuid;

use crate::{
    dto::{
        list_sync::{ListSyncRemoval, ListSyncResetReason as ResetReason, ListSyncResponse},
        users::ChatSettings,
    },
    errors::AppError,
    metrics::ApiStages,
    models::Message,
    schema::{list_sync_account as account, list_sync_meta as meta, messages},
    services::{
        api::{chats::build_chat_list_items, threads::build_thread_list_items},
        avatars::AvatarService,
        chat_list::load_chat_rows_by_ids,
        media::MediaStore,
        messages::attach_metadata,
        notification_preferences::{load_notification_defaults, NotificationDefaults},
        sync_cursor::CursorKey,
        sync_projection::check_projection,
        threads::load_thread_rows_by_roots,
        unread::UnreadService,
        user::load_chat_settings,
    },
};

use super::cursor::{self, Key, Mode, Position};

const PAGE_SIZE: usize = 100;
const MAX_POSITION_KEYS: usize = 1000;

// Branch limits let each ordered account index stop early. The boundary is an
// immutable literal tuple, never a lookup of a previous page's mutable row.
const BASELINE_KEYS_SQL: &str = "SELECT chat_id, thread_root_id FROM (
    (SELECT gm.chat_id, 0::bigint AS thread_root_id
     FROM group_membership gm
     WHERE gm.uid = $1 AND (gm.chat_id, 0::bigint) > ($2, $3)
     ORDER BY gm.chat_id LIMIT $4)
    UNION ALL
    (SELECT ts.chat_id, ts.thread_root_id
     FROM thread_user_states ts
     JOIN LATERAL (
         SELECT 1 FROM group_membership gm
         WHERE gm.uid = ts.uid AND gm.chat_id = ts.chat_id LIMIT 1
     ) membership ON true
     JOIN LATERAL (
         SELECT 1 FROM messages root
         WHERE root.id = ts.thread_root_id AND root.chat_id = ts.chat_id
           AND root.reply_root_id IS NULL AND root.has_thread AND root.is_published LIMIT 1
     ) eligible ON true
     WHERE ts.uid = $1 AND ts.subscribed
       AND (ts.chat_id, ts.thread_root_id) > ($2, $3)
     ORDER BY ts.chat_id, ts.thread_root_id LIMIT $4)
) keys ORDER BY chat_id, thread_root_id LIMIT $4";

// Bound transfer in SQL before enrichment. MAX coalesces current stamps, not
// history. A chat identity stamp expands only the viewer's subscribed threads.
// Each shared lookup is parameterized by an account key and returns at most
// one primary-key row. The lateral bounds prevent a global shared-table scan
// when PostgreSQL estimates that an almost-empty position range is selective.
// The result cap still does not bound every account index entry inspected.
const DELTA_KEYS_SQL: &str = "SELECT chat_id, thread_root_id, max(position) AS position FROM (
    SELECT p.chat_id, p.thread_root_id, p.seq AS position
    FROM list_sync_personal p
    WHERE p.uid = $1 AND p.seq > $2 AND p.seq <= $3
    UNION ALL
    SELECT s.chat_id, s.thread_root_id, s.seq
    FROM group_membership gm
    JOIN LATERAL (
        SELECT s.chat_id, s.thread_root_id, s.seq FROM list_sync_shared s
        WHERE s.chat_id = gm.chat_id AND s.thread_root_id = 0
          AND s.seq > $2 AND s.seq <= $3 LIMIT 1
    ) s ON true
    WHERE gm.uid = $1
    UNION ALL
    SELECT s.chat_id, s.thread_root_id, s.seq
    FROM thread_user_states ts
    JOIN group_membership gm ON gm.uid = ts.uid AND gm.chat_id = ts.chat_id
    JOIN LATERAL (
        SELECT s.chat_id, s.thread_root_id, s.seq FROM list_sync_shared s
        WHERE s.chat_id = ts.chat_id AND s.thread_root_id = ts.thread_root_id
          AND s.seq > $2 AND s.seq <= $3 LIMIT 1
    ) s ON true
    WHERE ts.uid = $1 AND ts.subscribed
    UNION ALL
    SELECT ts.chat_id, ts.thread_root_id, s.identity_seq
    FROM thread_user_states ts
    JOIN group_membership gm ON gm.uid = ts.uid AND gm.chat_id = ts.chat_id
    JOIN LATERAL (
        SELECT s.identity_seq FROM list_sync_shared s
        WHERE s.chat_id = ts.chat_id AND s.thread_root_id = 0
          AND s.identity_seq > $2 AND s.identity_seq <= $3 LIMIT 1
    ) s ON true
    WHERE ts.uid = $1 AND ts.subscribed
) changed GROUP BY chat_id, thread_root_id
ORDER BY position, chat_id, thread_root_id LIMIT 1001";

#[derive(QueryableByName)]
struct Candidate {
    #[diesel(embed)]
    key: Key,
    #[diesel(sql_type = BigInt)]
    position: i64,
}

pub(crate) struct Reader<'a> {
    pub key: &'a CursorKey,
    pub unread: &'a UnreadService,
    pub media: &'a MediaStore,
    pub avatars: &'a AvatarService,
    pub stages: ApiStages<'a>,
}

impl Reader<'_> {
    pub(crate) fn difference(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        cursor: Option<&str>,
    ) -> Result<ListSyncResponse, AppError> {
        self.difference_with_limit(conn, uid, cursor, PAGE_SIZE)
    }

    pub(super) fn difference_with_limit(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ListSyncResponse, AppError> {
        let now = Utc::now();
        conn.build_transaction()
            .read_only()
            .repeatable_read()
            .run(|conn| {
                let response = self.read_page(conn, uid, cursor, limit, now)?;
                // All exit paths, including resets and empty pages, must reject a
                // transaction poisoned by a legacy projection's swallowed SQL error.
                check_projection(conn)?;
                Ok(response)
            })
    }

    fn read_page(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        token: Option<&str>,
        limit: usize,
        now: DateTime<Utc>,
    ) -> Result<ListSyncResponse, AppError> {
        let phase = self.stages.start("settings");
        let settings = load_chat_settings(conn, uid)?;
        let defaults = load_notification_defaults(conn, uid)?;
        let (epoch, head, retained_after): (Uuid, i64, i64) = meta::table
            .filter(meta::singleton.eq(true))
            .select((meta::epoch, meta::head, meta::retained_after))
            .first(conn)?;
        let account_seq = account::table
            .find(uid)
            .select(account::seq)
            .first::<i64>(conn)
            .optional()?
            .unwrap_or(0);
        drop(phase);
        let current = Position {
            e: epoch,
            u: uid,
            s: head,
            mode: Mode::Delta,
        };
        let mut response = Self::empty(settings, defaults);
        let from = match cursor::validate(self.key, current, retained_after, account_seq, token) {
            Ok(from) => from,
            Err(reason) => return Ok(self.reset(current, settings, defaults, reason)),
        };
        let phase = self.stages.start("keys");
        let keys = match from.mode {
            Mode::Baseline { last } => {
                let last = last.unwrap_or(Key {
                    chat_id: 0,
                    thread_root_id: 0,
                });
                let mut keys = diesel::sql_query(BASELINE_KEYS_SQL)
                    .bind::<Integer, _>(uid)
                    .bind::<BigInt, _>(last.chat_id)
                    .bind::<BigInt, _>(last.thread_root_id)
                    .bind::<BigInt, _>((limit + 1) as i64)
                    .load::<Key>(conn)?;
                let more = keys.len() > limit;
                keys.truncate(limit);
                let next = if more {
                    Mode::Baseline {
                        last: keys.last().copied(),
                    }
                } else {
                    Mode::Delta
                };
                response.cursor = self.key.encode(&Position { mode: next, ..from });
                // Finishing enumeration is not catch-up. Always replay from its
                // original head, including an empty final baseline page.
                response.complete = false;
                keys
            }
            Mode::Delta => {
                if from.s == head {
                    response.cursor = self.key.encode(&current);
                    return Ok(response);
                }
                let mut candidates = diesel::sql_query(DELTA_KEYS_SQL)
                    .bind::<Integer, _>(uid)
                    .bind::<BigInt, _>(from.s)
                    .bind::<BigInt, _>(head)
                    .load::<Candidate>(conn)?;
                let count = match position_prefix(&candidates, limit) {
                    Ok(count) => count,
                    Err(reason) => return Ok(self.reset(current, settings, defaults, reason)),
                };
                response.complete = count == candidates.len();
                let through = if response.complete {
                    head
                } else {
                    candidates[count - 1].position
                };
                response.cursor = self.key.encode(&Position {
                    s: through,
                    ..current
                });
                candidates.truncate(count);
                candidates
                    .into_iter()
                    .map(|candidate| candidate.key)
                    .collect()
            }
        };
        drop(phase);
        self.project(conn, uid, &keys, settings, defaults, now, &mut response)?;
        Ok(response)
    }

    fn empty(settings: ChatSettings, defaults: NotificationDefaults) -> ListSyncResponse {
        ListSyncResponse {
            cursor: String::new(),
            complete: true,
            reset: None,
            chat_settings: settings,
            notification_settings: defaults.into(),
            chats: Vec::new(),
            threads: Vec::new(),
            latest_messages: Vec::new(),
            removed: Vec::new(),
        }
    }

    fn reset(
        &self,
        current: Position,
        settings: ChatSettings,
        defaults: NotificationDefaults,
        reason: ResetReason,
    ) -> ListSyncResponse {
        let mut response = Self::empty(settings, defaults);
        response.cursor = self.key.encode(&Position {
            mode: Mode::Baseline { last: None },
            ..current
        });
        response.complete = false;
        response.reset = Some(reason);
        response
    }

    #[allow(clippy::too_many_arguments)]
    fn project(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        keys: &[Key],
        settings: ChatSettings,
        defaults: NotificationDefaults,
        now: DateTime<Utc>,
        response: &mut ListSyncResponse,
    ) -> Result<(), AppError> {
        if keys.is_empty() {
            return Ok(());
        }
        let phase = self.stages.start("projection");
        let mut chat_ids = Vec::new();
        let mut root_ids = Vec::new();
        for key in keys {
            if key.thread_root_id == 0 {
                chat_ids.push(key.chat_id);
            } else {
                root_ids.push(key.thread_root_id);
            }
        }
        let rows = load_chat_rows_by_ids(conn, uid, &chat_ids, !settings.show_membership_messages)?;
        // Keep the selected visible IDs before preview construction consumes the
        // rows. Never independently choose a newer, possibly hidden tail.
        let latest_ids: Vec<i64> = rows
            .iter()
            .filter_map(|row| row.last_message.as_ref().map(|message| message.id))
            .collect();
        response.chats = build_chat_list_items(
            rows,
            uid,
            settings,
            defaults,
            now,
            conn,
            self.unread,
            self.media,
            self.avatars,
            self.stages,
        )?;
        let rows = load_thread_rows_by_roots(conn, uid, &root_ids)?;
        response.threads =
            build_thread_list_items(conn, rows, false, uid, self.media, self.avatars)?.threads;
        if !latest_ids.is_empty() {
            let messages = messages::table
                .filter(messages::id.eq_any(latest_ids))
                .select(Message::as_select())
                .load(conn)?;
            response.latest_messages = futures::executor::block_on(attach_metadata(
                conn,
                messages,
                self.media,
                self.avatars,
                uid,
            ));
        }
        let visible: HashSet<Key> = response
            .chats
            .iter()
            .map(|chat| Key {
                chat_id: chat.id,
                thread_root_id: 0,
            })
            .chain(response.threads.iter().map(|thread| Key {
                chat_id: thread.chat_id,
                thread_root_id: thread.thread_root_message.id,
            }))
            .collect();
        response.removed = keys
            .iter()
            .filter(|key| !visible.contains(key))
            .map(|key| ListSyncRemoval {
                chat_id: key.chat_id,
                thread_id: (key.thread_root_id != 0).then_some(key.thread_root_id),
            })
            .collect();
        drop(phase);
        Ok(())
    }
}

fn position_prefix(candidates: &[Candidate], limit: usize) -> Result<usize, ResetReason> {
    let mut end = 0;
    while end < candidates.len() {
        let start = end;
        let position = candidates[start].position;
        while end < candidates.len() && candidates[end].position == position {
            end += 1;
        }
        if start == 0 && end > MAX_POSITION_KEYS {
            return Err(ResetReason::TooLarge);
        }
        if start > 0 && end > limit {
            return Ok(start);
        }
        if end >= limit {
            return Ok(end);
        }
    }
    Ok(end)
}
