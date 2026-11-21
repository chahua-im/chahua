use super::*;

async fn legacy_for(
    deps: &Dependencies,
    conn: &mut PgConnection,
    uid: i32,
    chats: &[i64],
    roots: &[(i64, bool)],
) -> BTreeMap<(String, String), Value> {
    if uid == UID {
        return legacy_map(deps, conn, chats, roots).await;
    }
    let mut result = BTreeMap::new();
    for &id in chats {
        for archived in [false, true] {
            let response = get_chats(
                uid,
                ListChatsQuery {
                    chat_id: Some(id),
                    limit: Some(10),
                    after: None,
                    archived: Some(archived),
                },
                conn,
                &deps.unread,
                &deps.media,
                &deps.avatars,
                deps.metrics.api.stages("test", "chats.list"),
            )
            .await
            .unwrap();
            for chat in response.chats {
                result.insert(
                    (id.to_string(), "0".into()),
                    serde_json::to_value(chat).unwrap(),
                );
            }
        }
    }
    for &(root, archived) in roots {
        let response = get_threads(
            uid,
            ListThreadsQuery {
                root_id: Some(root),
                limit: Some(10),
                before: None,
                archived: Some(archived),
            },
            conn,
            &deps.media,
            &deps.avatars,
        )
        .unwrap();
        for thread in response.threads {
            result.insert(
                (thread.chat_id.to_string(), root.to_string()),
                serde_json::to_value(thread).unwrap(),
            );
        }
    }
    result
}

fn start(
    deps: &Dependencies,
    conn: &mut PgConnection,
    uid: i32,
) -> (String, BTreeMap<(String, String), Value>) {
    let reset = deps.page(conn, uid, None, 100);
    let mut token = cursor(&reset).to_owned();
    let mut map = BTreeMap::new();
    loop {
        let page = deps.page(conn, uid, Some(&token), 100);
        assert!(page["reset"].is_null());
        apply(&mut map, &page);
        token = cursor(&page).to_owned();
        if page["complete"] == true {
            return (token, map);
        }
    }
}

async fn delta(
    deps: &Dependencies,
    conn: &mut PgConnection,
    uid: i32,
    token: &mut String,
    map: &mut BTreeMap<(String, String), Value>,
    chats: &[i64],
    roots: &[(i64, bool)],
) -> Value {
    let page = deps.page(conn, uid, Some(token), 100);
    assert!(page["reset"].is_null(), "{page}");
    assert_eq!(page["complete"], true, "{page}");
    apply(map, &page);
    *token = cursor(&page).to_owned();
    assert_eq!(*map, legacy_for(deps, conn, uid, chats, roots).await);
    page
}

#[tokio::test]
async fn list_sync_dependency_dm_receipts_and_privacy_reproject_both_participants() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    conn.batch_execute("BEGIN;
        INSERT INTO groups(id,name,kind,dm_uid1,dm_uid2) VALUES (10,'dm','dm',4305,4306);
        INSERT INTO group_membership(chat_id,uid) VALUES (10,4305),(10,4306);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,has_thread)
        VALUES (101,10,4305,'text','root','dm-root',now(),true), (102,10,4305,'text','tail','dm-tail',now(),false);
        UPDATE groups SET last_message_id=102 WHERE id=10;
        INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed) VALUES (10,101,4305,true);
        COMMIT;").unwrap();
    let deps = Dependencies::new();
    let (mut a, mut ma) = start(&deps, &mut conn, UID);
    let (mut b, mut mb) = start(&deps, &mut conn, 4306);
    assert_eq!(
        ma,
        legacy_for(&deps, &mut conn, UID, &[10], &[(101, false)]).await
    );
    assert_eq!(mb, legacy_for(&deps, &mut conn, 4306, &[10], &[]).await);
    // The second participant is deliberately not subscribed; its receipt still affects the first.
    for sql in [
        "INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed,last_read_receipt_message_id) VALUES (10,101,4306,false,101)",
        "UPDATE thread_user_states SET last_read_receipt_message_id=NULL WHERE chat_id=10 AND thread_root_id=101 AND uid=4306",
        "UPDATE thread_user_states SET last_read_receipt_message_id=101 WHERE chat_id=10 AND thread_root_id=101 AND uid=4306",
        "DELETE FROM thread_user_states WHERE chat_id=10 AND thread_root_id=101 AND uid=4306",
    ] {
        conn.batch_execute(sql).unwrap();
        let page = delta(&deps, &mut conn, UID, &mut a, &mut ma, &[10], &[(101,false)]).await;
        assert_eq!(array(&page, "threads").len(), 1, "{sql}");
        delta(&deps, &mut conn, 4306, &mut b, &mut mb, &[10], &[]).await;
    }
    for sql in [
        "UPDATE group_membership SET last_read_receipt_message_id=101 WHERE chat_id=10 AND uid=4306",
        "UPDATE group_membership SET last_read_receipt_message_id=102 WHERE chat_id=10 AND uid=4306",
        "UPDATE group_membership SET last_read_receipt_message_id=NULL WHERE chat_id=10 AND uid=4306",
        "INSERT INTO friendships(uid1,uid2,initiated_by) VALUES (4305,4306,4305)",
        "UPDATE friendships SET uid1_shares_read_receipts=false,uid2_shares_read_receipts=false WHERE uid1=4305 AND uid2=4306",
        "UPDATE friendships SET uid1_shares_read_receipts=true,uid2_shares_read_receipts=true WHERE uid1=4305 AND uid2=4306",
        "DELETE FROM friendships WHERE uid1=4305 AND uid2=4306",
        "INSERT INTO blocks(blocker_uid,blocked_uid) VALUES (4305,4306)",
        "DELETE FROM blocks WHERE blocker_uid=4305 AND blocked_uid=4306",
        "INSERT INTO user_extra(uid,first_seen_at,last_seen_at) VALUES (4306,now(),now())",
        "UPDATE user_extra SET read_receipt_visibility='nobody' WHERE uid=4306",
        "DELETE FROM user_extra WHERE uid=4306",
    ] {
        conn.batch_execute(sql).unwrap();
        let pa = delta(&deps, &mut conn, UID, &mut a, &mut ma, &[10], &[(101,false)]).await;
        let pb = delta(&deps, &mut conn, 4306, &mut b, &mut mb, &[10], &[]).await;
        if sql.contains("friendships") || sql.contains("blocks") || sql.contains("read_receipt_visibility") || sql.starts_with("DELETE FROM user_extra") {
            assert_eq!(array(&pa, "chats").len(), 1, "{sql}");
            assert_eq!(array(&pa, "threads").len(), 1, "{sql}");
            assert_eq!(array(&pb, "chats").len(), 1, "{sql}");
        }
    }
}

#[tokio::test]
async fn list_sync_dependency_shared_avatar_scope_and_identity() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    conn.batch_execute("BEGIN;
        INSERT INTO media(id,content_type,storage_key,size,created_at,purpose) VALUES (501,'image/png','avatar-one',1,now(),'avatar'),(502,'image/png','avatar-two',1,now(),'avatar');
        INSERT INTO groups(id,name,avatar_image_id) VALUES (10,'one',501),(20,'two',501),(30,'three',502);
        INSERT INTO group_membership(chat_id,uid) VALUES (10,4305),(20,4305),(30,4305);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,has_thread) VALUES (101,10,4305,'text','root','avatar-root',now(),true);
        INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed) VALUES (10,101,4305,true);
        COMMIT;").unwrap();
    let deps = Dependencies::new();
    let (mut token, mut map) = start(&deps, &mut conn, UID);
    for (sql, expected_chats, expected_threads) in [
        (
            "UPDATE groups SET name='renamed' WHERE id=10",
            vec!["10"],
            1,
        ),
        (
            "UPDATE groups SET avatar_image_id=502 WHERE id=10",
            vec!["10"],
            1,
        ),
        (
            "UPDATE media SET deleted_at=now() WHERE id=501",
            vec!["20"],
            0,
        ),
        (
            "UPDATE media SET deleted_at=now() WHERE id=502",
            vec!["10", "30"],
            1,
        ),
    ] {
        conn.batch_execute(sql).unwrap();
        let page = delta(
            &deps,
            &mut conn,
            UID,
            &mut token,
            &mut map,
            &[10, 20, 30],
            &[(101, false)],
        )
        .await;
        let mut ids: Vec<_> = array(&page, "chats")
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        ids.sort_unstable();
        assert_eq!(ids, expected_chats, "{sql}");
        assert_eq!(array(&page, "threads").len(), expected_threads, "{sql}");
    }
}

#[tokio::test]
async fn list_sync_dependency_projection_and_thread_lifecycle() {
    use crate::{dto::messages::ListMessagesQuery, services::api::chats::messages::get_messages};
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    conn.batch_execute("BEGIN;
        INSERT INTO groups(id,name) VALUES (10,'dependencies');
        INSERT INTO group_membership(chat_id,uid) VALUES (10,4305);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,has_thread) VALUES (101,10,4306,'text','root','dep-root',now(),true),(110,10,4306,'text','tail','dep-tail',now(),false);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,reply_root_id) VALUES (102,10,4306,'text','reply','dep-reply',now(),101);
        INSERT INTO thread_meta(chat_id,thread_root_id,reply_count,last_reply_at) VALUES (10,101,1,now());
        UPDATE groups SET last_message_id=110 WHERE id=10;
        INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed) VALUES (10,101,4305,true);
        COMMIT;").unwrap();
    let deps = Dependencies::new();
    let (mut token, mut map) = start(&deps, &mut conn, UID);
    for sql in [
        "UPDATE messages SET message='edited',updated_at=now() WHERE id=110",
        "INSERT INTO message_reactions(message_id,user_uid,emoji,message_author_uid) VALUES (110,4305,'👍',4306)",
        "INSERT INTO message_mentions(message_id,mentioned_uid,chat_id) VALUES (110,4305,10)",
        "DELETE FROM message_mentions WHERE message_id=110 AND mentioned_uid=4305",
        "UPDATE group_membership SET last_read_message_id=110 WHERE chat_id=10 AND uid=4305",
        "UPDATE group_membership SET archived=true WHERE chat_id=10 AND uid=4305",
        "UPDATE group_membership SET role='admin' WHERE chat_id=10 AND uid=4305",
        "UPDATE groups SET membership_message_visibility='nobody' WHERE id=10",
    ] {
        conn.batch_execute(sql).unwrap();
        let page = delta(&deps, &mut conn, UID, &mut token, &mut map, &[10], &[(101,false)]).await;
        assert_eq!(array(&page, "chats").len(), 1, "{sql}");
        let history = get_messages(UID, 10, ListMessagesQuery { before: None, around: None, after: None, max: None, thread_id: None }, &mut conn, &deps.media, &deps.avatars).await.unwrap();
        let selected = history.messages.iter().find(|m| m.id == 110).unwrap();
        assert_eq!(array(&page, "latestMessages")[0], serde_json::to_value(selected).unwrap(), "{sql}");
    }
    // Maintenance changes are tested separately from message writes, including loss of the last reply.
    for sql in [
        "UPDATE thread_meta SET reply_count=7,last_reply_at=now() WHERE chat_id=10 AND thread_root_id=101",
        "DELETE FROM messages WHERE id=102",
        "UPDATE thread_meta SET reply_count=0,last_reply_at=NULL WHERE chat_id=10 AND thread_root_id=101",
    ] {
        conn.batch_execute(sql).unwrap();
        let page = delta(&deps, &mut conn, UID, &mut token, &mut map, &[10], &[(101,false)]).await;
        assert_eq!(array(&page, "threads").len(), 1, "{sql}");
    }
    for (sql, visible) in [
        ("UPDATE messages SET is_published=false WHERE id=101", false),
        ("UPDATE messages SET is_published=true WHERE id=101", true),
        ("UPDATE messages SET has_thread=false WHERE id=101", false),
        ("UPDATE messages SET has_thread=true WHERE id=101", true),
        ("UPDATE thread_user_states SET subscribed=false WHERE chat_id=10 AND thread_root_id=101 AND uid=4305", false),
        ("UPDATE thread_user_states SET subscribed=true WHERE chat_id=10 AND thread_root_id=101 AND uid=4305", true),
    ] {
        conn.batch_execute(sql).unwrap();
        let roots: &[(i64,bool)] = if visible { &[(101,false)] } else { &[] };
        let page = delta(&deps, &mut conn, UID, &mut token, &mut map, &[10], roots).await;
        if visible { assert_eq!(array(&page, "threads").len(), 1, "{sql}"); }
        else { assert!(array(&page, "removed").contains(&json!({"chatId":"10","threadId":"101"})), "{sql}"); }
    }
    conn.batch_execute("DELETE FROM group_membership WHERE chat_id=10 AND uid=4305")
        .unwrap();
    let page = delta(&deps, &mut conn, UID, &mut token, &mut map, &[], &[]).await;
    assert!(array(&page, "removed").contains(&json!({"chatId":"10"})));
    conn.batch_execute("INSERT INTO group_membership(chat_id,uid) VALUES (10,4305)")
        .unwrap();
    let page = delta(
        &deps,
        &mut conn,
        UID,
        &mut token,
        &mut map,
        &[10],
        &[(101, false)],
    )
    .await;
    assert_eq!(array(&page, "threads").len(), 1);
    conn.batch_execute("BEGIN; DELETE FROM thread_meta WHERE chat_id=10 AND thread_root_id=101; DELETE FROM thread_user_states WHERE chat_id=10 AND thread_root_id=101; DELETE FROM messages WHERE id=101; COMMIT;").unwrap();
    let page = delta(&deps, &mut conn, UID, &mut token, &mut map, &[10], &[]).await;
    assert!(array(&page, "removed").contains(&json!({"chatId":"10","threadId":"101"})));
}
