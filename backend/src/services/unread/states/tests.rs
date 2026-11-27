use super::*;

#[test]
fn snapshots_batch_visibility_and_preserve_scope_access_and_cursors() {
    use diesel::connection::{InstrumentationEvent, SimpleConnection};
    use std::sync::Mutex;

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id, name)
                    SELECT 9876710000 + n, 'state-watch-' || n FROM generate_series(1, 50) n;
                 UPDATE groups SET kind='dm', dm_uid1=987671000, dm_uid2=987671001
                    WHERE id=9876710049;
                 INSERT INTO group_membership(chat_id, uid, last_read_message_id, archived)
                    SELECT 9876710000 + n, 987671000,
                        CASE WHEN n=1 THEN NULL ELSE (9876710000 + n) * 10 + 1 END, n % 2 = 0
                    FROM generate_series(1, 49) n;
                 INSERT INTO messages(id, chat_id, sender_uid, client_generated_id, message_type, system_kind, created_at)
                    SELECT g.id * 10 + n, g.id, 1717, 'state-watch-' || g.id || '-' || n,
                        CASE WHEN n IN (2,4) THEN 'system'::message_type ELSE 'text'::message_type END,
                        CASE WHEN n=2 THEN 'member_joined'::system_message_kind
                             WHEN n=4 THEN 'unknown'::system_message_kind ELSE NULL END, NOW()
                    FROM groups g CROSS JOIN generate_series(1,4) n
                    WHERE g.id BETWEEN 9876710001 AND 9876710050;
                 UPDATE messages SET has_thread=TRUE WHERE id=98767100011;
                 INSERT INTO messages(id, chat_id, sender_uid, client_generated_id, message_type, system_kind, reply_root_id, created_at)
                    VALUES (98767100015,9876710001,987671000,'state-watch-reply','system','member_joined',98767100011,NOW()),
                           (98767100025,9876710002,987671000,'state-watch-untracked','text',NULL,98767100021,NOW());
                 INSERT INTO thread_user_states(chat_id, thread_root_id, uid, subscribed, last_read_message_id)
                    VALUES (9876710001,98767100011,987671000,FALSE,98767100011);
                 UPDATE messages SET sender_uid=987671000 WHERE id=98767100013;
                 INSERT INTO message_mentions(message_id, mentioned_uid, chat_id, thread_root_id)
                    VALUES (98767100013,987671000,9876710001,NULL),
                           (98767100015,987671000,9876710001,98767100011),
                           (98767100025,987671000,9876710002,98767100021);
                 INSERT INTO message_reactions(message_id,user_uid,emoji,message_author_uid,created_at)
                    VALUES (98767100013,1717,'a',987671000,NOW() + INTERVAL '1 second'),
                           (98767100013,1718,'b',987671000,NOW() + INTERVAL '1 second'),
                           (98767100015,1717,'a',987671000,NOW() + INTERVAL '1 second'),
                           (98767100025,1717,'a',987671000,NOW() + INTERVAL '1 second'),
                           (98767100025,987671000,'self',987671000,NOW() + INTERVAL '1 second');"
            )?;
            let uid = 987671000;
            crate::services::user::save_chat_settings(conn, uid, crate::dto::users::UpdateChatSettings {
                show_membership_messages: Some(false), ..Default::default()
            })?;
            let queries = Arc::new(Mutex::new(Vec::new()));
            let recorded = queries.clone();
            conn.set_instrumentation(move |event: InstrumentationEvent<'_>| {
                if let InstrumentationEvent::StartQuery { query, .. } = event {
                    recorded.lock().unwrap().push(query.to_string());
                }
            });
            let service = UnreadService::new();
            let mut scopes: Vec<_> = (1..=50).map(|n| ConversationRef {
                chat_id: 9876710000 + n, thread_id: None,
            }).collect();
            scopes.extend([
                ConversationRef { chat_id: 9876710001, thread_id: Some(98767100011) },
                ConversationRef { chat_id: 9876710002, thread_id: Some(98767100011) },
                ConversationRef { chat_id: 9876710050, thread_id: Some(98767100501) },
                ConversationRef { chat_id: 9876710002, thread_id: Some(98767100021) },
                ConversationRef { chat_id: 9876710001, thread_id: Some(98767100015) },
            ]);
            let rows = load_states(conn, &service, uid, &scopes)?;
            assert_eq!(rows.iter().map(|row| row.conversation).collect::<Vec<_>>(), scopes);
            assert_eq!(rows[0].last_read_message_id, None);
            assert_eq!(rows[0].unread_count, 3);
            for (index, row) in rows[1..48].iter().enumerate() {
                assert!(row.accessible);
                assert_eq!(row.unread_count, 2);
                assert_eq!(row.last_read_message_id, Some((9876710002 + index as i64) * 10 + 1));
            }
            assert_eq!(rows[48].unread_count, 3); // DM events remain visible.
            assert!(rows[50].accessible); // Thread access needs membership, not a subscription.
            assert_eq!(rows[50].unread_count, 1);
            assert_eq!((rows[0].unread_mentions, rows[0].unread_reactions), (1, 1));
            assert_eq!((rows[50].unread_mentions, rows[50].unread_reactions), (1, 1));
            // A valid root without a thread state has no unread messages, but
            // mentions use cursor zero and reactions use the -infinity fallback.
            assert!(rows[53].accessible);
            assert_eq!(rows[53].last_read_message_id, None);
            assert_eq!((rows[53].unread_count, rows[53].unread_mentions, rows[53].unread_reactions), (0, 1, 1));
            assert!(!rows[54].accessible); // A reply is not a thread root.
            for index in [49,51,52] {
                assert!(!rows[index].accessible);
                assert_eq!(rows[index].last_read_message_id, None);
                assert_eq!(rows[index].unread_count, 0);
            }
            assert!(queries.lock().unwrap().len() <= 8, "snapshot queries must not grow per scope");
            crate::services::user::save_chat_settings(conn, uid, crate::dto::users::UpdateChatSettings {
                show_membership_messages: Some(true), ..Default::default()
            })?;
            queries.lock().unwrap().clear();
            let shown = load_states(conn, &service, uid, &scopes)?;
            assert_eq!(shown[0].unread_count, 4);
            assert_eq!(shown[1].unread_count, 3);
            assert_eq!(shown[50].unread_count, 1);
            assert!(queries.lock().unwrap().len() <= 8, "snapshot queries must stay batched");
            queries.lock().unwrap().clear();
            assert!(load_states(conn, &service, uid, &[])?.is_empty());
            assert!(queries.lock().unwrap().is_empty());
            Ok(())
        });
}

#[test]
fn scopes_are_bounded_unique_and_positive() {
    let scope = ConversationRef {
        chat_id: 1,
        thread_id: None,
    };
    assert!(valid_scopes(&[scope]));
    assert!(!valid_scopes(&[scope, scope]));
    assert!(!valid_scopes(&[ConversationRef {
        chat_id: 0,
        ..scope
    }]));
    assert!(!valid_scopes(
        &(1..=513)
            .map(|chat_id| ConversationRef {
                chat_id,
                thread_id: None
            })
            .collect::<Vec<_>>()
    ));
}
#[tokio::test]
async fn publishes_full_then_only_changes_and_cancels() {
    let changed = Arc::new(Notify::new());
    let (tx, rx) = watch::channel(None);
    let (output, mut messages) = mpsc::channel(8);
    let count = Arc::new(std::sync::atomic::AtomicI64::new(2));
    let load_count = count.clone();
    let task = tokio::spawn(run_with(
        changed.clone(),
        rx,
        WatchOutput::Legacy(output),
        move |watch| {
            let count = load_count.load(std::sync::atomic::Ordering::SeqCst);
            async move {
                Ok(watch
                    .conversations
                    .into_iter()
                    .map(|conversation| ConversationState {
                        conversation,
                        accessible: true,
                        last_read_message_id: None,
                        unread_count: count,
                        unread_mentions: 0,
                        unread_reactions: 0,
                    })
                    .collect())
            }
        },
    ));
    tx.send_replace(Some(StateWatch {
        request_id: 1,
        generation: 0,
        conversations: vec![ConversationRef {
            chat_id: 1,
            thread_id: None,
        }],
    }));
    let ServerWsMessage::ConversationStates(first) = messages.recv().await.unwrap() else {
        panic!()
    };
    assert!(first.full);
    count.store(0, std::sync::atomic::Ordering::SeqCst);
    changed.notify_one();
    let ServerWsMessage::ConversationStates(next) = messages.recv().await.unwrap() else {
        panic!()
    };
    assert!(!next.full);
    assert_eq!(next.states[0].unread_count, 0);
    tx.send_replace(None);
    tokio::task::yield_now().await;
    changed.notify_one();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(messages.try_recv().is_err());
    drop(tx);
    task.await.unwrap();
}
