//! WebSocket connection registry: maps user id to active connections, tracks app presence,
//! supports broadcast and stale-connection pruning.

mod metrics;
pub use metrics::WsMetrics;

use crate::dto::ws::{PresenceUpdatePayload, ServerWsMessage};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

pub const STALE_CONNECTION_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AppPresenceState {
    Active = 1,
    Inactive = 2,
}

impl AppPresenceState {
    fn from_u8(value: u8) -> Self {
        match value {
            x if x == Self::Inactive as u8 => Self::Inactive,
            _ => Self::Active,
        }
    }
}

/// Per-connection state: sender to push messages to the socket task, last ping time for timeout.
#[derive(Debug)]
pub struct ConnectionEntry {
    pub conn_id: u64,
    pub client_id: String,
    pub tx: mpsc::Sender<Arc<ServerWsMessage>>,
    /// Sticky, coalescing invalidation independent of the lossy ordinary-event queue.
    pub unread_changed: Arc<tokio::sync::Notify>,
    /// Unix timestamp (seconds) when we last received a ping from the client.
    pub last_ping_at: AtomicU64,
    pub app_state: AtomicU8,
    pub last_state_at: AtomicU64,
}

impl ConnectionEntry {
    pub fn update_ping(&self, state: AppPresenceState) {
        let now = now_secs();
        self.last_ping_at.store(now, Ordering::Relaxed);
        self.app_state.store(state as u8, Ordering::Relaxed);
        self.last_state_at.store(now, Ordering::Relaxed);
    }

    pub fn update_app_state(&self, state: AppPresenceState) {
        let now = now_secs();
        self.last_ping_at.store(now, Ordering::Relaxed);
        self.app_state.store(state as u8, Ordering::Relaxed);
        self.last_state_at.store(now, Ordering::Relaxed);
    }

    pub fn app_state(&self) -> AppPresenceState {
        AppPresenceState::from_u8(self.app_state.load(Ordering::Relaxed))
    }
}

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(0);

fn next_conn_id() -> u64 {
    NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// A current connection snapshot for an authenticated user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineConnection {
    pub connection_id: u64,
    pub client_id: String,
    pub app_state: AppPresenceState,
}

/// Registry of active WebSocket connections per user id. Thread-safe; shared via Arc.
pub struct ConnectionRegistry {
    /// uid -> list of connection entries (multiple tabs/devices per user).
    inner: dashmap::DashMap<i32, Vec<Arc<ConnectionEntry>>>,
    metrics: Arc<WsMetrics>,
}

impl ConnectionRegistry {
    pub fn new(metrics: Arc<WsMetrics>) -> Self {
        Self {
            inner: dashmap::DashMap::new(),
            metrics,
        }
    }

    /// Register a new connection for the authenticated user and client. Returns the entry (to
    /// update last_ping_at) and the receiver for the send task. Caller must call
    /// `remove_connection(uid, conn_id)` when the socket closes.
    pub fn register(
        &self,
        uid: i32,
        client_id: String,
    ) -> (Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>) {
        let conn_id = next_conn_id();
        let (tx, rx) = mpsc::channel(256);
        let now = now_secs();
        let entry = Arc::new(ConnectionEntry {
            conn_id,
            client_id,
            tx,
            unread_changed: Arc::new(tokio::sync::Notify::new()),
            last_ping_at: AtomicU64::new(now),
            app_state: AtomicU8::new(AppPresenceState::Active as u8),
            last_state_at: AtomicU64::new(now),
        });
        self.inner.entry(uid).or_default().push(entry.clone());
        self.metrics.record_connection_open();
        self.update_metrics();
        self.broadcast_presence_to_user(uid);
        (entry, rx)
    }

    /// Remove a single connection. Call when the socket closes.
    pub fn remove_connection(&self, uid: i32, conn_id: u64) {
        if let dashmap::mapref::entry::Entry::Occupied(mut entry) = self.inner.entry(uid) {
            entry
                .get_mut()
                .retain(|connection| connection.conn_id != conn_id);
            if entry.get().is_empty() {
                entry.remove();
            }
        }
        self.update_metrics();
        self.broadcast_presence_to_user(uid);
    }

    /// Broadcast a JSON string to all connections for the given user ids. Each uid may have multiple connections.
    /// Failures to send (e.g. full buffer) are logged but do not remove the connection here.
    pub fn broadcast_to_uids(&self, uids: &[i32], message: Arc<ServerWsMessage>) {
        if matches!(
            &*message,
            ServerWsMessage::Message(_)
                | ServerWsMessage::MessageUpdated(_)
                | ServerWsMessage::MessageDeleted(_)
                | ServerWsMessage::MessagesBulkDeleted(_)
                | ServerWsMessage::ThreadUpdate(_)
                | ServerWsMessage::ThreadMembershipChanged(_)
                | ServerWsMessage::ChatArchiveStateChanged(_)
                | ServerWsMessage::FriendRequestResolved(_)
                | ServerWsMessage::FriendshipRemoved(_)
                | ServerWsMessage::Notification(_)
        ) {
            self.invalidate_unread(uids);
        }
        let msg_type = message.message_type();
        for &uid in uids {
            if let Some(vec) = self.inner.get(&uid) {
                for entry in vec.iter() {
                    if entry.tx.try_send(message.clone()).is_err() {
                        tracing::warn!(
                            uid,
                            conn_id = entry.conn_id,
                            "ws broadcast try_send full, message dropped"
                        );
                        self.metrics.record_message_dropped(msg_type);
                    } else {
                        self.metrics.record_message_pushed(msg_type);
                    }
                }
            }
        }
    }

    /// Call after committing read/mute/membership changes that have no ordinary WS event.
    pub fn invalidate_unread(&self, uids: &[i32]) {
        for uid in uids {
            if let Some(entries) = self.inner.get(uid) {
                for entry in entries.iter() {
                    entry.unread_changed.notify_one();
                }
            }
        }
    }

    /// Returns true when at least one fresh connection is actively viewing the app.
    pub fn should_suppress_push(&self, uid: i32, freshness_secs: u64) -> bool {
        let now = now_secs();
        self.inner.get(&uid).is_some_and(|vec| {
            vec.iter().any(|entry| {
                now.saturating_sub(entry.last_ping_at.load(Ordering::Relaxed)) <= freshness_secs
                    && entry.app_state() == AppPresenceState::Active
            })
        })
    }

    /// Returns whether at least one fresh, open connection exists for a user.
    ///
    /// This deliberately ignores application foreground/background state for connection liveness
    /// and group counts. Personal snapshots use `personal_presence` to distinguish away users.
    /// It allocates nothing and coalesces every tab/device into one boolean user status.
    pub fn is_online(&self, uid: i32) -> bool {
        self.is_online_at(uid, now_secs())
    }

    /// Aggregates personal presence across fresh connections; active wins over inactive.
    /// Group counts continue to include both states through `is_online`.
    pub fn personal_presence(&self, uid: i32) -> Option<AppPresenceState> {
        let now = now_secs();
        let entries = self.inner.get(&uid)?;
        let mut state = None;
        for entry in entries.iter().filter(|entry| {
            !entry.tx.is_closed()
                && now.saturating_sub(entry.last_ping_at.load(Ordering::Relaxed))
                    <= STALE_CONNECTION_TIMEOUT_SECS
        }) {
            match entry.app_state() {
                AppPresenceState::Active => return Some(AppPresenceState::Active),
                AppPresenceState::Inactive => state = Some(AppPresenceState::Inactive),
            }
        }
        state
    }

    /// Counts online users in a unique membership UID list using one liveness timestamp.
    pub fn count_online(&self, member_uids: &[i32]) -> u32 {
        let now = now_secs();
        member_uids
            .iter()
            .filter(|uid| self.is_online_at(**uid, now))
            .count() as u32
    }

    fn is_online_at(&self, uid: i32, now: u64) -> bool {
        self.inner.get(&uid).is_some_and(|entries| {
            entries.iter().any(|entry| {
                !entry.tx.is_closed()
                    && now.saturating_sub(entry.last_ping_at.load(Ordering::Relaxed))
                        <= STALE_CONNECTION_TIMEOUT_SECS
            })
        })
    }

    /// Return fresh, open connections for one user. The registry can hold multiple entries for
    /// the same client when that client has multiple browser tabs or devices connected.
    pub fn online_connections(&self, uid: i32) -> Vec<OnlineConnection> {
        let now = now_secs();
        self.inner
            .get(&uid)
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| {
                        !entry.tx.is_closed()
                            && now.saturating_sub(entry.last_ping_at.load(Ordering::Relaxed))
                                <= STALE_CONNECTION_TIMEOUT_SECS
                    })
                    .map(|entry| OnlineConnection {
                        connection_id: entry.conn_id,
                        client_id: entry.client_id.clone(),
                        app_state: entry.app_state(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Remove connections that have not sent a ping in more than `max_age` seconds.
    /// Call periodically (e.g. every 60s) from a background task.
    pub fn prune_stale(&self, max_age_secs: u64) {
        let now = now_secs();
        let mut uids_to_trim: Vec<(i32, Vec<u64>)> = Vec::new();
        for ref_entry in self.inner.iter() {
            let uid = *ref_entry.key();
            let stale: Vec<u64> = ref_entry
                .iter()
                .filter(|e| {
                    now.saturating_sub(e.last_ping_at.load(Ordering::Relaxed)) > max_age_secs
                })
                .map(|e| e.conn_id)
                .collect();
            if !stale.is_empty() {
                uids_to_trim.push((uid, stale));
            }
        }
        let mut pruned_uids: Vec<i32> = Vec::new();
        for (uid, conn_ids) in uids_to_trim {
            if let dashmap::mapref::entry::Entry::Occupied(mut entry) = self.inner.entry(uid) {
                entry
                    .get_mut()
                    .retain(|connection| !conn_ids.contains(&connection.conn_id));
                if entry.get().is_empty() {
                    entry.remove();
                }
            }
            pruned_uids.push(uid);
        }
        self.update_metrics();
        for uid in pruned_uids {
            self.broadcast_presence_to_user(uid);
        }
    }

    /// Notify all of a user's connections about the current connection count.
    pub fn broadcast_presence_to_user(&self, uid: i32) {
        if let Some(vec) = self.inner.get(&uid) {
            let count = vec.len() as u32;
            let msg = Arc::new(ServerWsMessage::PresenceUpdate(PresenceUpdatePayload {
                active_connections: count,
            }));
            for entry in vec.iter() {
                let _ = entry.tx.try_send(msg.clone());
            }
        }
    }

    pub fn refresh_metrics(&self) {
        self.update_metrics();
    }

    fn update_metrics(&self) {
        let mut active_connections = 0usize;
        let mut inactive_connections = 0usize;

        for ref_entry in self.inner.iter() {
            for entry in ref_entry.iter() {
                match entry.app_state() {
                    AppPresenceState::Active => active_connections += 1,
                    AppPresenceState::Inactive => inactive_connections += 1,
                }
            }
        }

        self.metrics.set_connected_users(self.inner.len());
        self.metrics
            .set_connection_states(active_connections, inactive_connections);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> ConnectionRegistry {
        ConnectionRegistry::new(Arc::new(WsMetrics::new(&prometheus::Registry::new())))
    }

    #[tokio::test]
    async fn unread_invalidation_survives_a_full_event_queue_and_reaches_every_device() {
        let registry = registry();
        let (first, _rx) = registry.register(7, "a".into());
        let (second, _rx2) = registry.register(7, "b".into());
        let event = Arc::new(ServerWsMessage::ThreadMembershipChanged(
            crate::dto::ws::ThreadMembershipChangedPayload {
                status: None,
                chat_id: 1,
                thread_root_id: 2,
            },
        ));
        while first.tx.try_send(event.clone()).is_ok() {}
        registry.broadcast_to_uids(&[7], event);
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            first.unread_changed.notified(),
        )
        .await
        .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            second.unread_changed.notified(),
        )
        .await
        .unwrap();
        registry.invalidate_unread(&[7]);
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            first.unread_changed.notified(),
        )
        .await
        .unwrap();
    }

    #[test]
    fn personal_presence_aggregates_active_and_away_without_changing_group_counts() {
        let registry = registry();
        let (away, _away_rx) = registry.register(7, "away".into());
        away.update_app_state(AppPresenceState::Inactive);
        assert_eq!(
            registry.personal_presence(7),
            Some(AppPresenceState::Inactive)
        );
        assert_eq!(registry.count_online(&[7]), 1);
        let (active, active_rx) = registry.register(7, "active".into());
        assert_eq!(
            registry.personal_presence(7),
            Some(AppPresenceState::Active)
        );
        assert_eq!(registry.count_online(&[7]), 1);
        active.last_ping_at.store(
            now_secs().saturating_sub(STALE_CONNECTION_TIMEOUT_SECS + 1),
            Ordering::Relaxed,
        );
        assert_eq!(
            registry.personal_presence(7),
            Some(AppPresenceState::Inactive)
        );
        active.update_ping(AppPresenceState::Active);
        drop(active_rx);
        assert_eq!(
            registry.personal_presence(7),
            Some(AppPresenceState::Inactive)
        );
        registry.remove_connection(7, away.conn_id);
        assert_eq!(registry.personal_presence(7), None);
        assert_eq!(registry.count_online(&[7]), 0);
    }

    #[test]
    fn suppresses_push_for_fresh_active_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client-a".to_string());
        entry.update_ping(AppPresenceState::Active);

        assert!(registry.should_suppress_push(7, 30));
    }

    #[test]
    fn does_not_suppress_push_for_inactive_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client-a".to_string());
        entry.update_app_state(AppPresenceState::Inactive);

        assert!(!registry.should_suppress_push(7, 30));
    }

    #[test]
    fn does_not_suppress_push_for_stale_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client-a".to_string());
        entry.update_ping(AppPresenceState::Active);
        entry
            .last_ping_at
            .store(now_secs().saturating_sub(31), Ordering::Relaxed);

        assert!(!registry.should_suppress_push(7, 30));
    }

    #[test]
    fn suppresses_push_when_any_connection_is_active() {
        let registry = registry();
        let (inactive_entry, _rx1) = registry.register(7, "client-a".to_string());
        inactive_entry.update_app_state(AppPresenceState::Inactive);
        let (active_entry, _rx2) = registry.register(7, "client-b".to_string());
        active_entry.update_ping(AppPresenceState::Active);

        assert!(registry.should_suppress_push(7, 30));
    }

    #[test]
    fn lists_only_fresh_open_connections_for_the_requested_user() {
        let registry = registry();
        let (first, first_rx) = registry.register(7, "client-a".to_string());
        let (second, _second_rx) = registry.register(7, "client-a".to_string());
        second.update_app_state(AppPresenceState::Inactive);
        let (other_user, _other_rx) = registry.register(8, "client-b".to_string());
        let (stale, _stale_rx) = registry.register(7, "client-c".to_string());
        stale.last_ping_at.store(
            now_secs().saturating_sub(STALE_CONNECTION_TIMEOUT_SECS + 1),
            Ordering::Relaxed,
        );
        let fresh_connections = registry.online_connections(7);
        assert_eq!(fresh_connections.len(), 2);
        assert_eq!(fresh_connections[0].client_id, "client-a");
        assert_eq!(fresh_connections[0].app_state, AppPresenceState::Active);
        assert_eq!(fresh_connections[1].client_id, "client-a");
        assert_eq!(fresh_connections[1].app_state, AppPresenceState::Inactive);

        drop(first_rx);

        let connections = registry.online_connections(7);

        assert_eq!(
            connections,
            vec![OnlineConnection {
                connection_id: second.conn_id,
                client_id: "client-a".to_string(),
                app_state: AppPresenceState::Inactive,
            }]
        );
        assert_ne!(first.conn_id, second.conn_id);
        assert_ne!(other_user.conn_id, second.conn_id);

        registry.remove_connection(7, second.conn_id);
        assert!(registry.online_connections(7).is_empty());
    }

    #[test]
    fn removing_one_device_preserves_another_fresh_device() {
        let registry = registry();
        let (closing, _closing_rx) = registry.register(7, "client-a".to_string());
        let (surviving, _surviving_rx) = registry.register(7, "client-b".to_string());

        registry.remove_connection(7, closing.conn_id);

        assert!(registry.is_online(7));
        assert_eq!(
            registry.online_connections(7),
            vec![OnlineConnection {
                connection_id: surviving.conn_id,
                client_id: "client-b".to_string(),
                app_state: AppPresenceState::Active,
            }]
        );
    }

    #[test]
    fn presence_is_online_for_a_fresh_background_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client-a".to_string());
        entry.update_app_state(AppPresenceState::Inactive);

        assert!(registry.is_online(7));
    }

    #[test]
    fn presence_is_online_when_any_device_is_fresh() {
        let registry = registry();
        let (stale, _stale_rx) = registry.register(7, "client-a".to_string());
        stale.last_ping_at.store(
            now_secs().saturating_sub(STALE_CONNECTION_TIMEOUT_SECS + 1),
            Ordering::Relaxed,
        );
        let (fresh, _fresh_rx) = registry.register(7, "client-b".to_string());
        fresh.update_ping(AppPresenceState::Inactive);

        assert!(registry.is_online(7));

        fresh.last_ping_at.store(
            now_secs().saturating_sub(STALE_CONNECTION_TIMEOUT_SECS + 1),
            Ordering::Relaxed,
        );
        assert!(!registry.is_online(7));
    }

    #[test]
    fn group_online_count_counts_users_not_devices_and_excludes_dead_connections() {
        let registry = registry();
        let (first, _first_rx) = registry.register(7, "first".into());
        let (second, second_rx) = registry.register(7, "second".into());
        second.update_app_state(AppPresenceState::Inactive);
        let (stale, _stale_rx) = registry.register(8, "stale".into());
        stale.last_ping_at.store(
            now_secs().saturating_sub(STALE_CONNECTION_TIMEOUT_SECS + 60),
            Ordering::Relaxed,
        );
        let (_closed, closed_rx) = registry.register(9, "closed".into());
        drop(closed_rx);

        assert_eq!(registry.count_online(&[7, 8, 9, 10]), 1);

        registry.remove_connection(7, first.conn_id);
        assert_eq!(registry.count_online(&[7, 8, 9, 10]), 1);

        drop(second_rx);
        assert_eq!(registry.count_online(&[7, 8, 9, 10]), 0);
    }
}
