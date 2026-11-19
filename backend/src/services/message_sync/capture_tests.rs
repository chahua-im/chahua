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
fn captures_published_rows_replies_and_reactions_once_per_statement() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = connect(&url);
    conn.batch_execute("BEGIN;
        INSERT INTO groups (id, name) VALUES (9876830000, 'sync capture');
        INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, has_thread)
        VALUES (9876830001, 'text', 'sync-test-root', 4305, 9876830000, now(), true);
        INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, reply_root_id, is_published, transcode_status)
        VALUES (9876830002, 'audio', 'sync-test-reply-1', 4305, 9876830000, now(), 9876830001, false, 'pending'),
               (9876830003, 'audio', 'sync-test-reply-2', 4305, 9876830000, now(), 9876830001, false, 'pending');
        UPDATE messages SET updated_at = now() WHERE id = 9876830002;").unwrap();
    let chat = 9876830000;
    let (root, one, two) = (chat + 1, chat + 2, chat + 3);
    assert_eq!(changes(&mut conn, chat), [(1, root, true)]);
    conn.batch_execute("UPDATE messages SET transcode_status = 'done', is_published = true WHERE id IN (9876830002, 9876830003);
        UPDATE messages SET updated_at = clock_timestamp() WHERE id = 9876830002;
        INSERT INTO message_reactions (message_id, user_uid, emoji, message_author_uid) VALUES (9876830002, 4306, '👍', 4305);
        INSERT INTO message_reactions (message_id, user_uid, emoji, message_author_uid) VALUES (9876830002, 4306, '👍', 4305) ON CONFLICT DO NOTHING;
        DELETE FROM message_reactions WHERE message_id = 9876830002;
        DELETE FROM message_reactions WHERE message_id = 9876830002;
        UPDATE messages SET is_published = false WHERE id = 9876830003;
        UPDATE messages SET deleted_at = now() WHERE id IN (9876830001, 9876830002);").unwrap();
    assert_eq!(position(&mut conn, chat), (7, 0));
    assert_eq!(
        changes(&mut conn, chat),
        [
            (1, root, true),
            (2, root, false),
            (2, one, true),
            (2, two, true),
            (3, root, false),
            (3, one, false),
            (4, one, false),
            (5, one, false),
            (6, root, false),
            (6, two, false),
            (7, root, false),
            (7, one, false),
        ]
    );
    conn.batch_execute("ROLLBACK").unwrap();
    assert!(changes(&mut conn, chat).is_empty());
    assert!(!diesel::select(diesel::dsl::exists(head::table.find(chat)))
        .get_result::<bool>(&mut conn)
        .unwrap());
}

struct CommittedChat(String);
impl Drop for CommittedChat {
    fn drop(&mut self) {
        connect(&self.0)
            .batch_execute(
                "BEGIN;
            LOCK TABLE groups IN ROW EXCLUSIVE MODE;
            DELETE FROM messages WHERE chat_id = 9876840000;
            DELETE FROM groups WHERE id = 9876840000;
            COMMIT;",
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
    let fixture = CommittedChat(url.clone());
    let mut conn = connect(&url);
    conn.batch_execute("BEGIN;
        INSERT INTO groups (id, name) VALUES (9876840000, 'sync prune');
        INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at)
        VALUES (9876840001, 'text', 'sync-prune-1-v2', 4305, 9876840000, now()),
               (9876840002, 'text', 'sync-prune-2-v2', 4305, 9876840000, now());
        UPDATE message_sync_change SET recorded_at = now() - interval '4 days' WHERE chat_id = 9876840000;
        COMMIT;").unwrap();
    let cutoff = diesel::select(diesel::dsl::sql::<Timestamptz>("now() - interval '3 days'"))
        .get_result(&mut conn)
        .unwrap();
    conn.batch_execute("BEGIN; UPDATE messages SET updated_at = now() WHERE chat_id = 9876840000;")
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
