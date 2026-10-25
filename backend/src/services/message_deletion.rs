//! Shared batch deletion and reconciliation for recalls and member cleanup.

use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;
use diesel::prelude::*;

use crate::{
    errors::AppError,
    models::{Message, MessageType},
    schema::{attachments, group_membership, groups, message_mentions, messages},
    services::{chat, threads},
};

pub struct BulkDeletion {
    pub impact: DeletionImpact,
    pub member_uids: Vec<i32>,
    pub roots: Vec<Message>,
}

/// Only the columns needed for authorization and deletion bookkeeping.
#[derive(Queryable, Selectable)]
#[diesel(table_name = messages)]
pub struct DeletionTarget {
    pub id: i64,
    pub sender_uid: i32,
    pub is_published: bool,
    message_type: MessageType,
    reply_root_id: Option<i64>,
    has_thread: bool,
}

#[derive(Default)]
pub struct DeletionImpact {
    pub message_ids: Vec<i64>,
    pub thread_root_ids: BTreeSet<i64>,
    reply_ids: BTreeMap<i64, Vec<i64>>,
    chat_message_ids: Vec<i64>,
}

impl DeletionImpact {
    pub fn merge(&mut self, batch: Self) {
        self.message_ids.extend(batch.message_ids);
        self.thread_root_ids.extend(batch.thread_root_ids);
        self.chat_message_ids.extend(batch.chat_message_ids);
        for (root_id, ids) in batch.reply_ids {
            self.reply_ids.entry(root_id).or_default().extend(ids);
        }
    }
}

pub fn validate_deletable_message_type(message_type: &MessageType) -> Result<(), AppError> {
    if matches!(message_type, MessageType::System) {
        return Err(AppError::BadRequest("Cannot delete system message"));
    }
    Ok(())
}

/// The caller must load and lock targets from one chat in its transaction,
/// applying the entry point's authorization and publication rules first.
/// This function neither commits nor publishes events.
pub fn soft_delete_batch(
    conn: &mut PgConnection,
    targets: &[DeletionTarget],
) -> Result<DeletionImpact, AppError> {
    // Validate the entire batch before any writes or deletion bookkeeping.
    for message in targets {
        validate_deletable_message_type(&message.message_type)?;
    }
    let mut impact = DeletionImpact::default();
    for message in targets {
        impact.message_ids.push(message.id);
        if let Some(root_id) = message.reply_root_id {
            impact.thread_root_ids.insert(root_id);
            impact
                .reply_ids
                .entry(root_id)
                .or_default()
                .push(message.id);
        } else {
            impact.chat_message_ids.push(message.id);
            if message.has_thread {
                impact.thread_root_ids.insert(message.id);
            }
        }
    }

    let ids = &impact.message_ids;
    let now = Utc::now();
    diesel::update(
        messages::table
            .filter(messages::id.eq_any(ids))
            .filter(messages::deleted_at.is_null()),
    )
    .set(messages::deleted_at.eq(now))
    .execute(conn)?;
    diesel::delete(message_mentions::table.filter(message_mentions::message_id.eq_any(ids)))
        .execute(conn)?;
    diesel::update(
        attachments::table
            .filter(attachments::message_id.eq_any(ids))
            .filter(attachments::deleted_at.is_null()),
    )
    .set(attachments::deleted_at.eq(now))
    .execute(conn)?;
    Ok(impact)
}

/// Reconcile once for the complete deleted set, inside the caller's transaction.
/// Member cleanup merges its committed batches before calling this function.
pub fn reconcile_deletions(
    conn: &mut PgConnection,
    chat_id: i64,
    impact: &DeletionImpact,
) -> Result<(), AppError> {
    for (&root_id, deleted_ids) in &impact.reply_ids {
        threads::recalculate_thread_meta(conn, chat_id, root_id)?;
        threads::shift_thread_read_pointers_on_delete(conn, root_id, deleted_ids)?;
    }

    // Deleting the last reply can hide a previously deleted root outside the
    // selection. Re-read visibility after recalculating the thread statistics.
    let chat_ids: Vec<i64> = impact
        .chat_message_ids
        .iter()
        .chain(&impact.thread_root_ids)
        .copied()
        .collect();
    let hidden_chat_ids: Vec<i64> = messages::table
        .filter(messages::id.eq_any(&chat_ids))
        .filter(messages::has_thread.eq(false))
        .filter(messages::deleted_at.is_not_null())
        .select(messages::id)
        .load(conn)?;
    if !hidden_chat_ids.is_empty() {
        chat::shift_chat_read_pointers_on_delete(conn, chat_id, &hidden_chat_ids)?;
    }
    let last_id: Option<i64> = groups::table
        .find(chat_id)
        .select(groups::last_message_id)
        .first(conn)?;
    if last_id.is_some_and(|id| impact.message_ids.contains(&id)) {
        chat::recalculate_group_last_message(conn, chat_id)?;
    }
    Ok(())
}

pub fn validate_message_ids(mut ids: Vec<i64>) -> Result<Vec<i64>, AppError> {
    if ids.is_empty() || ids.len() > 100 {
        return Err(AppError::BadRequest("Select between 1 and 100 messages"));
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// The caller has checked chat membership and writability. Validate the entire
/// selection before writing; already deleted messages make retries idempotent.
pub fn delete_selection(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
    is_admin: bool,
    ids: &[i64],
) -> Result<BulkDeletion, AppError> {
    conn.transaction(|conn| {
        let selected: Vec<DeletionTarget> = messages::table
            .filter(messages::chat_id.eq(chat_id))
            .filter(messages::id.eq_any(ids))
            .order(messages::id.asc())
            .for_update()
            .select(DeletionTarget::as_select())
            .load(conn)?;
        if selected.len() != ids.len() {
            return Err(AppError::NotFound("Message not found"));
        }
        if !is_admin && selected.iter().any(|message| message.sender_uid != uid) {
            return Err(AppError::Forbidden("You can only delete your own messages"));
        }
        if selected.iter().any(|message| !message.is_published) {
            return Err(AppError::BadRequest("Cannot delete unpublished message"));
        }

        let impact = soft_delete_batch(conn, &selected)?;
        reconcile_deletions(conn, chat_id, &impact)?;

        let roots = messages::table
            .filter(messages::id.eq_any(&impact.thread_root_ids))
            .select(Message::as_select())
            .load(conn)?;
        let member_uids = group_membership::table
            .filter(group_membership::chat_id.eq(chat_id))
            .select(group_membership::uid)
            .load(conn)?;
        Ok(BulkDeletion {
            impact,
            member_uids,
            roots,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_messages_are_never_deletable() {
        assert!(matches!(
            validate_deletable_message_type(&MessageType::System),
            Err(AppError::BadRequest("Cannot delete system message"))
        ));
        for kind in [
            MessageType::Text,
            MessageType::Audio,
            MessageType::File,
            MessageType::Sticker,
            MessageType::Invite,
            MessageType::Forwarded,
            MessageType::Placeholder,
        ] {
            assert!(validate_deletable_message_type(&kind).is_ok());
        }
    }

    #[test]
    fn database_system_message_selection_is_rejected_before_any_writes() {
        use diesel::connection::SimpleConnection;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<(), AppError, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id, name) VALUES (87300, 'system-recall');
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, system_kind,
                                      client_generated_id, created_at, reply_root_id, is_published)
                 VALUES (87301, 87300, 1, 'text', NULL, 'system-recall-text', NOW(), NULL, true),
                        (87302, 87300, 1, 'system', 'member_joined', 'system-recall-member', NOW(), NULL, true),
                        (87303, 87300, 1, 'system', 'unknown', 'system-recall-unknown', NOW(), NULL, true),
                        (87304, 87300, 1, 'system', 'thread_message_pinned', 'system-recall-thread', NOW(), 87301, true);
                 UPDATE groups SET last_message_id = 87304 WHERE id = 87300;
                 INSERT INTO group_membership(chat_id, uid, last_read_message_id) VALUES (87300, 1, 87304);
                 INSERT INTO message_mentions(message_id, mentioned_uid, chat_id) VALUES (87301, 2, 87300);
                 INSERT INTO attachments(id, message_id, kind, external_reference, size, created_at)
                 VALUES (87310, 87301, 'text/plain', 'system-recall-attachment', 1, NOW());",
            )?;
            for system_id in [87302, 87303, 87304] {
                for (uid, is_admin) in [(1, false), (2, true)] {
                    for ids in [vec![system_id], vec![87301, system_id]] {
                        assert!(matches!(
                            delete_selection(conn, 87300, uid, is_admin, &ids),
                            Err(AppError::BadRequest("Cannot delete system message"))
                        ));
                    }
                }
            }
            // The shared helper must also reject callers that skip entry-point validation.
            let targets = messages::table
                .filter(messages::chat_id.eq(87300))
                .order(messages::id.asc())
                .for_update()
                .select(DeletionTarget::as_select())
                .load(conn)?;
            assert!(matches!(
                soft_delete_batch(conn, &targets),
                Err(AppError::BadRequest("Cannot delete system message"))
            ));
            assert_eq!(messages::table.filter(messages::chat_id.eq(87300))
                .filter(messages::deleted_at.is_not_null()).count().get_result::<i64>(conn)?, 0);
            assert_eq!(groups::table.find(87300_i64).select(groups::last_message_id)
                .first::<Option<i64>>(conn)?, Some(87304));
            assert_eq!(group_membership::table.find((87300_i64, 1)).select(group_membership::last_read_message_id)
                .first::<Option<i64>>(conn)?, Some(87304));
            assert_eq!(message_mentions::table.filter(message_mentions::chat_id.eq(87300))
                .count().get_result::<i64>(conn)?, 1);
            assert!(attachments::table.find(87310_i64).select(attachments::deleted_at)
                .first::<Option<chrono::DateTime<Utc>>>(conn)?.is_none());
            Ok(())
        });
    }

    #[test]
    fn selection_is_bounded_and_deduplicated() {
        assert!(validate_message_ids(vec![]).is_err());
        assert!(validate_message_ids(vec![1; 101]).is_err());
        assert!(validate_message_ids((1..=100).collect()).is_ok());
        assert_eq!(validate_message_ids(vec![3, 1, 3]).unwrap(), vec![1, 3]);
    }

    #[test]
    fn database_selection_is_atomic_and_reconciles_metadata() {
        use crate::schema::{thread_meta, thread_user_states};
        use diesel::connection::SimpleConnection;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<(), AppError, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id, name) VALUES (87100, 'bulk-recall'), (87200, 'other-chat');
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                      client_generated_id, created_at, reply_root_id, has_thread, is_published)
                 VALUES (87101, 87100, 1, 'text', 'previous', 'bulk-previous', NOW(), NULL, false, true),
                        (87102, 87100, 1, 'text', 'root', 'bulk-root', NOW(), NULL, true, true),
                        (87103, 87100, 1, 'text', 'reply', 'bulk-reply', NOW(), 87102, false, true),
                        (87104, 87100, 2, 'text', 'other reply', 'bulk-other-reply', NOW(), 87102, false, true),
                        (87105, 87100, 1, 'text', 'latest', 'bulk-latest', NOW(), NULL, false, true),
                        (87106, 87100, 1, 'audio', NULL, 'bulk-pending', NOW(), NULL, false, false),
                        (87201, 87200, 1, 'text', 'other chat', 'bulk-other-chat', NOW(), NULL, false, true);
                 UPDATE groups SET last_message_id = 87105, last_message_at = NOW() WHERE id = 87100;
                 INSERT INTO group_membership(chat_id, uid, last_read_message_id)
                 VALUES (87100, 1, 87105), (87100, 2, 87102);
                 INSERT INTO thread_user_states(chat_id, thread_root_id, uid, last_read_message_id)
                 VALUES (87100, 87102, 1, 87104);
                 INSERT INTO thread_meta(chat_id, thread_root_id, reply_count, last_reply_at)
                 VALUES (87100, 87102, 2, NOW());
                 INSERT INTO message_mentions(message_id, mentioned_uid, chat_id)
                 VALUES (87105, 2, 87100);
                 INSERT INTO attachments(id, message_id, kind, external_reference, size, created_at)
                 VALUES (87110, 87105, 'text/plain', 'bulk-test', 1, NOW());",
            )?;

            assert!(matches!(delete_selection(conn, 87100, 1, false, &[87103, 87104]), Err(AppError::Forbidden(_))));
            assert!(matches!(delete_selection(conn, 87100, 1, true, &[87103, 87201]), Err(AppError::NotFound(_))));
            assert!(matches!(delete_selection(conn, 87100, 1, true, &[87103, 99999]), Err(AppError::NotFound(_))));
            assert!(matches!(delete_selection(conn, 87100, 1, true, &[87103, 87106]), Err(AppError::BadRequest(_))));
            assert_eq!(messages::table.filter(messages::chat_id.eq(87100))
                .filter(messages::deleted_at.is_not_null()).count().get_result::<i64>(conn)?, 0);

            // A late reconciliation error must roll back both helpers' writes.
            conn.batch_execute(
                "CREATE FUNCTION pg_temp.reject_recall_summary() RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN RAISE EXCEPTION 'injected recall reconciliation failure'; END $$;
                 CREATE TRIGGER reject_recall_summary BEFORE UPDATE ON groups
                 FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_recall_summary();",
            )?;
            assert!(matches!(delete_selection(conn, 87100, 1, false, &[87103, 87105]), Err(AppError::DbQuery(_))));
            conn.batch_execute("DROP TRIGGER reject_recall_summary ON groups")?;
            assert_eq!(messages::table.filter(messages::chat_id.eq(87100))
                .filter(messages::deleted_at.is_not_null()).count().get_result::<i64>(conn)?, 0);
            assert_eq!(thread_meta::table.find((87100_i64, 87102_i64))
                .select(thread_meta::reply_count).first::<i64>(conn)?, 2);
            assert_eq!(message_mentions::table.filter(message_mentions::chat_id.eq(87100))
                .count().get_result::<i64>(conn)?, 1);
            assert!(attachments::table.find(87110_i64).select(attachments::deleted_at)
                .first::<Option<chrono::DateTime<Utc>>>(conn)?.is_none());

            // An ordinary sender can delete their own messages in a batch.
            delete_selection(conn, 87100, 1, false, &[87103, 87105])?;
            assert_eq!(thread_meta::table.find((87100_i64, 87102_i64))
                .select(thread_meta::reply_count).first::<i64>(conn)?, 1);
            // A deleted root remains visible while another reply survives.
            let root_deletion = delete_selection(conn, 87100, 1, false, &[87102])?;
            assert!(root_deletion.roots[0].has_thread);
            // Admin deletion includes another sender and an already deleted reply.
            // Removing the last reply must also shift readers off the old root.
            let ids = [87103, 87104, 87105];
            let result = delete_selection(conn, 87100, 1, true, &ids)?;
            assert_eq!(result.impact.message_ids, ids);
            assert_eq!(result.impact.thread_root_ids, BTreeSet::from([87102]));
            assert_eq!(result.member_uids.len(), 2);
            assert!(!result.roots[0].has_thread);
            assert!(result.roots[0].deleted_at.is_some());
            assert_eq!(groups::table.find(87100_i64).select(groups::last_message_id)
                .first::<Option<i64>>(conn)?, Some(87101));
            assert_eq!(group_membership::table.filter(group_membership::chat_id.eq(87100))
                .select(group_membership::last_read_message_id).load::<Option<i64>>(conn)?, vec![Some(87101); 2]);
            assert_eq!(thread_user_states::table.find((87100_i64, 87102_i64, 1))
                .select(thread_user_states::last_read_message_id).first::<Option<i64>>(conn)?, None);
            assert_eq!(thread_meta::table.filter(thread_meta::chat_id.eq(87100))
                .count().get_result::<i64>(conn)?, 0);
            assert_eq!(message_mentions::table.filter(message_mentions::chat_id.eq(87100))
                .count().get_result::<i64>(conn)?, 0);
            assert!(attachments::table.find(87110_i64).select(attachments::deleted_at)
                .first::<Option<chrono::DateTime<Utc>>>(conn)?.is_some());
            let retried = delete_selection(conn, 87100, 1, true, &ids)?;
            assert_eq!(retried.impact.message_ids, result.impact.message_ids);
            Ok(())
        });
    }
}
