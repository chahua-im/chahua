use std::{collections::BTreeMap, sync::Arc};

use diesel::{connection::SimpleConnection, PgConnection};
use serde_json::{json, Value};

use super::{
    cursor::{Mode, Position},
    Reader,
};
use crate::{
    config::MediaConfig,
    dto::{chats::ListChatsQuery, threads::ListThreadsQuery},
    metrics::Metrics,
    services::{
        api::{chats::get_chats, threads::get_threads},
        avatars::AvatarService,
        media::MediaStore,
        sync_cursor::CursorKey,
        sync_test_support::SyncFixture,
        unread::UnreadService,
    },
};

const UID: i32 = 4305;

struct Dependencies {
    key: CursorKey,
    unread: UnreadService,
    media: MediaStore,
    avatars: AvatarService,
    metrics: Metrics,
}

impl Dependencies {
    fn new() -> Self {
        let metrics = Metrics::new();
        Self {
            key: CursorKey::new(b"list-test-secret", b"chahua.list-sync.cursor.v1"),
            unread: UnreadService::new(),
            media: MediaStore::new(
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
            ),
            avatars: AvatarService::new(None, metrics.avatars.clone()),
            metrics,
        }
    }

    fn reader(&self) -> Reader<'_> {
        Reader {
            key: &self.key,
            unread: &self.unread,
            media: &self.media,
            avatars: &self.avatars,
            stages: self.metrics.api.stages("test", "chats.difference"),
        }
    }

    fn page(&self, conn: &mut PgConnection, uid: i32, token: Option<&str>, limit: usize) -> Value {
        serde_json::to_value(
            self.reader()
                .difference_with_limit(conn, uid, token, limit)
                .unwrap(),
        )
        .unwrap()
    }
}

fn cursor(page: &Value) -> &str {
    page["cursor"].as_str().unwrap()
}
fn array<'a>(page: &'a Value, name: &str) -> &'a Vec<Value> {
    page[name].as_array().unwrap()
}
fn position(deps: &Dependencies, page: &Value) -> Position {
    deps.key.decode(cursor(page)).unwrap()
}

fn apply(map: &mut BTreeMap<(String, String), Value>, page: &Value) {
    for item in array(page, "chats") {
        map.insert(
            (item["id"].as_str().unwrap().into(), "0".into()),
            item.clone(),
        );
    }
    for item in array(page, "threads") {
        map.insert(
            (
                item["chatId"].as_str().unwrap().into(),
                item["threadRootMessage"]["id"].as_str().unwrap().into(),
            ),
            item.clone(),
        );
    }
    for item in array(page, "removed") {
        let chat = item["chatId"].as_str().unwrap();
        if let Some(thread) = item.get("threadId") {
            map.remove(&(chat.into(), thread.as_str().unwrap().into()));
        } else {
            map.retain(|(id, _), _| id != chat);
        }
    }
}

fn catch_up(
    deps: &Dependencies,
    conn: &mut PgConnection,
    mut token: String,
    limit: usize,
    map: &mut BTreeMap<(String, String), Value>,
) -> String {
    for _ in 0..100 {
        let page = deps.page(conn, UID, Some(&token), limit);
        assert!(page["reset"].is_null(), "unexpected reset: {page}");
        apply(map, &page);
        token = cursor(&page).into();
        if page["complete"] == true {
            return token;
        }
    }
    panic!("sync did not terminate");
}

async fn legacy_map(
    deps: &Dependencies,
    conn: &mut PgConnection,
    chats: &[i64],
    roots: &[(i64, bool)],
) -> BTreeMap<(String, String), Value> {
    let mut result = BTreeMap::new();
    for &id in chats {
        for archived in [false, true] {
            let response = get_chats(
                UID,
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
            UID,
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

#[tokio::test]
async fn list_sync_baseline_keyset_retry_and_catchup_match_exact_legacy_rows() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    conn.batch_execute("BEGIN;
        INSERT INTO groups(id,name) VALUES (10,'one'),(20,'two'),(30,'three');
        INSERT INTO group_membership(chat_id,uid) VALUES (10,4305),(20,4305),(30,4305);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,has_thread)
        VALUES (101,10,4305,'text','first','root-101',now(),true),
               (102,10,4305,'text','second','root-102',now(),true),
               (201,20,4305,'text','third','root-201',now(),true);
        INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed,subscribed_at,archived)
        VALUES (10,101,4305,true,'2020-01-01',false),(20,201,4305,true,'2020-01-01',true);
        COMMIT;").unwrap();
    let deps = Dependencies::new();
    let reset = deps.page(&mut conn, UID, None, 2);
    assert_eq!(reset["reset"], "noBaseline");
    let start = cursor(&reset).to_owned();
    let page = deps.page(&mut conn, UID, Some(&start), 2);
    assert_eq!(page["complete"], false);
    let retry = deps.page(&mut conn, UID, Some(&start), 2);
    assert_eq!(page, retry);
    let mut staged = BTreeMap::new();
    apply(&mut staged, &page);
    conn.batch_execute("BEGIN;
        DELETE FROM group_membership WHERE chat_id=10 AND uid=4305;
        UPDATE group_membership SET archived=true WHERE chat_id=20 AND uid=4305;
        INSERT INTO groups(id,name) VALUES (5,'behind');
        INSERT INTO group_membership(chat_id,uid) VALUES (5,4305);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,has_thread)
          VALUES (51,5,4305,'text','new root','root-51',now(),true);
        INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed,subscribed_at,archived)
          VALUES (5,51,4305,true,'2020-01-01',false);
        COMMIT;").unwrap();
    let done = catch_up(&deps, &mut conn, cursor(&page).into(), 2, &mut staged);
    let expected = legacy_map(&deps, &mut conn, &[5, 20, 30], &[(51, false), (201, true)]).await;
    assert_eq!(staged, expected);
    let empty = deps.page(&mut conn, UID, Some(&done), 2);
    assert_eq!(empty["complete"], true);
    assert!(
        array(&empty, "chats").is_empty()
            && array(&empty, "threads").is_empty()
            && array(&empty, "removed").is_empty()
    );
}

#[tokio::test]
async fn list_sync_empty_account_and_cursor_fences() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    let deps = Dependencies::new();
    let reset = deps.page(&mut conn, UID, None, 2);
    assert_eq!(reset["reset"], "noBaseline");
    let baseline = deps.page(&mut conn, UID, Some(cursor(&reset)), 2);
    assert_eq!(baseline["complete"], false);
    assert!(matches!(position(&deps, &baseline).mode, Mode::Delta));
    let delta = deps.page(&mut conn, UID, Some(cursor(&baseline)), 2);
    assert_eq!(delta["complete"], true);
    for bad in [
        "bad".to_owned(),
        "x".repeat(513),
        CursorKey::new(b"list-test-secret", b"chahua.message-sync.cursor.v1")
            .encode(&position(&deps, &delta)),
        deps.key.encode(&json!({"bad":true})),
    ] {
        let page = deps.page(&mut conn, UID, Some(&bad), 2);
        assert_eq!(page["reset"], "invalidCursor");
        assert_eq!(page["complete"], false);
        for name in ["chats", "threads", "latestMessages", "removed"] {
            assert!(array(&page, name).is_empty());
        }
        assert!(matches!(
            position(&deps, &page).mode,
            Mode::Baseline { last: None }
        ));
    }
    let current = position(&deps, &delta);
    let mut altered = current;
    let token = cursor(&delta);
    let mut tampered = token.as_bytes().to_vec();
    let index = token.find('.').unwrap() + 1;
    tampered[index] = if tampered[index] == b'A' { b'B' } else { b'A' };
    assert_eq!(
        deps.page(
            &mut conn,
            UID,
            Some(std::str::from_utf8(&tampered).unwrap()),
            2
        )["reset"],
        "invalidCursor"
    );
    altered.u += 1;
    assert_eq!(
        deps.page(&mut conn, UID, Some(&deps.key.encode(&altered)), 2)["reset"],
        "invalidCursor"
    );
    altered = current;
    altered.e = uuid::Uuid::new_v4();
    assert_eq!(
        deps.page(&mut conn, UID, Some(&deps.key.encode(&altered)), 2)["reset"],
        "epochChanged"
    );
    altered = current;
    altered.s += 1;
    assert_eq!(
        deps.page(&mut conn, UID, Some(&deps.key.encode(&altered)), 2)["reset"],
        "invalidCursor"
    );
    conn.batch_execute("UPDATE list_sync_meta SET head=2, retained_after=1;")
        .unwrap();
    altered = current;
    altered.s = 1;
    assert!(deps.page(&mut conn, UID, Some(&deps.key.encode(&altered)), 2)["reset"].is_null());
    altered.s = 0;
    assert_eq!(
        deps.page(&mut conn, UID, Some(&deps.key.encode(&altered)), 2)["reset"],
        "expired"
    );
    conn.batch_execute("INSERT INTO list_sync_account(uid,seq) VALUES (4305,2)")
        .unwrap();
    for mode in [Mode::Delta, Mode::Baseline { last: None }] {
        altered.s = 1;
        altered.mode = mode;
        let page = deps.page(&mut conn, UID, Some(&deps.key.encode(&altered)), 2);
        assert_eq!(page["reset"], "accountChanged");
        assert_eq!(position(&deps, &page).s, 2);
    }
}

#[tokio::test]
async fn list_sync_whole_positions_bound_hydration_not_backlog() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    let deps = Dependencies::new();
    let reset = deps.page(&mut conn, UID, None, 100);
    let baseline = deps.page(&mut conn, UID, Some(cursor(&reset)), 100);
    let start = cursor(&baseline).to_owned();
    conn.batch_execute("UPDATE list_sync_meta SET head=2;
        INSERT INTO list_sync_personal(uid,chat_id,thread_root_id,seq,removed,recorded_at)
        SELECT 4305,id,0,CASE WHEN id<=99 THEN 1 ELSE 2 END,true,now() FROM generate_series(1,199) id;").unwrap();
    let first = deps.page(&mut conn, UID, Some(&start), 100);
    assert_eq!(array(&first, "removed").len(), 99);
    assert_eq!(first["complete"], false);
    assert_eq!(array(&first, "removed")[0].as_object().unwrap().len(), 1);
    let second = deps.page(&mut conn, UID, Some(cursor(&first)), 100);
    assert_eq!(array(&second, "removed").len(), 100);
    assert_eq!(second["complete"], true);
    assert_eq!(deps.page(&mut conn, UID, Some(&start), 100), first);
    conn.batch_execute(
        "TRUNCATE list_sync_personal; UPDATE list_sync_meta SET head=3;
        INSERT INTO list_sync_personal(uid,chat_id,thread_root_id,seq,removed,recorded_at)
        SELECT 4305,id,0,3,true,now() FROM generate_series(1,1000) id;",
    )
    .unwrap();
    let thousand = deps.page(&mut conn, UID, Some(cursor(&second)), 100);
    assert!(thousand["reset"].is_null());
    assert_eq!(array(&thousand, "removed").len(), 1000);
    conn.batch_execute("UPDATE list_sync_meta SET head=4;
        UPDATE list_sync_personal SET seq=4;
        INSERT INTO list_sync_personal(uid,chat_id,thread_root_id,seq,removed,recorded_at) VALUES (4305,1001,0,4,true,now());").unwrap();
    let too_large = deps.page(&mut conn, UID, Some(cursor(&thousand)), 100);
    assert_eq!(too_large["reset"], "tooLarge");
    for name in ["chats", "threads", "latestMessages", "removed"] {
        assert!(array(&too_large, name).is_empty());
    }
    conn.batch_execute(
        "TRUNCATE list_sync_personal; UPDATE list_sync_meta SET head=24;
        INSERT INTO list_sync_personal(uid,chat_id,thread_root_id,seq,removed,recorded_at)
        SELECT 4305,id,0,5+(id-1)/100,true,now() FROM generate_series(1,2000) id;",
    )
    .unwrap();
    let mut token = cursor(&thousand).to_owned();
    let mut count = 0;
    loop {
        let page = deps.page(&mut conn, UID, Some(&token), 100);
        assert!(page["reset"].is_null());
        assert!(array(&page, "removed").len() <= 100);
        count += array(&page, "removed").len();
        token = cursor(&page).into();
        if page["complete"] == true {
            break;
        }
        assert!(count <= 2000);
    }
    assert_eq!(count, 2000);
}

#[tokio::test]
async fn list_sync_projection_matches_legacy_and_history_with_hidden_tail_and_mixed_threads() {
    use crate::{dto::messages::ListMessagesQuery, services::api::chats::messages::get_messages};
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    conn.batch_execute("BEGIN;
        INSERT INTO groups(id,name,membership_message_visibility) VALUES (10,'projection','nobody');
        INSERT INTO group_membership(chat_id,uid) VALUES (10,4305);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,has_thread)
        VALUES (101,10,4306,'text','redacted root','redacted',now(),true),
               (102,10,4306,'text','archived root','archived',now(),true),
               (110,10,4306,'text','visible tail','visible',now(),false);
        UPDATE messages SET deleted_at=now() WHERE id=101;
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,reply_root_id)
        VALUES (103,10,4306,'text','reply one','reply-one',now(),101),
               (104,10,4306,'text','reply two','reply-two',now(),102);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,system_kind,message,client_generated_id,created_at)
        VALUES (111,10,4306,'system','member_joined','hidden','hidden',now());
        UPDATE groups SET last_message_id=111 WHERE id=10;
        INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed,subscribed_at,archived)
        VALUES (10,101,4305,true,'2020-01-01',false),(10,102,4305,true,'2020-01-01',true);
        INSERT INTO attachments(id,message_id,kind,external_reference,size,created_at,\"order\")
        VALUES (501,110,'image/png','test',1,now(),0);
        INSERT INTO message_reactions(message_id,user_uid,emoji,message_author_uid)
        VALUES (110,4305,'👍',4306);
        COMMIT;").unwrap();
    let deps = Dependencies::new();
    let reset = deps.page(&mut conn, UID, None, 100);
    let page = deps.page(&mut conn, UID, Some(cursor(&reset)), 100);
    let mut projected = BTreeMap::new();
    apply(&mut projected, &page);
    assert_eq!(
        projected,
        legacy_map(&deps, &mut conn, &[10], &[(101, false), (102, true)]).await
    );
    assert_eq!(array(&page, "chats")[0]["lastMessage"]["id"], "110");
    assert_eq!(array(&page, "latestMessages").len(), 1);
    let history = get_messages(
        UID,
        10,
        ListMessagesQuery {
            before: None,
            around: None,
            after: None,
            max: None,
            thread_id: None,
        },
        &mut conn,
        &deps.media,
        &deps.avatars,
    )
    .await
    .unwrap();
    let selected = history
        .messages
        .iter()
        .find(|message| message.id == 110)
        .unwrap();
    assert_eq!(
        array(&page, "latestMessages")[0],
        serde_json::to_value(selected).unwrap()
    );
    assert!(!history.messages.iter().any(|message| message.id == 111));
    let threads = array(&page, "threads");
    let root = threads
        .iter()
        .find(|thread| thread["threadRootMessage"]["id"] == "101")
        .unwrap();
    assert_eq!(root["threadRootMessage"]["isDeleted"], true);
    assert!(root["threadRootMessage"]["message"].is_null());
    assert!(threads
        .iter()
        .all(|thread| thread["unreadCount"].as_i64().unwrap() > 0));
}

#[tokio::test]
async fn list_sync_visibility_transitions_and_settings_are_replayed() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    conn.batch_execute("BEGIN;
        INSERT INTO groups(id,name) VALUES (10,'transitions');
        INSERT INTO group_membership(chat_id,uid,muted_until) VALUES (10,4305,now()-interval '1 day');
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,has_thread)
        VALUES (101,10,4306,'text','root','transition-root',now(),true);
        INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed) VALUES (10,101,4305,true);
        INSERT INTO user_extra(uid,first_seen_at,last_seen_at,mute_group_chats_by_default)
        VALUES (4305,now(),now(),true);
        COMMIT;").unwrap();
    let deps = Dependencies::new();
    let reset = deps.page(&mut conn, UID, None, 100);
    let baseline = deps.page(&mut conn, UID, Some(cursor(&reset)), 100);
    assert_eq!(array(&baseline, "chats")[0]["isMuted"], true);
    assert_eq!(
        baseline["notificationSettings"]["muteGroupChatsByDefault"],
        true
    );
    let mut map = BTreeMap::new();
    apply(&mut map, &baseline);
    let mut token = catch_up(&deps, &mut conn, cursor(&baseline).into(), 100, &mut map);
    conn.batch_execute("UPDATE messages SET has_thread=false WHERE id=101")
        .unwrap();
    let vanished = deps.page(&mut conn, UID, Some(&token), 100);
    assert!(array(&vanished, "removed").contains(&json!({"chatId":"10","threadId":"101"})));
    apply(&mut map, &vanished);
    token = cursor(&vanished).into();
    conn.batch_execute("UPDATE messages SET has_thread=true WHERE id=101")
        .unwrap();
    let restored = deps.page(&mut conn, UID, Some(&token), 100);
    assert_eq!(array(&restored, "threads").len(), 1);
    apply(&mut map, &restored);
    token = cursor(&restored).into();
    conn.batch_execute(
        "UPDATE thread_user_states SET subscribed=false WHERE thread_root_id=101 AND uid=4305",
    )
    .unwrap();
    let unsubscribed = deps.page(&mut conn, UID, Some(&token), 100);
    assert!(array(&unsubscribed, "removed").contains(&json!({"chatId":"10","threadId":"101"})));
    token = cursor(&unsubscribed).into();
    conn.batch_execute(
        "UPDATE thread_user_states SET subscribed=true WHERE thread_root_id=101 AND uid=4305",
    )
    .unwrap();
    let resubscribed = deps.page(&mut conn, UID, Some(&token), 100);
    assert_eq!(array(&resubscribed, "threads").len(), 1);
    token = cursor(&resubscribed).into();
    conn.batch_execute("DELETE FROM group_membership WHERE chat_id=10 AND uid=4305")
        .unwrap();
    let left = deps.page(&mut conn, UID, Some(&token), 100);
    assert!(array(&left, "removed").contains(&json!({"chatId":"10"})));
    assert!(array(&left, "threads").is_empty());
    token = cursor(&left).into();
    // The still-subscribed state is deliberately left behind without membership.
    let missing = deps.page(&mut conn, UID, None, 100);
    let missing = deps.page(&mut conn, UID, Some(cursor(&missing)), 100);
    assert!(array(&missing, "threads").is_empty());
    conn.batch_execute("INSERT INTO group_membership(chat_id,uid) VALUES (10,4305)")
        .unwrap();
    let rejoined = deps.page(&mut conn, UID, Some(&token), 100);
    assert_eq!(array(&rejoined, "chats").len(), 1);
    assert_eq!(array(&rejoined, "threads").len(), 1);
    token = cursor(&rejoined).into();
    conn.batch_execute("UPDATE user_extra SET show_unread_message_count=true WHERE uid=4305")
        .unwrap();
    let display = deps.page(&mut conn, UID, Some(&token), 100);
    assert!(display["reset"].is_null());
    assert_eq!(display["complete"], true);
    assert_eq!(display["chatSettings"]["showUnreadMessageCount"], true);
    assert!(array(&display, "chats").is_empty());
    conn.batch_execute("UPDATE user_extra SET mute_group_chats_by_default=false WHERE uid=4305")
        .unwrap();
    let changed = deps.page(&mut conn, UID, Some(cursor(&display)), 100);
    assert_eq!(changed["reset"], "accountChanged");
    assert_eq!(
        changed["notificationSettings"]["muteGroupChatsByDefault"],
        false
    );
    let restart = deps.page(&mut conn, UID, Some(cursor(&changed)), 100);
    assert_eq!(array(&restart, "chats")[0]["isMuted"], false);
}

#[tokio::test]
async fn list_sync_projection_sql_failure_never_returns_a_cursor() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut conn = fixture.connect();
    conn.batch_execute(
        "BEGIN;
        INSERT INTO groups(id,name) VALUES (10,'error');
        INSERT INTO group_membership(chat_id,uid) VALUES (10,4305);
        COMMIT;",
    )
    .unwrap();
    let deps = Dependencies::new();
    let reset = deps.page(&mut conn, UID, None, 100);
    // Destroy only the private fixture's projection input. A swallowed SQL
    // error still poisons the snapshot and must not acknowledge a checkpoint.
    conn.batch_execute("ALTER TABLE groups DROP COLUMN name")
        .unwrap();
    assert!(deps
        .reader()
        .difference_with_limit(&mut conn, UID, Some(cursor(&reset)), 100)
        .is_err());
}

#[path = "snapshot_tests.rs"]
mod snapshot_tests;

#[path = "dependency_tests.rs"]
mod dependency_tests;
