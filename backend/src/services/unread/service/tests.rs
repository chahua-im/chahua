use chrono::{Duration, Utc};

use super::{summarize_membership_unreads, ChatUnreadCursor, ChatUnreadMembership, UnreadService};
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
            let totals = service.count_users_app_badges(
                conn,
                &[891001, 891002, 891003, 891004, 891005, 891006, 891007],
            )?;
            assert_eq!(totals[&891001], 1);
            assert_eq!(totals[&891002], 1);
            assert_eq!(totals[&891003], 0);
            assert_eq!(totals[&891004], 0);
            assert_eq!(totals[&891005], 1);
            assert_eq!(totals[&891006], 0);
            assert_eq!(totals[&891007], 1);
            for uid in [891001, 891002, 891007] {
                crate::services::user::save_chat_settings(conn, uid, crate::dto::users::UpdateChatSettings {
                    show_unread_message_count: Some(true), ..Default::default()
                })?;
            }
            let totals = service.count_users_app_badges(conn, &[891001, 891002, 891003, 891004, 891005, 891006, 891007])?;
            assert_eq!(totals[&891001], 4);
            assert_eq!(totals[&891002], 5);
            assert_eq!(totals[&891003], 0);
            assert_eq!(totals[&891004], 0);
            assert_eq!(totals[&891005], 1);
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
            let counts = service.count_chat_unread_mentions_for_memberships(conn, user, &[membership(chat_id, None, false, None)])?;
            assert!(service.count_chat_unread_mentions_for_memberships(conn, user, &[])?.is_empty());
            assert!(service.count_chat_unread_mentions_for_memberships(conn, user, &[membership(chat_id + 100, None, false, None)])?.is_empty());
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
            let counts_after = service.count_chat_unread_mentions_for_memberships(conn, user, &[membership(chat_id, None, false, None)])?;
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
            let counts = service.count_chat_unread_mentions_for_memberships(conn, user, &[membership(chat_id, None, false, None)])?;
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
            let counts_after = service.count_chat_unread_mentions_for_memberships(conn, user, &[membership(chat_id, None, false, None)])?;
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
    test: impl FnOnce(&mut diesel::PgConnection, &mut MentionSummaryFixture) -> diesel::QueryResult<()>,
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
        for (chat_id, root_id) in [(active_group, None), (archived_group, Some(active_thread))] {
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

#[test]
fn reaction_page_cutoff_preserves_distinct_messages_and_per_chat_boundaries() {
    use diesel::connection::SimpleConnection;
    use diesel::{Connection, PgConnection};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, Ordering};

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    static NEXT: AtomicI64 = AtomicI64::new(9_876_820_000);
    let base = NEXT.fetch_add(10, Ordering::SeqCst);
    let (first, second, outside) = (base, base + 1, base + 2);
    let (a, b, c, boundary) = (base + 3, base + 4, base + 5, base + 6);
    let author = -548_101;
    let actor = -548_102;
    let service = UnreadService::new();
    conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute(&format!(
                "INSERT INTO groups (id, name) VALUES
                    ({first}, 'cursor-first'), ({second}, 'cursor-second'), ({outside}, 'cursor-outside');
                 INSERT INTO group_membership (chat_id, uid, last_reactions_read_at) VALUES
                    ({first}, {author}, '2020-01-01'),
                    ({second}, {author}, '2020-01-03'),
                    ({outside}, {author}, '2030-01-01'),
                    ({first}, {actor}, '2040-01-01');
                 INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) VALUES
                    ({a}, 'text', 'cutoff-{a}', {author}, {first}, '2020-01-01'),
                    ({b}, 'text', 'cutoff-{b}', {author}, {second}, '2020-01-01'),
                    ({c}, 'text', 'cutoff-{c}', {author}, {second}, '2020-01-01'),
                    ({boundary}, 'text', 'cutoff-{boundary}', {author}, {second}, '2020-01-01');
                 INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid) VALUES
                    ({a}, {actor}, 'a', '2020-01-02', {author}),
                    ({a}, {actor}, 'b', '2020-01-02', {author}),
                    ({b}, {actor}, 'a', '2020-01-02', {author}),
                    ({c}, {actor}, 'a', '2020-01-04', {author}),
                    ({boundary}, {actor}, 'a', '2020-01-03', {author}),
                    ({boundary}, {author}, 'self', '2020-01-04', {author});"
            ))?;
            let page = [
                membership(first, None, false, None),
                membership(second, None, false, None),
            ];
            assert_eq!(
                service.count_chat_unread_reactions_for_memberships(conn, author, &page)?,
                HashMap::from([(first, 1), (second, 1)])
            );
            conn.batch_execute(&format!(
                "UPDATE group_membership SET last_reactions_read_at = '2020-01-05'
                 WHERE chat_id = {first} AND uid = {author}"
            ))?;
            assert_eq!(
                service.count_chat_unread_reactions_for_memberships(conn, author, &page)?,
                HashMap::from([(second, 1)])
            );
            conn.batch_execute(&format!(
                "DELETE FROM group_membership WHERE uid = {author} AND chat_id IN ({first}, {second})"
            ))?;
            assert!(service.count_chat_unread_reactions_for_memberships(conn, author, &page)?.is_empty());
            Ok(())
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
            diesel::sql_query(
                "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid)
                 VALUES ($1, $2, 'second', NOW() - interval '1 hour', $3)",
            )
            .bind::<diesel::sql_types::BigInt, _>(msg_a)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .bind::<diesel::sql_types::Integer, _>(author)
            .execute(conn)?;
            let page = [membership(chat_id, None, false, None)];
            let counts = service.count_chat_unread_reactions_for_memberships(conn, author, &page)?;
            assert_eq!(counts.get(&chat_id), Some(&1));
            assert!(service.count_chat_unread_reactions_for_memberships(conn, author, &[])?.is_empty());
            assert!(service.count_chat_unread_reactions_for_memberships(conn, author, &[membership(chat_id + 100, None, false, None)])?.is_empty());

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
                UnreadService::list_chat_unread_reactions(conn, author, chat_id, None, 1000, boundary, None)?,
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
            diesel::sql_query(
                "WITH inserted AS (
                    INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, is_published, created_at)
                    SELECT $1 + n, 'text', ($1 + n)::text, $2, $3, TRUE, NOW()
                    FROM generate_series(1::bigint, $4) n RETURNING id
                 )
                 INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid)
                 SELECT id, $5, 'cap', NOW() + interval '1 hour', $2 FROM inserted",
            )
            .bind::<diesel::sql_types::BigInt, _>(chat_id + 100_000)
            .bind::<diesel::sql_types::Integer, _>(author)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT + 1)
            .bind::<diesel::sql_types::Integer, _>(actor)
            .execute(conn)?;
            assert_eq!(
                service.count_chat_unread_reactions_for_memberships(conn, author, &page)?.get(&chat_id),
                Some(&MAX_UNREAD_COUNT)
            );

            Err(diesel::result::Error::RollbackTransaction)
        });

    assert!(
        matches!(result, Err(diesel::result::Error::RollbackTransaction)),
        "transaction should roll back"
    );
}

#[test]
fn reaction_snapshots_read_only_the_incremental_time_window() {
    use chrono::DateTime;
    use diesel::{
        connection::SimpleConnection, prelude::*, result::Error as DieselError, sql_query,
    };

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).expect("connect to test database");
    let service = UnreadService::new();
    const CHAT: i64 = 9_876_712_000;
    const ROOT: i64 = CHAT + 1;
    const REPLY: i64 = CHAT + 2;
    const AUTHOR: i32 = 4308;
    const ACTOR: i32 = 4309;
    let result = conn.transaction::<(), DieselError, _>(|conn| {
            conn.batch_execute(&format!(
                "INSERT INTO groups (id, name) VALUES ({CHAT}, 'reaction-delta-test');
                 INSERT INTO group_membership (chat_id, uid, last_reactions_read_at)
                     VALUES ({CHAT}, {AUTHOR}, '-infinity');
                 INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, has_thread)
                     VALUES ({ROOT}, 'text', 'reaction-delta-root', {AUTHOR}, {CHAT}, NOW(), TRUE);
                 INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, reply_root_id)
                     VALUES ({REPLY}, 'text', 'reaction-delta-reply', {AUTHOR}, {CHAT}, NOW(), {ROOT});
                 INSERT INTO thread_user_states (chat_id, thread_root_id, uid, subscribed_at, last_reactions_read_at)
                     VALUES ({CHAT}, {ROOT}, {AUTHOR}, NOW(), '-infinity');"
            ))?;

            let old = DateTime::<Utc>::from_timestamp(Utc::now().timestamp() - 7200, 0).unwrap();
            let newer = old + chrono::Duration::hours(1);
            for (scope, message_id) in [(None, ROOT), (Some(ROOT), REPLY)] {
                sql_query(
                    "INSERT INTO message_reactions (message_id, user_uid, emoji, created_at, message_author_uid)
                     VALUES ($1, $2, 'old', $3, $5), ($1, $2, 'new', $4, $5)",
                )
                .bind::<diesel::sql_types::BigInt, _>(message_id)
                .bind::<diesel::sql_types::Integer, _>(ACTOR)
                .bind::<diesel::sql_types::Timestamptz, _>(old)
                .bind::<diesel::sql_types::Timestamptz, _>(newer)
                .bind::<diesel::sql_types::Integer, _>(AUTHOR)
                .execute(conn)?;

                // Bounds are exclusive at after and inclusive at readThrough.
                assert_eq!(UnreadService::list_chat_unread_reactions(conn, AUTHOR, CHAT, scope, 1000, old, None)?, vec![message_id]);
                assert_eq!(UnreadService::list_chat_unread_reactions(conn, AUTHOR, CHAT, scope, 1000, newer, Some(old))?, vec![message_id]);
                assert!(UnreadService::list_chat_unread_reactions(conn, AUTHOR, CHAT, scope, 1000, newer, Some(newer))?.is_empty());
                let first = service.snapshot_chat_unread_reactions(conn, AUTHOR, CHAT, scope, 1000, None)?;
                assert_eq!(first.message_ids, vec![message_id.to_string()]);
                let empty = service.snapshot_chat_unread_reactions(conn, AUTHOR, CHAT, scope, 1000, Some(first.read_through))?;
                assert!(empty.message_ids.is_empty());
                assert!(empty.read_through >= first.read_through);
                assert_eq!(service.count_chat_unread_reactions(conn, AUTHOR, CHAT, scope)?, 1);

                // A new reaction on the same message reappears in the next delta.
                let message = crate::schema::messages::table.find(message_id).first::<crate::models::Message>(conn)?;
                crate::services::reactions::insert_reaction(conn, &message, ACTOR, "👍".into())?;
                let delta = service.snapshot_chat_unread_reactions(conn, AUTHOR, CHAT, scope, 1000, Some(empty.read_through))?;
                assert_eq!(delta.message_ids, vec![message_id.to_string()]);
                assert_eq!(service.acknowledge_chat_unread_reactions(conn, AUTHOR, CHAT, scope, Some(empty.read_through))?, 1);
                assert_eq!(service.acknowledge_chat_unread_reactions(conn, AUTHOR, CHAT, scope, Some(delta.read_through))?, 0);
                // An old after value cannot resurrect reactions read on another device.
                assert!(service.snapshot_chat_unread_reactions(conn, AUTHOR, CHAT, scope, 1000, Some(old))?.message_ids.is_empty());
            }
            Err(DieselError::RollbackTransaction)
        });
    assert!(
        matches!(result, Err(DieselError::RollbackTransaction)),
        "{result:?}"
    );
}
#[test]
fn revision_cache_uses_configured_schema() {
    use diesel::connection::SimpleConnection;
    use diesel::{Connection, PgConnection, RunQueryDsl};

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute("CREATE SCHEMA unread_cache_schema_regression")
        .unwrap();
    struct Cleanup(PgConnection);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self
                .0
                .batch_execute("DROP SCHEMA unread_cache_schema_regression CASCADE");
        }
    }
    let mut cleanup = Cleanup(conn);
    let conn = &mut cleanup.0;
    conn.batch_execute(
        "SET search_path = unread_cache_schema_regression;
             CREATE TABLE groups (id BIGINT PRIMARY KEY);
             CREATE TABLE messages (
                 id BIGINT PRIMARY KEY, chat_id BIGINT NOT NULL,
                 reply_root_id BIGINT, is_published BOOLEAN NOT NULL,
                 deleted_at TIMESTAMPTZ, system_kind TEXT, has_thread BOOLEAN NOT NULL DEFAULT FALSE
             );
             INSERT INTO groups VALUES (1);",
    )
    .unwrap();
    conn.batch_execute(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/2026-11-04-044733-0000_add_chat_unread_revisions/up.sql"
    )))
    .unwrap();
    let service = UnreadService::new();
    let cursor = ChatUnreadCursor {
        chat_id: 1,
        last_read_message_id: 0,
        hide_membership_messages: false,
    };
    assert_eq!(
        service.count_chat_unread_cursors(conn, [cursor]).unwrap()[&cursor],
        0
    );
    let mut writer = PgConnection::establish(&url).unwrap();
    writer
        .batch_execute(
            "SET search_path = unread_cache_schema_regression;
                 INSERT INTO messages
                     (id, chat_id, is_published) VALUES (1, 1, TRUE);",
        )
        .unwrap();
    assert_eq!(
        service.count_chat_unread_cursors(conn, [cursor]).unwrap()[&cursor],
        1
    );
    writer
        .batch_execute("DELETE FROM messages WHERE id = 1")
        .unwrap();
    assert_eq!(
        service.count_chat_unread_cursors(conn, [cursor]).unwrap()[&cursor],
        0
    );

    // More than one window, with gaps: cursor arithmetic cannot substitute
    // for counting live IDs. Both visibility variants must stay independent.
    writer
        .batch_execute(&format!(
            "INSERT INTO messages (id, chat_id, is_published, system_kind)
             SELECT n * 2, 1, TRUE, CASE WHEN n % 3 = 0 THEN 'member_joined' END
             FROM generate_series(1, {}) n;
             INSERT INTO messages (id, chat_id, is_published) VALUES (1, 1, FALSE);",
            MAX_UNREAD_COUNT * 2
        ))
        .unwrap();
    let verify = |conn: &mut PgConnection| {
        let cursors: Vec<_> = [false, true]
            .into_iter()
            .flat_map(|hidden| {
                [
                    0,
                    1,
                    2,
                    MAX_UNREAD_COUNT,
                    MAX_UNREAD_COUNT * 3,
                    MAX_UNREAD_COUNT * 4 - 1,
                    MAX_UNREAD_COUNT * 4,
                    i64::MAX,
                ]
                .into_iter()
                .map(move |id| ChatUnreadCursor {
                    last_read_message_id: id,
                    hide_membership_messages: hidden,
                    ..cursor
                })
            })
            .collect();
        let counts = service
            .count_chat_unread_cursors(conn, cursors.iter().copied())
            .unwrap();
        for cursor in cursors {
            let predicate = if cursor.hide_membership_messages {
                crate::services::system_messages::NON_MEMBERSHIP_PREDICATE
            } else {
                "TRUE"
            };
            let expected = diesel::sql_query(format!(
                "SELECT 1::BIGINT AS chat_id, {}::BIGINT AS last_read_message_id,
                            COUNT(*)::BIGINT AS unread_count
                     FROM (SELECT id FROM messages
                           WHERE chat_id = 1 AND id > {}
                             AND deleted_at IS NULL AND is_published
                             AND reply_root_id IS NULL AND {predicate}
                           ORDER BY id DESC LIMIT {}) live",
                cursor.last_read_message_id, cursor.last_read_message_id, MAX_UNREAD_COUNT
            ))
            .get_result::<super::ChatUnreadCountRow>(conn)
            .unwrap();
            assert_eq!(counts[&cursor], expected.unread_count, "{cursor:?}");
        }
    };
    verify(conn);
    // Delete within the window: older IDs must refill it. A deleted read
    // cursor remains a valid boundary.
    writer
        .batch_execute(&format!(
            "DELETE FROM messages WHERE id = {};
             UPDATE messages SET deleted_at = NOW() WHERE id = {}",
            MAX_UNREAD_COUNT * 4,
            MAX_UNREAD_COUNT * 3
        ))
        .unwrap();
    verify(conn);
    // Delayed publication inserts an old ID, not necessarily the newest ID.
    writer
        .batch_execute(
            "UPDATE messages SET is_published = TRUE WHERE id = 1;
             UPDATE messages SET system_kind = NULL WHERE system_kind IS NOT NULL",
        )
        .unwrap();
    verify(conn);
    // Crossing below the cap must not retain the old saturated total.
    writer
        .batch_execute(&format!(
            "DELETE FROM messages WHERE id > {}",
            MAX_UNREAD_COUNT
        ))
        .unwrap();
    verify(conn);
}

#[test]
fn revision_cache_observes_commits_and_never_publishes_rollback() {
    use diesel::connection::SimpleConnection;
    use diesel::sql_types::{BigInt, Integer};
    use diesel::{Connection, RunQueryDsl};

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut first = diesel::PgConnection::establish(&url).unwrap();
    let mut second = diesel::PgConnection::establish(&url).unwrap();
    let chat = 9_876_919_800_i64;
    let uid = -541_100;
    struct Cleanup(String, i64);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(mut conn) = diesel::PgConnection::establish(&self.0) {
                let _ = diesel::sql_query("DELETE FROM messages WHERE chat_id = $1")
                    .bind::<BigInt, _>(self.1)
                    .execute(&mut conn);
                let _ = diesel::sql_query("DELETE FROM group_membership WHERE chat_id = $1")
                    .bind::<BigInt, _>(self.1)
                    .execute(&mut conn);
                let _ = diesel::sql_query("DELETE FROM groups WHERE id = $1")
                    .bind::<BigInt, _>(self.1)
                    .execute(&mut conn);
            }
        }
    }
    diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'revision-cache-test')")
        .bind::<BigInt, _>(chat)
        .execute(&mut first)
        .unwrap();
    let _cleanup = Cleanup(url, chat);
    diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
        .bind::<BigInt, _>(chat)
        .bind::<Integer, _>(uid)
        .execute(&mut first)
        .unwrap();
    let service = UnreadService::new();
    let cursor = ChatUnreadCursor {
        chat_id: chat,
        last_read_message_id: i64::MIN,
        hide_membership_messages: false,
    };
    let count = |conn: &mut diesel::PgConnection, cursor| {
        service.count_chat_unread_cursors(conn, [cursor]).unwrap()[&cursor]
    };
    assert_eq!(count(&mut first, cursor), 0);
    let insert = |conn: &mut diesel::PgConnection, id| {
        diesel::sql_query("INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, is_published, created_at)
                               VALUES ($1, 'text', $1::text, $2, $3, TRUE, NOW())")
                .bind::<BigInt, _>(id).bind::<Integer, _>(uid).bind::<BigInt, _>(chat)
                .execute(conn).unwrap();
    };
    insert(&mut second, chat + 1);
    assert_eq!(count(&mut first, cursor), 1);
    assert_eq!(count(&mut first, cursor), 1);
    let read_cursor = ChatUnreadCursor {
        last_read_message_id: chat + 1,
        ..cursor
    };
    assert_eq!(count(&mut first, read_cursor), 0);
    let result = first.transaction::<(), diesel::result::Error, _>(|conn| {
        insert(conn, chat + 2);
        assert_eq!(count(conn, cursor), 2);
        Err(diesel::result::Error::RollbackTransaction)
    });
    assert!(matches!(
        result,
        Err(diesel::result::Error::RollbackTransaction)
    ));
    assert_eq!(count(&mut first, cursor), 1);
    // Raw SQL BEGIN bypasses Diesel's transaction manager bookkeeping.
    first.batch_execute("BEGIN").unwrap();
    insert(&mut first, chat + 2);
    assert_eq!(count(&mut first, cursor), 2);
    first.batch_execute("ROLLBACK").unwrap();
    assert_eq!(count(&mut first, cursor), 1);
    diesel::sql_query("UPDATE messages SET is_published = FALSE WHERE id = $1")
        .bind::<BigInt, _>(chat + 1)
        .execute(&mut second)
        .unwrap();
    assert_eq!(count(&mut first, cursor), 0);
    diesel::sql_query("UPDATE messages SET is_published = TRUE WHERE id = $1")
        .bind::<BigInt, _>(chat + 1)
        .execute(&mut second)
        .unwrap();
    assert_eq!(count(&mut first, cursor), 1);
    let hidden = ChatUnreadCursor {
        hide_membership_messages: true,
        ..cursor
    };
    assert_eq!(count(&mut first, hidden), 1);
    diesel::sql_query(
        "UPDATE messages SET message_type = 'system', system_kind = 'member_joined' WHERE id = $1",
    )
    .bind::<BigInt, _>(chat + 1)
    .execute(&mut second)
    .unwrap();
    assert_eq!(count(&mut first, cursor), 1);
    assert_eq!(count(&mut first, hidden), 0);
    diesel::sql_query("UPDATE messages SET deleted_at = NOW() WHERE id = $1")
        .bind::<BigInt, _>(chat + 1)
        .execute(&mut second)
        .unwrap();
    assert_eq!(count(&mut first, cursor), 0);
    diesel::sql_query("UPDATE messages SET deleted_at = NULL WHERE id = $1")
        .bind::<BigInt, _>(chat + 1)
        .execute(&mut second)
        .unwrap();
    assert_eq!(count(&mut first, cursor), 1);
    assert_eq!(count(&mut first, hidden), 0);
}
