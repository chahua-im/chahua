use super::attachment_preview_map;
use crate::dto::messages::MessagePreviewAttachment;
use crate::models::Attachment;
use chrono::Utc;

#[test]
fn thread_reply_count_excludes_system_events() {
    use super::*;
    use diesel::connection::SimpleConnection;
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.test_transaction::<(), diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id, name) VALUES (9876790000, 'thread-count');
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      reply_root_id, has_thread, is_published, deleted_at, system_kind, created_at)
                 VALUES (9876790001, 9876790000, 1, 'text', 'count-root', NULL, true, true, NULL, NULL, NOW()),
                        (9876790002, 9876790000, 1, 'text', 'count-reply', 9876790001, false, true, NULL, NULL, NOW()),
                        (9876790003, 9876790000, 1, 'system', 'count-pin', 9876790001, false, true, NULL, 'thread_message_pinned', NOW()),
                        (9876790004, 9876790000, 1, 'text', 'count-deleted', 9876790001, false, true, NOW(), NULL, NOW()),
                        (9876790005, 9876790000, 1, 'audio', 'count-pending', 9876790001, false, false, NULL, NULL, NOW());
                 INSERT INTO thread_meta(chat_id, thread_root_id, reply_count)
                 VALUES (9876790000, 9876790001, 2);",
            )?;
            let count = |conn: &mut PgConnection| thread_meta::table
                .find((9876790000_i64, 9876790001_i64))
                .select(thread_meta::reply_count).first::<i64>(conn);
            conn.batch_execute(include_str!("../../../migrations/2026-11-13-171829-0000_exclude_system_thread_replies/up.sql"))?;
            assert_eq!(count(conn)?, 1);
            conn.batch_execute(include_str!("../../../migrations/2026-11-13-171829-0000_exclude_system_thread_replies/down.sql"))?;
            assert_eq!(count(conn)?, 2);
            recalculate_thread_meta(conn, 9876790000, 9876790001)?;
            assert_eq!(count(conn)?, 1);
            conn.batch_execute("UPDATE messages SET deleted_at = NOW() WHERE id = 9876790002")?;
            recalculate_thread_meta(conn, 9876790000, 9876790001)?;
            assert!(count(conn).optional()?.is_none());
            assert!(!messages::table.find(9876790001_i64).select(messages::has_thread).first::<bool>(conn)?);
            assert_eq!(build_thread_update_payload(conn, 9876790000, 9876790001)?.unwrap().reply_count, 0);
            // System history is retained even though it no longer defines an existing thread.
            assert!(messages::table.find(9876790003_i64).select(messages::deleted_at).first::<Option<DateTime<Utc>>>(conn)?.is_none());
            Ok(())
        });
}

#[test]
fn thread_browse_keysets_filter_and_deduplicate_authors() {
    use super::*;
    use crate::dto::threads::ThreadOrder;
    use diesel::connection::SimpleConnection;

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id, name) VALUES (9876730000, 'thread-browse'), (9876740000, 'other');
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      created_at, has_thread, is_published, deleted_at)
                 SELECT 9876730000 + n, 9876730000, 1, 'text', 'browse-root-' || n,
                        NOW(), n <> 5, n <> 4, CASE WHEN n = 3 THEN NOW() END
                 FROM generate_series(1, 5) n;
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      created_at, has_thread)
                 VALUES (9876740001, 9876740000, 200, 'text', 'browse-other-root', NOW(), TRUE);
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      created_at, reply_root_id)
                 SELECT 9876731000 + n, 9876730000, n, 'text', 'browse-reply-' || n,
                        NOW(), 9876730001 FROM generate_series(1, 105) n;
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                      created_at, reply_root_id, deleted_at, is_published)
                 VALUES (9876732000, 9876730000, 50, 'text', 'browse-duplicate', NOW(), 9876730001, NULL, TRUE),
                        (9876732001, 9876730000, 106, 'text', 'browse-deleted', NOW(), 9876730001, NOW(), TRUE),
                        (9876732002, 9876730000, 107, 'text', 'browse-unpublished', NOW(), 9876730001, NULL, FALSE);
                 INSERT INTO thread_user_states(chat_id, thread_root_id, uid, subscribed)
                 VALUES (9876730000, 9876730001, 108, TRUE);"
            )?;
            let ids = |rows: Vec<Message>| rows.into_iter().map(|m| m.id).collect::<Vec<_>>();
            assert_eq!(
                ids(get_chat_threads(conn, 9876730000, None, ThreadOrder::Newest, 2)?),
                vec![9876730003, 9876730002]
            );
            assert_eq!(
                ids(get_chat_threads(conn, 9876730000, Some(9876730002), ThreadOrder::Newest, 2)?),
                vec![9876730001]
            );
            assert_eq!(
                ids(get_chat_threads(conn, 9876730000, None, ThreadOrder::Oldest, 2)?),
                vec![9876730001, 9876730002]
            );
            assert_eq!(
                ids(get_chat_threads(conn, 9876730000, Some(9876730002), ThreadOrder::Oldest, 2)?),
                vec![9876730003]
            );
            assert_eq!(
                get_thread_participant_uids(conn, 9876730001, None, 100)?,
                (1..=100).collect::<Vec<_>>()
            );
            assert_eq!(
                get_thread_participant_uids(conn, 9876730001, Some(100), 100)?,
                vec![101, 102, 103, 104, 105]
            );
            assert!(get_thread_participant_uids(conn, 9876730001, Some(105), 100)?.is_empty());
            // Deleted roots retain their author, matching the existing inbox contract.
            assert_eq!(get_thread_participant_uids(conn, 9876730003, None, 100)?, vec![1]);
            Err(diesel::result::Error::RollbackTransaction)
        });
    assert!(matches!(
        result,
        Err(diesel::result::Error::RollbackTransaction)
    ));
}

fn attachment(id: i64, message_id: i64, kind: &str, order: i16) -> Attachment {
    Attachment {
        id,
        message_id: Some(message_id),
        uploader_uid: Some(1),
        file_name: format!("{id}.bin"),
        kind: kind.to_string(),
        external_reference: format!("attachments/{id}.bin"),
        size: 123,
        created_at: Utc::now(),
        deleted_at: None,
        width: None,
        height: None,
        order,
    }
}

#[test]
fn attachment_preview_map_returns_all_attachments_per_message() {
    let map = attachment_preview_map(vec![
        attachment(2, 10, "image/png", 1),
        attachment(1, 10, "video/mp4", 0),
        attachment(4, 20, "audio/webm", 1),
        attachment(3, 20, "image/jpeg", 0),
    ]);

    let msg10 = map.get(&10).unwrap();
    assert_eq!(msg10.len(), 2);
    assert_eq!(
        msg10,
        &[
            MessagePreviewAttachment {
                kind: "image/png".to_string()
            },
            MessagePreviewAttachment {
                kind: "video/mp4".to_string()
            },
        ]
    );

    let msg20 = map.get(&20).unwrap();
    assert_eq!(msg20.len(), 2);
    assert_eq!(
        msg20,
        &[
            MessagePreviewAttachment {
                kind: "audio/webm".to_string()
            },
            MessagePreviewAttachment {
                kind: "image/jpeg".to_string()
            },
        ]
    );
}

#[tokio::test]
async fn database_thread_previews_preserve_forward_authors() {
    use super::*;
    use crate::config::MediaConfig;
    use crate::services::avatars::AvatarMetrics;
    use diesel::connection::SimpleConnection;
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (76200, 'forward-thread-test'), (76300, 'source');
             INSERT INTO discuz.common_member(uid, username, loginname)
             VALUES (987676200, 'forwarder', 'forwarder'), (987676201, 'root author', 'root-author'),
                    (987676202, 'reply author', 'reply-author');
             INSERT INTO group_membership(chat_id, uid) VALUES (76200, 987676200);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at)
             VALUES (76301, 76300, 987676201, 'text', 'root', 'thread-origin-root', NOW()),
                    (76302, 76300, 987676202, 'text', 'reply', 'thread-origin-reply', NOW());
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, forwarded_from_message_id,
                                  reply_root_id, has_thread)
             VALUES (76201, 76200, 987676200, 'text', 'root', 'thread-copy-root', NOW(), 76301, NULL, true),
                    (76202, 76200, 987676200, 'text', 'reply', 'thread-copy-reply', NOW(), 76302, 76201, false);
             INSERT INTO thread_user_states(chat_id, thread_root_id, uid, subscribed)
             VALUES (76200, 76201, 987676200, true);",
        ).unwrap();
    let media = MediaStore::new(
        aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::Config::builder()
                .behavior_version_latest()
                .build(),
        ),
        Arc::new(MediaConfig {
            bucket: "test".into(),
            attachment_prefix: "attachments".into(),
            base_url: None,
            endpoint_url: None,
            upload_proxy_path: None,
            max_attachment_file_size_bytes: 1,
        }),
    );
    let avatars = AvatarService::new(
        None,
        Arc::new(AvatarMetrics::new(&prometheus::Registry::new())),
    );
    let load = |conn: &mut PgConnection| {
        let roots = messages::table
            .filter(messages::id.eq(76201))
            .select(Message::as_select())
            .load(conn)
            .unwrap();
        let rows = get_user_threads(conn, 987676200, 20, None, false, None).unwrap();
        enrich_thread_list(conn, rows, false, roots, 987676200, &media, &avatars)
            .unwrap()
            .threads
            .remove(0)
    };
    let thread = load(&mut conn);
    assert!(thread.peer.is_none());
    let serialized = serde_json::to_value(&thread).unwrap();
    assert!(serialized.get("participants").is_none());
    assert!(serialized["peer"].is_null());
    assert_eq!(
        thread.thread_root_message.forwarded_from_name.as_deref(),
        Some("root author")
    );
    assert_eq!(
        thread.last_reply.unwrap().forwarded_from_name.as_deref(),
        Some("reply author")
    );

    // The DM peer is the other chat member even if they never authored a thread message.
    conn.batch_execute(
        "UPDATE groups SET kind = 'dm', dm_uid1 = 987676200, dm_uid2 = 987676201 WHERE id = 76200;",
    )
    .unwrap();
    let thread = load(&mut conn);
    let peer = thread.peer.unwrap();
    assert_eq!(peer.uid, 987676201);
    assert_eq!(peer.username.as_deref(), Some("root author"));
    conn.batch_execute(
        "UPDATE groups SET kind = 'group', dm_uid1 = NULL, dm_uid2 = NULL WHERE id = 76200;",
    )
    .unwrap();

    // Attribution survives source deletion, and never changes the copy's sender.
    conn.batch_execute("UPDATE messages SET deleted_at = NOW() WHERE chat_id = 76300;")
        .unwrap();
    let thread = load(&mut conn);
    assert_eq!(thread.thread_root_message.sender.uid, 987676200);
    assert_eq!(
        thread.thread_root_message.forwarded_from_name.as_deref(),
        Some("root author")
    );
    assert_eq!(
        thread.last_reply.unwrap().forwarded_from_name.as_deref(),
        Some("reply author")
    );

    // Redact a deleted root; an ordinary latest reply has no attribution.
    conn.batch_execute(
            "UPDATE messages SET deleted_at = NOW() WHERE id = 76201;
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, reply_root_id)
             VALUES (76203, 76200, 987676200, 'text', 'ordinary reply', 'thread-ordinary-reply', NOW(), 76201);",
        ).unwrap();
    let thread = load(&mut conn);
    assert!(thread.thread_root_message.is_deleted);
    assert!(thread.thread_root_message.forwarded_from_name.is_none());
    let reply = thread.last_reply.unwrap();
    assert_eq!(reply.id, 76203);
    assert!(reply.forwarded_from_name.is_none());
    conn.batch_execute(
            "INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, reply_root_id, has_thread)
             VALUES (76204, 76200, 987676200, 'text', 'archived root', 'thread-archived-root', NOW(), NULL, TRUE),
                    (76205, 76200, 987676200, 'text', 'archived reply', 'thread-archived-reply', NOW(), 76204, FALSE);
             INSERT INTO thread_user_states(chat_id, thread_root_id, uid, subscribed, archived)
             VALUES (76200, 76204, 987676200, TRUE, TRUE);",
        ).unwrap();
    let roots = messages::table
        .filter(messages::id.eq_any([76201_i64, 76204]))
        .select(Message::as_select())
        .load::<Message>(&mut conn)
        .unwrap();
    for reverse in [false, true] {
        let mut rows = load_thread_rows_by_roots(&mut conn, 987676200, &[76201, 76204]).unwrap();
        assert_eq!(rows.len(), 2);
        rows.sort_by_key(|row| row.archived);
        if reverse {
            rows.reverse();
        }
        let items = enrich_thread_list(
            &mut conn,
            rows,
            false,
            roots.clone(),
            987676200,
            &media,
            &avatars,
        )
        .unwrap()
        .threads;
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.unread_count > 0));
    }
    conn.batch_execute("DELETE FROM group_membership WHERE chat_id = 76200 AND uid = 987676200;")
        .unwrap();
    assert!(
        load_thread_rows_by_roots(&mut conn, 987676200, &[76201, 76204])
            .unwrap()
            .is_empty()
    );
    assert!(load_thread_rows_by_roots(&mut conn, 987676200, &[])
        .unwrap()
        .is_empty());
    conn.batch_execute("ROLLBACK").unwrap();
}
