use chrono::{DateTime, Utc};
use diesel::prelude::*;

use crate::models::{Message, MessageReaction};
use crate::schema::{group_membership, message_reactions, messages};

/// Call inside a transaction. Lock the author's membership before taking the
/// database timestamp, and hold it until the write or snapshot has completed.
/// This orders reaction inserts, snapshots and acknowledgements across servers.
/// A departed author has no unread state to synchronize.
pub(super) fn lock_scope(
    conn: &mut PgConnection,
    chat_id: i64,
    author_uid: i32,
) -> QueryResult<DateTime<Utc>> {
    group_membership::table
        .filter(group_membership::chat_id.eq(chat_id))
        .filter(group_membership::uid.eq(author_uid))
        .select(group_membership::uid)
        .for_update()
        .first::<i32>(conn)
        .optional()?;

    // Unlike NOW(), clock_timestamp() is evaluated after any lock wait rather
    // than at transaction start. The same database clock supplies read boundaries.
    diesel::select(diesel::dsl::sql::<diesel::sql_types::Timestamptz>(
        "clock_timestamp()",
    ))
    .get_result(conn)
}

pub fn insert_reaction(
    conn: &mut PgConnection,
    message: &Message,
    actor_uid: i32,
    emoji: String,
) -> QueryResult<usize> {
    conn.transaction(|conn| {
        let created_at = lock_scope(conn, message.chat_id, message.sender_uid)?;
        let inserted = diesel::insert_into(message_reactions::table)
            .values(&MessageReaction {
                message_id: message.id,
                user_uid: actor_uid,
                emoji,
                created_at,
                message_author_uid: message.sender_uid,
            })
            .on_conflict_do_nothing()
            .execute(conn)?;
        diesel::update(messages::table.filter(messages::id.eq(message.id)))
            .set(messages::has_reactions.eq(true))
            .execute(conn)?;
        Ok(inserted)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::unread::UnreadService;
    use diesel::connection::SimpleConnection;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const CHAT: i64 = 9_876_710_000;
    const ROOT: i64 = CHAT + 1;
    const REPLY: i64 = CHAT + 2;
    const AUTHOR: i32 = 4305;
    const ACTOR: i32 = 4306;

    fn connect(url: &str) -> PgConnection {
        let mut conn = PgConnection::establish(url).expect("connect to test database");
        conn.batch_execute("SET lock_timeout = '5s'").unwrap();
        conn
    }

    struct Fixture(String);

    impl Drop for Fixture {
        fn drop(&mut self) {
            let mut conn = connect(&self.0);
            conn.batch_execute(&format!(
                "BEGIN;
                 DELETE FROM message_reactions WHERE message_id IN ({ROOT}, {REPLY});
                 DELETE FROM thread_user_states WHERE chat_id = {CHAT};
                 DELETE FROM messages WHERE chat_id = {CHAT};
                 DELETE FROM group_membership WHERE chat_id = {CHAT};
                 DELETE FROM groups WHERE id = {CHAT};
                 COMMIT;"
            ))
            .expect("remove committed concurrency-test fixtures");
        }
    }

    fn wait_until_blocked(conn: &mut PgConnection, pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let blocked: bool = diesel::select(diesel::dsl::sql::<diesel::sql_types::Bool>(
                &format!("cardinality(pg_blocking_pids({pid})) > 0"),
            ))
            .get_result(conn)
            .unwrap();
            if blocked {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "reaction operation did not wait for the scope lock"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn backend_pid(conn: &mut PgConnection) -> i32 {
        diesel::select(diesel::dsl::sql::<diesel::sql_types::Integer>(
            "pg_backend_pid()",
        ))
        .get_result(conn)
        .unwrap()
    }

    #[test]
    fn snapshots_wait_for_writes_and_later_writes_survive_acknowledgement() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = connect(&url);
        conn.batch_execute(&format!(
            "BEGIN;
             INSERT INTO groups (id, name) VALUES ({CHAT}, 'reaction-concurrency-test');
             INSERT INTO group_membership (chat_id, uid, last_reactions_read_at)
                 VALUES ({CHAT}, {AUTHOR}, '-infinity');
             INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, has_thread)
                 VALUES ({ROOT}, 'text', 'reaction-concurrency-root', {AUTHOR}, {CHAT}, NOW(), TRUE);
             INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, reply_root_id)
                 VALUES ({REPLY}, 'text', 'reaction-concurrency-reply', {AUTHOR}, {CHAT}, NOW(), {ROOT});
             INSERT INTO thread_user_states (chat_id, thread_root_id, uid, subscribed_at, last_reactions_read_at)
                 VALUES ({CHAT}, {ROOT}, {AUTHOR}, NOW(), '-infinity');
             COMMIT;"
        )).unwrap();
        let _fixture = Fixture(url.clone());
        let service = UnreadService::new();

        for (scope, message_id) in [(None, ROOT), (Some(ROOT), REPLY)] {
            let message = messages::table
                .find(message_id)
                .first::<Message>(&mut conn)
                .unwrap();
            // Keep a real reaction insert uncommitted while another connection
            // requests a snapshot. The snapshot must wait and include that insert.
            let reader = conn
                .transaction::<_, diesel::result::Error, _>(|conn| {
                    assert_eq!(insert_reaction(conn, &message, ACTOR, "👍".into())?, 1);
                    let (ready, started) = mpsc::channel();
                    let url = url.clone();
                    let reader = std::thread::spawn(move || {
                        let mut conn = connect(&url);
                        ready.send(backend_pid(&mut conn)).unwrap();
                        UnreadService::new()
                            .snapshot_chat_unread_reactions(&mut conn, AUTHOR, CHAT, scope, 1000)
                    });
                    wait_until_blocked(conn, started.recv().unwrap());
                    Ok(reader)
                })
                .unwrap();
            let snapshot = reader.join().unwrap().unwrap();
            assert_eq!(snapshot.message_ids, vec![message_id.to_string()]);

            // Hold a snapshot open, queue a writer, then acknowledge the snapshot.
            // The queued writer must timestamp its insert only after this commits.
            let writer = conn
                .transaction::<_, diesel::result::Error, _>(|conn| {
                    let snapshot =
                        service.snapshot_chat_unread_reactions(conn, AUTHOR, CHAT, scope, 1000)?;
                    let (ready, started) = mpsc::channel();
                    let url = url.clone();
                    let writer = std::thread::spawn(move || {
                        let mut conn = connect(&url);
                        let message = messages::table
                            .find(message_id)
                            .first::<Message>(&mut conn)
                            .unwrap();
                        ready.send(backend_pid(&mut conn)).unwrap();
                        insert_reaction(&mut conn, &message, ACTOR, "🎉".into())
                    });
                    wait_until_blocked(conn, started.recv().unwrap());
                    assert_eq!(
                        service.acknowledge_chat_unread_reactions(
                            conn,
                            AUTHOR,
                            CHAT,
                            scope,
                            Some(snapshot.read_through),
                        )?,
                        0
                    );
                    Ok(writer)
                })
                .unwrap();
            assert_eq!(writer.join().unwrap().unwrap(), 1);
            assert_eq!(
                service
                    .count_chat_unread_reactions(&mut conn, AUTHOR, CHAT, scope)
                    .unwrap(),
                1
            );
            let snapshot = service
                .snapshot_chat_unread_reactions(&mut conn, AUTHOR, CHAT, scope, 1000)
                .unwrap();
            assert_eq!(snapshot.message_ids, vec![message_id.to_string()]);
            // Omitting readThrough uses the same serialized database clock.
            assert_eq!(
                service
                    .acknowledge_chat_unread_reactions(&mut conn, AUTHOR, CHAT, scope, None)
                    .unwrap(),
                0
            );
            assert_eq!(
                insert_reaction(&mut conn, &message, ACTOR, "🎉".into()).unwrap(),
                0
            );
        }
    }
}
