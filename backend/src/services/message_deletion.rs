//! Atomic deletion of a bounded selection of messages in one chat.

use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;
use diesel::prelude::*;

use crate::{
    dto::ws::BulkDeletedPayload,
    errors::AppError,
    models::Message,
    schema::{attachments, group_membership, groups, message_mentions, messages},
    services::{chat, threads},
};

pub struct BulkDeletion {
    pub payload: BulkDeletedPayload,
    pub member_uids: Vec<i32>,
    pub roots: Vec<Message>,
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
        let selected: Vec<Message> = messages::table
            .filter(messages::chat_id.eq(chat_id))
            .filter(messages::id.eq_any(ids))
            .order(messages::id.asc())
            .for_update()
            .select(Message::as_select())
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

        let mut reply_ids = BTreeMap::<i64, Vec<i64>>::new();
        let mut root_ids = BTreeSet::new();
        let mut chat_ids = Vec::new();
        for message in &selected {
            if let Some(root_id) = message.reply_root_id {
                root_ids.insert(root_id);
                reply_ids.entry(root_id).or_default().push(message.id);
            } else {
                chat_ids.push(message.id);
                if message.has_thread {
                    root_ids.insert(message.id);
                }
            }
        }

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

        for (&root_id, deleted_ids) in &reply_ids {
            threads::recalculate_thread_meta(conn, chat_id, root_id)?;
            threads::shift_thread_read_pointers_on_delete(conn, root_id, deleted_ids)?;
        }

        // Re-read has_thread after recalculation: deleting the last reply can
        // also hide a previously deleted root, even outside this selection.
        chat_ids.extend(&root_ids);
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
        if last_id.is_some_and(|id| ids.contains(&id)) {
            chat::recalculate_group_last_message(conn, chat_id)?;
        }

        let roots = messages::table
            .filter(messages::id.eq_any(&root_ids))
            .select(Message::as_select())
            .load(conn)?;
        let member_uids = group_membership::table
            .filter(group_membership::chat_id.eq(chat_id))
            .select(group_membership::uid)
            .load(conn)?;
        Ok(BulkDeletion {
            payload: BulkDeletedPayload {
                chat_id: chat_id.to_string(),
                message_ids: ids.iter().map(i64::to_string).collect(),
                complete: Some(true),
                thread_root_ids: Some(root_ids.iter().map(i64::to_string).collect()),
            },
            member_uids,
            roots,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            assert_eq!(result.payload.message_ids, ids.map(|id| id.to_string()));
            assert_eq!(result.payload.complete, Some(true));
            assert_eq!(result.payload.thread_root_ids, Some(vec!["87102".into()]));
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
            assert_eq!(retried.payload.message_ids, result.payload.message_ids);
            Ok(())
        });
    }
}
