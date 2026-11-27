use super::*;
use crate::dto::ws::ServerWsMessage;
use crate::services::read_receipts::broadcast_privacy_changed_for_peers;
use crate::services::ws_registry::{ConnectionRegistry, WsMetrics};
use diesel::connection::SimpleConnection;
use std::sync::Arc;

#[test]
fn only_lists_and_clears_the_callers_direction_and_selected_policy() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute(
        "CREATE TEMP TABLE friendships (LIKE public.friendships INCLUDING ALL);
             INSERT INTO friendships (uid1, uid2, initiated_by, uid1_shares_presence,
                 uid2_shares_presence, uid1_shares_read_receipts, uid2_shares_read_receipts)
             VALUES (1, 10, 1, TRUE, FALSE, FALSE, TRUE),
                    (10, 20, 10, TRUE, FALSE, FALSE, TRUE),
                    (10, 30, 10, NULL, TRUE, NULL, FALSE),
                    (20, 30, 20, TRUE, FALSE, TRUE, FALSE);
             CREATE TEMP TABLE groups AS
                 SELECT id, kind, dm_uid1, dm_uid2 FROM public.groups WITH NO DATA;
             INSERT INTO groups (id, kind, dm_uid1, dm_uid2) VALUES
                 (101, 'dm', 1, 10), (102, 'dm', 10, 20),
                 (103, 'dm', 10, 30), (104, 'dm', 20, 30);",
    )
    .unwrap();
    assert_eq!(
        list(&mut conn, 10, PrivacyExceptionKind::Presence).unwrap(),
        vec![(1, false), (20, true)]
    );
    assert_eq!(
        count(&mut conn, 10, PrivacyExceptionKind::Presence).unwrap(),
        2
    );
    assert_eq!(
        clear(&mut conn, 10, PrivacyExceptionKind::Presence).unwrap(),
        vec![1, 20]
    );
    assert!(list(&mut conn, 10, PrivacyExceptionKind::Presence)
        .unwrap()
        .is_empty());
    assert_eq!(
        list(&mut conn, 1, PrivacyExceptionKind::Presence).unwrap(),
        vec![(10, true)]
    );
    assert_eq!(
        list(&mut conn, 20, PrivacyExceptionKind::Presence).unwrap(),
        vec![(10, false), (30, true)]
    );
    assert_eq!(
        list(&mut conn, 10, PrivacyExceptionKind::ReadReceipts).unwrap(),
        vec![(1, true), (20, false)]
    );
    let registry = Arc::new(ConnectionRegistry::new(Arc::new(WsMetrics::new(
        &prometheus::Registry::new(),
    ))));
    let mut devices = Vec::new();
    for uid in [1, 10, 10, 20, 30] {
        let (_, mut rx) = registry.register(uid, format!("device-{}", devices.len()));
        while rx.try_recv().is_ok() {}
        devices.push((uid, rx));
    }
    // A second device registration also sends presence to the owner's first device.
    for (_, rx) in &mut devices {
        while rx.try_recv().is_ok() {}
    }
    let peers = clear(&mut conn, 10, PrivacyExceptionKind::ReadReceipts).unwrap();
    assert_eq!(peers, vec![1, 20]);
    broadcast_privacy_changed_for_peers(&mut conn, &registry, 10, &peers).unwrap();
    for (uid, rx) in &mut devices {
        let mut chats = Vec::new();
        while let Ok(message) = rx.try_recv() {
            let ServerWsMessage::ReadReceiptChanged(payload) = &*message else {
                panic!("unexpected event: {message:?}");
            };
            assert_eq!(payload.privacy_changed, Some(true));
            assert_eq!(payload.reader_uid, None);
            assert_eq!(payload.thread_root_id, None);
            chats.push(payload.chat_id);
        }
        chats.sort_unstable();
        assert_eq!(
            chats,
            match uid {
                1 => vec![101],
                10 => vec![101, 102],
                20 => vec![102],
                _ => vec![],
            }
        );
    }
    let peers = clear(&mut conn, 10, PrivacyExceptionKind::ReadReceipts).unwrap();
    assert!(peers.is_empty());
    broadcast_privacy_changed_for_peers(&mut conn, &registry, 10, &peers).unwrap();
    assert!(devices.iter_mut().all(|(_, rx)| rx.try_recv().is_err()));
    assert_eq!(
        count(&mut conn, 10, PrivacyExceptionKind::ReadReceipts).unwrap(),
        0
    );
    assert_eq!(
        count(&mut conn, 1, PrivacyExceptionKind::ReadReceipts).unwrap(),
        1
    );
}
