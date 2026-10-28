//! Caller-owned friendship overrides. Both canonical halves use existing UID indexes.
use diesel::prelude::*;

use crate::dto::friends::PrivacyExceptionKind;
use crate::schema::friendships;

pub fn list(
    conn: &mut PgConnection,
    uid: i32,
    kind: PrivacyExceptionKind,
) -> QueryResult<Vec<(i32, bool)>> {
    macro_rules! rows {
        ($owner:ident, $peer:ident, $column:ident) => {
            friendships::table
                .filter(friendships::$owner.eq(uid))
                .filter(friendships::$column.is_not_null())
                .select((friendships::$peer, friendships::$column.assume_not_null()))
                .load::<(i32, bool)>(conn)?
        };
    }
    let (mut first, second) = match kind {
        PrivacyExceptionKind::Presence => (
            rows!(uid1, uid2, uid1_shares_presence),
            rows!(uid2, uid1, uid2_shares_presence),
        ),
        PrivacyExceptionKind::ReadReceipts => (
            rows!(uid1, uid2, uid1_shares_read_receipts),
            rows!(uid2, uid1, uid2_shares_read_receipts),
        ),
    };
    first.extend(second);
    first.sort_unstable_by_key(|(peer, _)| *peer);
    Ok(first)
}

pub fn count(conn: &mut PgConnection, uid: i32, kind: PrivacyExceptionKind) -> QueryResult<i64> {
    macro_rules! count {
        ($owner:ident, $column:ident) => {
            friendships::table
                .filter(friendships::$owner.eq(uid))
                .filter(friendships::$column.is_not_null())
                .count()
                .get_result::<i64>(conn)?
        };
    }
    Ok(match kind {
        PrivacyExceptionKind::Presence => {
            count!(uid1, uid1_shares_presence) + count!(uid2, uid2_shares_presence)
        }
        PrivacyExceptionKind::ReadReceipts => {
            count!(uid1, uid1_shares_read_receipts) + count!(uid2, uid2_shares_read_receipts)
        }
    })
}

/// Capture the affected peers with UPDATE RETURNING in the same transaction as the reset.
pub fn clear(
    conn: &mut PgConnection,
    uid: i32,
    kind: PrivacyExceptionKind,
) -> QueryResult<Vec<i32>> {
    conn.transaction(|conn| {
        macro_rules! clear {
            ($owner:ident, $peer:ident, $column:ident) => {
                diesel::update(
                    friendships::table
                        .filter(friendships::$owner.eq(uid))
                        .filter(friendships::$column.is_not_null()),
                )
                .set(friendships::$column.eq(None::<bool>))
                .returning(friendships::$peer)
                .get_results::<i32>(conn)?
            };
        }
        let (mut first, second) = match kind {
            PrivacyExceptionKind::Presence => (
                clear!(uid1, uid2, uid1_shares_presence),
                clear!(uid2, uid1, uid2_shares_presence),
            ),
            PrivacyExceptionKind::ReadReceipts => (
                clear!(uid1, uid2, uid1_shares_read_receipts),
                clear!(uid2, uid1, uid2_shares_read_receipts),
            ),
        };
        first.extend(second);
        first.sort_unstable();
        Ok(first)
    })
}

#[cfg(test)]
mod tests {
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
}
