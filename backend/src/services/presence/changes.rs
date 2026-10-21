use tokio::sync::broadcast;

/// A committed social/privacy change that may change a viewer's current snapshot.
#[derive(Debug, Clone, Copy)]
pub enum PresenceChange {
    UserPolicy(i32),
    PairPolicy(i32, i32),
}

impl PresenceChange {
    pub fn affects(self, viewer_uid: i32, user_ids: &[i32]) -> bool {
        if user_ids.is_empty() {
            return false;
        }
        match self {
            Self::UserPolicy(uid) => viewer_uid == uid || user_ids.contains(&uid),
            Self::PairPolicy(a, b) => {
                (viewer_uid == a && user_ids.contains(&b))
                    || (viewer_uid == b && user_ids.contains(&a))
            }
        }
    }
}

pub type PresenceChanges = broadcast::Receiver<PresenceChange>;

/// Coalesce pending changes; a lagged receiver must recheck its personal scope.
pub fn take_pending_changes(
    changes: &mut PresenceChanges,
    viewer_uid: i32,
    user_ids: &[i32],
) -> bool {
    let mut refresh = false;
    loop {
        match changes.try_recv() {
            Ok(change) => refresh |= change.affects(viewer_uid, user_ids),
            Err(broadcast::error::TryRecvError::Lagged(_)) => refresh |= !user_ids.is_empty(),
            Err(_) => return refresh,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_refresh_only_affected_viewers_and_scopes() {
        let global = PresenceChange::UserPolicy(7);
        assert!(global.affects(7, &[8])); // Reciprocity changes the owner's view too.
        assert!(global.affects(8, &[7]));
        assert!(!global.affects(8, &[9]));
        assert!(!global.affects(7, &[]));
        let pair = PresenceChange::PairPolicy(7, 8);
        assert!(pair.affects(7, &[8]));
        assert!(pair.affects(8, &[7]));
        assert!(!pair.affects(9, &[7, 8]));
        assert!(!pair.affects(7, &[9]));
        assert!(!pair.affects(7, &[]));
    }

    #[test]
    fn concurrent_changes_reach_each_device_and_invalidate_in_flight_results() {
        let (tx, mut first) = broadcast::channel(8);
        let mut second = tx.subscribe();
        assert!(!take_pending_changes(&mut first, 7, &[8]));
        // A snapshot is being loaded while the pair's privacy changes twice.
        tx.send(PresenceChange::PairPolicy(7, 8)).unwrap();
        tx.send(PresenceChange::PairPolicy(7, 8)).unwrap();
        assert!(take_pending_changes(&mut first, 7, &[8]));
        assert!(!take_pending_changes(&mut first, 7, &[8]));
        assert!(take_pending_changes(&mut second, 7, &[8]));
        tx.send(PresenceChange::PairPolicy(9, 10)).unwrap();
        assert!(!take_pending_changes(&mut first, 7, &[8]));
    }

    #[test]
    fn lagged_subscriptions_recheck_even_if_the_relevant_change_was_evicted() {
        let (tx, mut rx) = broadcast::channel(1);
        tx.send(PresenceChange::PairPolicy(7, 8)).unwrap();
        tx.send(PresenceChange::PairPolicy(9, 10)).unwrap();
        assert!(take_pending_changes(&mut rx, 7, &[8]));
        assert!(!take_pending_changes(&mut rx, 7, &[8]));
    }
}
