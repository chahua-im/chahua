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
use crate::schema::group_membership;

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
}
