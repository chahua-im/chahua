use super::prune::prune_chat;
use crate::schema::{message_sync_change as change, message_sync_head as head};
use diesel::{
    connection::SimpleConnection,
    prelude::*,
    sql_types::{Bool, Int4, Timestamptz},
};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

fn connect(url: &str) -> PgConnection {
    let mut conn = PgConnection::establish(url).expect("connect to sync test database");
    conn.batch_execute("SET lock_timeout = '5s'").unwrap();
    conn
}

fn position(conn: &mut PgConnection, chat: i64) -> (i64, i64) {
    head::table
        .find(chat)
        .select((head::head, head::retained_after))
        .first(conn)
        .unwrap()
}

fn changes(conn: &mut PgConnection, chat: i64) -> Vec<(i64, i64, bool)> {
    change::table
        .filter(change::chat_id.eq(chat))
        .select((change::seq, change::message_id, change::created))
        .order((change::seq, change::message_id))
        .load(conn)
        .unwrap()
}

#[test]
fn captures_published_rows_replies_and_reactions_once_per_transaction() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = connect(&url);
    let chat = 9876830000;
    let fixture = CommittedChat(url.clone(), chat);
    let (root, one, two) = (chat + 1, chat + 2, chat + 3);
    conn.batch_execute("BEGIN;
        INSERT INTO groups (id, name) VALUES (9876830000, 'sync capture');
        INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, has_thread)
        VALUES (9876830001, 'text', 'sync-test-root', 4305, 9876830000, now(), true);
        INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, reply_root_id, is_published, transcode_status)
        VALUES (9876830002, 'audio', 'sync-test-reply-1', 4305, 9876830000, now(), 9876830001, false, 'pending'),
               (9876830003, 'audio', 'sync-test-reply-2', 4305, 9876830000, now(), 9876830001, false, 'pending');
        UPDATE messages SET updated_at = now() WHERE id = 9876830002;").unwrap();
    assert!(changes(&mut conn, chat).is_empty());
    conn.batch_execute("COMMIT").unwrap();
    assert_eq!(changes(&mut conn, chat), [(1, root, true)]);
    conn.batch_execute("BEGIN;
        UPDATE messages SET transcode_status = 'done', is_published = true WHERE id IN (9876830002, 9876830003);
        UPDATE messages SET updated_at = clock_timestamp() WHERE id = 9876830002;
        INSERT INTO message_reactions (message_id, user_uid, emoji, message_author_uid) VALUES (9876830002, 4306, '👍', 4305);
        INSERT INTO message_reactions (message_id, user_uid, emoji, message_author_uid) VALUES (9876830002, 4306, '👍', 4305) ON CONFLICT DO NOTHING;
        DELETE FROM message_reactions WHERE message_id = 9876830002;
        DELETE FROM message_reactions WHERE message_id = 9876830002;
        UPDATE messages SET is_published = false WHERE id = 9876830003;
        UPDATE messages SET deleted_at = now() WHERE id IN (9876830001, 9876830002);
        COMMIT;").unwrap();
    assert_eq!(position(&mut conn, chat), (2, 0));
    assert_eq!(
        changes(&mut conn, chat),
        [
            (1, root, true),
            (2, root, false),
            (2, one, true),
            (2, two, true)
        ]
    );
    conn.batch_execute(
        "BEGIN;
        UPDATE messages SET message = 'rolled back' WHERE id = 9876830001;
        ROLLBACK;",
    )
    .unwrap();
    assert_eq!(position(&mut conn, chat), (2, 0));
    drop(fixture);
}

struct CommittedChat(String, i64);
impl Drop for CommittedChat {
    fn drop(&mut self) {
        connect(&self.0)
            .batch_execute(
                &format!("BEGIN;
            DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = {chat});
            COMMIT;
            BEGIN;
            DELETE FROM group_membership WHERE chat_id = {chat};
            DELETE FROM messages WHERE chat_id = {chat};
            DELETE FROM groups WHERE id = {chat};
            COMMIT;", chat = self.1),
            )
            .expect("remove sync test fixture");
    }
}

#[test]
fn pruner_waits_for_writer_and_leaves_whole_new_sequence() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let chat = 9876840000;
    let fixture = CommittedChat(url.clone(), chat);
    let mut conn = connect(&url);
    conn.batch_execute("BEGIN;
        INSERT INTO groups (id, name) VALUES (9876840000, 'sync prune');
        INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at)
        VALUES (9876840001, 'text', 'sync-prune-1-v2', 4305, 9876840000, now()),
               (9876840002, 'text', 'sync-prune-2-v2', 4305, 9876840000, now());
        COMMIT;
        UPDATE message_sync_change SET recorded_at = now() - interval '4 days' WHERE chat_id = 9876840000;").unwrap();
    let cutoff = diesel::select(diesel::dsl::sql::<Timestamptz>("now() - interval '3 days'"))
        .get_result(&mut conn)
        .unwrap();
    // Flush at a controlled point so the pruner can be observed waiting on the head.
    conn.batch_execute(
        "BEGIN; UPDATE messages SET updated_at = now() WHERE chat_id = 9876840000;
        SET CONSTRAINTS message_sync_flush, list_sync_flush IMMEDIATE;",
    )
    .unwrap();
    let (started, reader) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut other = connect(&url);
        let pid = diesel::select(diesel::dsl::sql::<Int4>("pg_backend_pid()"))
            .get_result(&mut other)
            .unwrap();
        started.send(pid).unwrap();
        prune_chat(&mut other, chat, cutoff).unwrap();
    });
    let pid: i32 = reader.recv_timeout(Duration::from_secs(3)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !diesel::select(diesel::dsl::sql::<Bool>(&format!(
        "pg_backend_pid() = ANY(pg_blocking_pids({pid}))"
    )))
    .get_result::<bool>(&mut conn)
    .unwrap()
    {
        assert!(
            Instant::now() < deadline,
            "pruner did not wait for the chat head"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    conn.batch_execute("COMMIT").unwrap();
    worker.join().unwrap();
    assert_eq!(position(&mut conn, chat), (2, 1));
    assert_eq!(
        changes(&mut conn, chat),
        [(2, chat + 1, false), (2, chat + 2, false)]
    );
    drop(fixture);
}

#[test]
fn send_and_reaction_can_commit_across_the_author_membership_lock() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let chat = 9876850000;
    let _fixture = CommittedChat(url.clone(), chat);
    let mut send = connect(&url);
    let mut react = connect(&url);
    send.batch_execute("BEGIN;
        INSERT INTO groups (id, name) VALUES (9876850000, 'sync send and reaction');
        INSERT INTO group_membership (chat_id, uid) VALUES (9876850000, 4305), (9876850000, 4306);
        INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at)
        VALUES (9876850001, 'text', 'sync-concurrent-old', 4305, 9876850000, now());
        COMMIT;
        BEGIN;
        INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at)
        VALUES (9876850002, 'text', 'sync-concurrent-send', 4305, 9876850000, now());").unwrap();
    react
        .transaction(|conn| {
            let message = crate::schema::messages::table
                .find(chat + 1)
                .select(crate::models::Message::as_select())
                .first(conn)?;
            assert_eq!(
                crate::services::reactions::insert_reaction(conn, &message, 4306, "👍".into())?,
                1
            );
            Ok::<_, diesel::result::Error>(())
        })
        .unwrap();
    send.batch_execute(
        "UPDATE group_membership SET last_read_message_id = 9876850002
        WHERE chat_id = 9876850000 AND uid = 4305;
        COMMIT;",
    )
    .unwrap();
    assert_eq!(position(&mut send, chat), (3, 0));
    assert_eq!(
        changes(&mut send, chat),
        [
            (1, chat + 1, true),
            (2, chat + 1, false),
            (3, chat + 2, true)
        ]
    );
}

#[test]
fn reply_and_root_changes_can_commit_across_the_root_lock() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    for (chat, delete) in [(9876860000, false), (9876870000, true)] {
        let _fixture = CommittedChat(url.clone(), chat);
        let mut reply = connect(&url);
        let mut root_writer = connect(&url);
        let (root, response) = (chat + 1, chat + 2);
        reply.batch_execute(&format!("BEGIN;
            INSERT INTO groups (id, name) VALUES ({chat}, 'sync concurrent reply');
            INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at)
            VALUES ({root}, 'text', 'sync-root-{chat}', 4305, {chat}, now());
            COMMIT;
            BEGIN;
            INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, reply_root_id)
            VALUES ({response}, 'text', 'sync-reply-{chat}', 4306, {chat}, now(), {root});")).unwrap();
        if delete {
            root_writer
                .batch_execute(&format!(
                    "UPDATE messages SET deleted_at = now() WHERE id = {root};"
                ))
                .unwrap();
        } else {
            root_writer
                .transaction(|conn| {
                    let message = crate::schema::messages::table
                        .find(root)
                        .select(crate::models::Message::as_select())
                        .first(conn)?;
                    assert_eq!(
                        crate::services::reactions::insert_reaction(
                            conn,
                            &message,
                            4306,
                            "👍".into()
                        )?,
                        1
                    );
                    Ok::<_, diesel::result::Error>(())
                })
                .unwrap();
        }
        reply
            .batch_execute(&format!(
                "UPDATE messages SET has_thread = true WHERE id = {root}; COMMIT;"
            ))
            .unwrap();
        assert_eq!(position(&mut reply, chat), (3, 0));
        assert_eq!(
            changes(&mut reply, chat),
            [
                (1, root, true),
                (2, root, false),
                (3, root, false),
                (3, response, true)
            ]
        );
    }
}
