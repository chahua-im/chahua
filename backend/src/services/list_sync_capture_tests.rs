use diesel::{connection::SimpleConnection, Connection, PgConnection};

#[test]
fn list_sync_capture_tracks_final_state_and_old_root_eligibility() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = PgConnection::establish(&url).expect("connect to isolated test database");
    conn.batch_execute(
        "BEGIN;
         INSERT INTO groups (id, name) VALUES (9876861000, 'list capture');
         INSERT INTO group_membership (chat_id, uid) VALUES (9876861000, 4305);
         INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, has_thread)
             VALUES (9876861001, 'text', 'list-sync-capture-root', 4305, 9876861000, now(), true);
         INSERT INTO thread_user_states (chat_id, thread_root_id, uid)
             VALUES (9876861000, 9876861001, 4305);
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM list_sync_shared WHERE chat_id=9876861000 AND thread_root_id=9876861001)
                OR NOT EXISTS (SELECT 1 FROM list_sync_personal WHERE uid=4305 AND chat_id=9876861000 AND thread_root_id=9876861001 AND NOT removed)
             THEN RAISE EXCEPTION 'missing initial shared or personal stamp'; END IF;
         END $$;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         UPDATE messages SET has_thread=false WHERE id=9876861001;
         DELETE FROM group_membership WHERE chat_id=9876861000 AND uid=4305;
         INSERT INTO group_membership (chat_id, uid) VALUES (9876861000, 4305);
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM list_sync_shared s JOIN list_sync_meta m ON m.singleton
                            WHERE s.chat_id=9876861000 AND s.thread_root_id=9876861001 AND s.seq=m.head)
                OR NOT EXISTS (SELECT 1 FROM list_sync_personal p JOIN list_sync_meta m ON m.singleton
                            WHERE p.uid=4305 AND p.chat_id=9876861000 AND p.thread_root_id=9876861001 AND NOT p.removed AND p.seq=m.head)
             THEN RAISE EXCEPTION 'old root or rejoined thread was not stamped'; END IF;
         END $$;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         DELETE FROM thread_user_states WHERE chat_id=9876861000;
         DELETE FROM group_membership WHERE chat_id=9876861000;
         DELETE FROM messages WHERE chat_id=9876861000;
         DELETE FROM groups WHERE id=9876861000;
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM list_sync_shared WHERE chat_id=9876861000)
                OR NOT EXISTS (SELECT 1 FROM list_sync_personal WHERE uid=4305 AND chat_id=9876861000 AND thread_root_id=9876861001 AND removed)
             THEN RAISE EXCEPTION 'shared cleanup or thread tombstone missing'; END IF;
         END $$;
         ROLLBACK;",
    )
    .expect("capture list projection dependencies");
}

#[test]
fn list_sync_capture_tracks_projection_dependencies_and_effective_defaults() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = PgConnection::establish(&url).expect("connect to isolated test database");
    conn.batch_execute(
        "BEGIN;
         INSERT INTO media (id, content_type, storage_key, size, created_at, purpose)
             VALUES (9876862100, 'image/png', 'list-avatar', 1, now(), 'avatar'),
                    (9876862101, 'image/png', 'list-sticker', 1, now(), 'sticker');
         INSERT INTO stickers (id, media_id, emoji) VALUES (9876862102, 9876862101, 'x');
         INSERT INTO groups (id, name, kind, dm_uid1, dm_uid2, avatar_image_id)
             VALUES (9876862000, 'list dm', 'dm', 2147000001, 2147000002, 9876862100);
         INSERT INTO group_membership (chat_id, uid) VALUES (9876862000, 2147000001);
         INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, has_thread, sticker_id)
             VALUES (9876862001, 'text', 'list-dependencies', 2147000001, 9876862000, now(), true, 9876862102);
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         INSERT INTO thread_user_states (chat_id, thread_root_id, uid)
             VALUES (9876862000, 9876862001, 2147000001);
         DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current() AND uid IS NULL AND chat_id=9876862000)
             THEN RAISE EXCEPTION 'null receipt created a shared stamp'; END IF;
         END $$;
         UPDATE thread_user_states SET last_read_receipt_message_id=9876862001
             WHERE chat_id=9876862000 AND thread_root_id=9876862001 AND uid=2147000001;
         DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current() AND uid IS NULL AND chat_id=9876862000 AND thread_root_id=9876862001)
             THEN RAISE EXCEPTION 'thread receipt did not stamp shared root'; END IF;
         END $$;
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         INSERT INTO user_extra (uid, first_seen_at, last_seen_at) VALUES (2147000001, now(), now());
         UPDATE user_extra SET show_unread_message_count=NOT show_unread_message_count WHERE uid=2147000001;
         DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current())
             THEN RAISE EXCEPTION 'effective default or display-only setting invalidated list'; END IF;
         END $$;
         UPDATE user_extra SET mute_group_chats_by_default=true, read_receipt_visibility='nobody'
             WHERE uid=2147000001;
         DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current() AND uid=2147000001 AND chat_id IS NULL)
                OR NOT EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current() AND uid IS NULL AND chat_id=9876862000 AND identity)
             THEN RAISE EXCEPTION 'settings or receipt visibility did not invalidate'; END IF;
         END $$;
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         UPDATE media SET deleted_at=now() WHERE id=9876862100;
         DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current() AND chat_id=9876862000 AND identity)
             THEN RAISE EXCEPTION 'avatar deletion did not invalidate identity'; END IF;
         END $$;
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         INSERT INTO message_mentions (message_id, mentioned_uid, chat_id)
             VALUES (9876862001, 2147000002, 9876862000);
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         UPDATE message_mentions SET kind='reply' WHERE message_id=9876862001 AND mentioned_uid=2147000002;
         DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current())
             THEN RAISE EXCEPTION 'unchanged mention scope invalidated list'; END IF;
         END $$;
         UPDATE message_mentions SET thread_root_id=9876862001 WHERE message_id=9876862001 AND mentioned_uid=2147000002;
         DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current() AND chat_id=9876862000 AND thread_root_id=0)
                OR NOT EXISTS (SELECT 1 FROM list_sync_pending WHERE txid=txid_current() AND chat_id=9876862000 AND thread_root_id=9876862001)
             THEN RAISE EXCEPTION 'old and new mention scopes missing'; END IF;
         END $$;
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         INSERT INTO attachments (id, message_id, kind, external_reference, size, created_at)
             VALUES (9876862103, 9876862001, 'image/png', 'list', 1, now());
         DO $$ BEGIN
             IF NOT (SELECT count(*)=2 FROM list_sync_pending WHERE txid=txid_current() AND chat_id=9876862000)
             THEN RAISE EXCEPTION 'attachment scopes missing'; END IF;
         END $$;
         SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;
         SET CONSTRAINTS message_sync_flush, list_sync_flush DEFERRED;
         UPDATE stickers SET emoji='y' WHERE id=9876862102;
         DO $$ BEGIN
             IF NOT (SELECT count(*)=2 FROM list_sync_pending WHERE txid=txid_current() AND chat_id=9876862000)
             THEN RAISE EXCEPTION 'sticker scopes missing'; END IF;
         END $$;
         ROLLBACK;",
    )
    .expect("capture list dependency changes");
}
