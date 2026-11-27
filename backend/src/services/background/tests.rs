use std::collections::BTreeSet;

use super::*;
use crate::schema::{attachments, groups, message_mentions, thread_meta, thread_user_states};
use crate::services::ws_registry::WsMetrics;
use diesel::connection::SimpleConnection;

#[test]
fn database_member_cleanup_merges_batches_and_preserves_scope() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    // Reuse one rollback-only connection across the worker's transactions.
    let pool = Pool::builder()
        .max_size(1)
        .connection_customizer(Box::new(diesel::r2d2::TestCustomizer))
        .build(ConnectionManager::<PgConnection>::new(url))
        .unwrap();
    pool.get().unwrap().batch_execute(
            "INSERT INTO groups(id, name) VALUES (88100, 'bulk-cleanup'), (88200, 'other-chat');
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, reply_root_id, has_thread, is_published)
             VALUES (88099, 88100, 2, 'text', 'previous', 'cleanup-previous', NOW(), NULL, false, true),
                    (88101, 88100, 2, 'text', 'root', 'cleanup-root', NOW(), NULL, true, true),
                    (88102, 88100, 1, 'text', 'old', 'cleanup-old', NOW() - INTERVAL '3 days', NULL, false, true),
                    (88103, 88100, 2, 'text', 'other user', 'cleanup-other-user', NOW(), NULL, false, true),
                    (88104, 88100, 1, 'text', 'old reply', 'cleanup-old-reply', NOW() - INTERVAL '3 days', 88101, false, true),
                    (88900, 88100, 1, 'audio', NULL, 'cleanup-pending', NOW(), NULL, false, false),
                    (88201, 88200, 1, 'text', 'other chat', 'cleanup-other-chat', NOW(), NULL, false, true);
             UPDATE messages SET deleted_at = NOW() WHERE id = 88101;
             INSERT INTO messages(id, chat_id, sender_uid, message_type, system_kind,
                                  client_generated_id, created_at, is_published)
             VALUES (88097, 88100, 1, 'system', 'unknown', 'cleanup-system-old', NOW() - INTERVAL '3 days', true),
                    (88098, 88100, 1, 'system', 'member_joined', 'cleanup-system-recent', NOW(), true);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, reply_root_id, is_published)
             SELECT id, 88100, 1, 'text', 'reply', 'cleanup-reply-' || id, NOW(), 88101, true
             FROM generate_series(88301, 88803) AS id;
             UPDATE groups SET last_message_id = 88103, last_message_at = NOW() WHERE id = 88100;
             INSERT INTO group_membership(chat_id, uid, last_read_message_id)
             VALUES (88100, 2, 88102), (88100, 3, 88101);
             INSERT INTO thread_user_states(chat_id, thread_root_id, uid, last_read_message_id)
             VALUES (88100, 88101, 2, 88803);
             INSERT INTO thread_meta(chat_id, thread_root_id, reply_count, last_reply_at)
             VALUES (88100, 88101, 504, NOW());
             INSERT INTO message_mentions(message_id, mentioned_uid, chat_id)
             VALUES (88102, 2, 88100), (88803, 2, 88100);
             INSERT INTO attachments(id, message_id, kind, external_reference, size, created_at)
             VALUES (88910, 88900, 'audio/webm', 'cleanup-pending', 1, NOW()),
                    (88911, 88102, 'text/plain', 'cleanup-old', 1, NOW());",
        ).unwrap();
    let registry = Arc::new(ConnectionRegistry::new(Arc::new(WsMetrics::new(
        &prometheus::Registry::new(),
    ))));
    let (_connection, mut events) = registry.register(2, "cleanup-test".into());
    assert!(matches!(
        &*events.try_recv().unwrap(),
        ServerWsMessage::PresenceUpdate(_)
    ));

    process_bulk_delete(88100, 1, DeleteScope::Last24Hours, &pool, &registry, &None).unwrap();
    let mut deleted_ids = BTreeSet::new();
    let mut batch_sizes = Vec::new();
    let mut complete = false;
    let mut updates = Vec::new();
    while let Ok(event) = events.try_recv() {
        assert!(!complete, "completion must be the last event");
        match &*event {
            ServerWsMessage::MessagesBulkDeleted(payload) if payload.complete == Some(false) => {
                batch_sizes.push(payload.message_ids.len());
                deleted_ids.extend(payload.message_ids.iter().cloned());
            }
            ServerWsMessage::MessagesBulkDeleted(payload) => {
                assert_eq!(payload.complete, Some(true));
                assert!(payload.message_ids.is_empty());
                assert_eq!(payload.thread_root_ids, Some(vec!["88101".into()]));
                complete = true;
            }
            ServerWsMessage::ThreadUpdate(payload) => updates.push(payload.reply_count),
            _ => panic!("unexpected deletion event"),
        }
    }
    assert!(complete);
    assert_eq!(batch_sizes, vec![500, 4]);
    assert_eq!(deleted_ids.len(), 504);
    assert!(
        !deleted_ids.contains("88098"),
        "system events are not broadcast as deleted"
    );
    assert!(
        deleted_ids.contains("88900"),
        "cleanup includes unpublished audio"
    );
    assert!(
        !deleted_ids.contains("88104"),
        "old replies stay outside the time scope"
    );
    assert_eq!(updates, vec![1]);
    {
        let conn = &mut *pool.get().unwrap();
        assert_eq!(
            thread_meta::table
                .find((88100_i64, 88101_i64))
                .select(thread_meta::reply_count)
                .first::<i64>(conn)
                .unwrap(),
            1
        );
        assert_eq!(
            thread_user_states::table
                .find((88100_i64, 88101_i64, 2))
                .select(thread_user_states::last_read_message_id)
                .first::<Option<i64>>(conn)
                .unwrap(),
            Some(88104)
        );
        assert!(messages::table
            .find(88101_i64)
            .select(messages::has_thread)
            .first::<bool>(conn)
            .unwrap());
        assert!(attachments::table
            .find(88910_i64)
            .select(attachments::deleted_at)
            .first::<Option<chrono::DateTime<Utc>>>(conn)
            .unwrap()
            .is_some());
        assert!(attachments::table
            .find(88911_i64)
            .select(attachments::deleted_at)
            .first::<Option<chrono::DateTime<Utc>>>(conn)
            .unwrap()
            .is_none());
        assert_eq!(
            message_mentions::table
                .filter(message_mentions::chat_id.eq(88100))
                .select(message_mentions::message_id)
                .load::<i64>(conn)
                .unwrap(),
            vec![88102]
        );
    }

    process_bulk_delete(88100, 1, DeleteScope::All, &pool, &registry, &None).unwrap();
    let mut final_ids = BTreeSet::new();
    let mut completed = false;
    while let Ok(event) = events.try_recv() {
        if let ServerWsMessage::MessagesBulkDeleted(payload) = &*event {
            final_ids.extend(payload.message_ids.iter().cloned());
            completed |= payload.complete == Some(true);
        }
    }
    assert!(completed);
    assert_eq!(final_ids, BTreeSet::from(["88102".into(), "88104".into()]));
    {
        let conn = &mut *pool.get().unwrap();
        let survivors: Vec<i64> = messages::table
            .filter(messages::chat_id.eq_any([88100, 88200]))
            .filter(messages::deleted_at.is_null())
            .order(messages::id.asc())
            .select(messages::id)
            .load(conn)
            .unwrap();
        assert_eq!(survivors, vec![88097, 88098, 88099, 88103, 88201]);
        assert!(!messages::table
            .find(88101_i64)
            .select(messages::has_thread)
            .first::<bool>(conn)
            .unwrap());
        assert_eq!(
            group_membership::table
                .filter(group_membership::chat_id.eq(88100))
                .select(group_membership::last_read_message_id)
                .load::<Option<i64>>(conn)
                .unwrap(),
            vec![Some(88099); 2]
        );
        assert_eq!(
            thread_user_states::table
                .find((88100_i64, 88101_i64, 2))
                .select(thread_user_states::last_read_message_id)
                .first::<Option<i64>>(conn)
                .unwrap(),
            None
        );
        assert_eq!(
            groups::table
                .find(88100_i64)
                .select(groups::last_message_id)
                .first::<Option<i64>>(conn)
                .unwrap(),
            Some(88103)
        );
        assert_eq!(
            thread_meta::table
                .filter(thread_meta::chat_id.eq(88100))
                .count()
                .get_result::<i64>(conn)
                .unwrap(),
            0
        );
        assert_eq!(
            message_mentions::table
                .filter(message_mentions::chat_id.eq(88100))
                .count()
                .get_result::<i64>(conn)
                .unwrap(),
            0
        );
    }
    process_bulk_delete(88100, 1, DeleteScope::All, &pool, &registry, &None).unwrap();
    assert!(events.try_recv().is_err(), "an empty cleanup has no events");
}
