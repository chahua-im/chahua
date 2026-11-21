use super::*;
use diesel::{connection::InstrumentationEvent, Connection};
use std::{sync::mpsc, thread::JoinHandle, time::Duration};

// Pause the real Reader after a selected database read has completed. The
// writer commits before key discovery or hydration continues. No server hook
// or alternate replay implementation is used.
fn after_read(
    reader: &mut PgConnection,
    mut writer: PgConnection,
    table: &'static str,
    operation: impl FnOnce(&mut PgConnection) + Send + 'static,
) -> JoinHandle<()> {
    let (start, started) = mpsc::channel();
    let (committed, finished) = mpsc::channel();
    let job = std::thread::spawn(move || {
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        operation(&mut writer);
        committed.send(()).unwrap();
    });
    let mut armed = true;
    reader.set_instrumentation(move |event: InstrumentationEvent<'_>| {
        if let InstrumentationEvent::FinishQuery { query, .. } = event {
            if armed {
                let sql = query.to_string();
                if sql.starts_with("SELECT") && sql.contains(table) {
                    armed = false;
                    start.send(()).unwrap();
                    finished.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            }
        }
    });
    job
}

#[tokio::test]
async fn list_sync_snapshot_keeps_removal_when_pruning_commits_after_floor_read() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let deps = Dependencies::new();
    let mut conn = fixture.connect();
    conn.batch_execute(
        "BEGIN; INSERT INTO groups(id,name) VALUES (1,'snapshot removal');
         INSERT INTO group_membership(chat_id,uid) VALUES (1,4305); COMMIT;",
    )
    .unwrap();
    let reset = deps.page(&mut conn, UID, None, 100);
    let token = catch_up(
        &deps,
        &mut conn,
        cursor(&reset).into(),
        100,
        &mut BTreeMap::new(),
    );
    conn.batch_execute(
        "BEGIN; DELETE FROM group_membership WHERE chat_id=1; COMMIT;
         UPDATE list_sync_personal SET recorded_at=now()-interval '31 days' WHERE uid=4305;",
    )
    .unwrap();
    let job = after_read(&mut conn, fixture.connect(), "list_sync_meta", |writer| {
        super::super::prune::prune_before(writer, chrono::Utc::now() - chrono::TimeDelta::days(30))
            .unwrap();
    });
    let page = deps.page(&mut conn, UID, Some(&token), 100);
    job.join().unwrap();
    assert!(page["reset"].is_null());
    assert_eq!(page["removed"], json!([{ "chatId": "1" }]));
    assert_eq!(page["complete"], true);
    let expired = deps.page(&mut conn, UID, Some(&token), 100);
    assert_eq!(expired["reset"], "expired");
    let at_floor = deps.page(&mut conn, UID, Some(cursor(&page)), 100);
    assert!(at_floor["reset"].is_null());
    assert_eq!(at_floor["removed"], json!([]));
    assert_eq!(at_floor["complete"], true);
    let baseline = deps.page(&mut conn, UID, Some(cursor(&expired)), 100);
    assert!(baseline["reset"].is_null());
    assert_eq!(baseline["complete"], false);
    assert_eq!(
        deps.page(&mut conn, UID, Some(cursor(&baseline)), 100)["complete"],
        true
    );
}

#[tokio::test]
async fn list_sync_snapshot_excludes_writer_commit_between_discovery_and_hydration() {
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let deps = Dependencies::new();
    let mut conn = fixture.connect();
    conn.batch_execute(
        "BEGIN; INSERT INTO groups(id,name,last_message_id) VALUES (1,'snapshot hydration',NULL);
         INSERT INTO group_membership(chat_id,uid) VALUES (1,4305);
         INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,message,created_at)
             VALUES (101,1,4305,'text','snapshot-hydration','baseline',now());
         UPDATE groups SET last_message_id=101 WHERE id=1; COMMIT;"
    ).unwrap();
    let reset = deps.page(&mut conn, UID, None, 100);
    let token = catch_up(
        &deps,
        &mut conn,
        cursor(&reset).into(),
        100,
        &mut BTreeMap::new(),
    );
    conn.batch_execute("UPDATE messages SET message='at snapshot' WHERE id=101")
        .unwrap();
    let job = after_read(
        &mut conn,
        fixture.connect(),
        "list_sync_personal",
        |writer| {
            writer
                .batch_execute("UPDATE messages SET message='later commit' WHERE id=101")
                .unwrap();
        },
    );
    let page = deps.page(&mut conn, UID, Some(&token), 100);
    job.join().unwrap();
    assert_eq!(page["chats"][0]["lastMessage"]["message"], "at snapshot");
    assert_eq!(page["latestMessages"][0]["message"], "at snapshot");
    assert_eq!(position(&deps, &page).s, 2);
    let later = deps.page(&mut conn, UID, Some(cursor(&page)), 100);
    assert_eq!(later["chats"][0]["lastMessage"]["message"], "later commit");
    assert_eq!(later["latestMessages"][0]["message"], "later commit");
    assert_eq!(position(&deps, &later).s, 3);
    let current = deps.page(&mut conn, UID, Some(cursor(&later)), 100);
    assert_eq!(current["chats"], json!([]));
    assert_eq!(current["complete"], true);
}
