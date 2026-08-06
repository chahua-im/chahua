//! WebSocket connection registry: maps user id to active connections, tracks app presence,
//! supports broadcast and stale-connection pruning.

mod metrics;
pub(crate) use metrics::WsMetrics;

use crate::dto::ws::{PresenceUpdatePayload, ServerWsMessage};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

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
    pub tx: mpsc::Sender<Arc<ServerWsMessage>>,
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

pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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

    /// Register a new connection for the given user. Returns the entry (to update last_ping_at)
    /// and the receiver for the send task. Caller must call `remove_connection(uid, conn_id)` when the socket closes.
    pub fn register(
        &self,
        uid: i32,
    ) -> (Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>) {
        let conn_id = next_conn_id();
        let (tx, rx) = mpsc::channel(256);
        let now = now_secs();
        let entry = Arc::new(ConnectionEntry {
            conn_id,
            tx,
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
        let mut empty = false;
        if let Some(mut vec) = self.inner.get_mut(&uid) {
            vec.retain(|e| e.conn_id != conn_id);
            empty = vec.is_empty();
        }
        if empty {
            self.inner.remove(&uid);
        }
        self.update_metrics();
        self.broadcast_presence_to_user(uid);
    }

    /// Broadcast a JSON string to all connections for the given user ids. Each uid may have multiple connections.
    /// Failures to send (e.g. full buffer) are logged but do not remove the connection here.
    pub fn broadcast_to_uids(&self, uids: &[i32], message: Arc<ServerWsMessage>) {
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
            if let Some(mut vec) = self.inner.get_mut(&uid) {
                vec.retain(|e| !conn_ids.contains(&e.conn_id));
                if vec.is_empty() {
                    drop(vec);
                    self.inner.remove(&uid);
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

    #[test]
    fn suppresses_push_for_fresh_active_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7);
        entry.update_ping(AppPresenceState::Active);

        assert!(registry.should_suppress_push(7, 30));
    }

    #[test]
    fn does_not_suppress_push_for_inactive_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7);
        entry.update_app_state(AppPresenceState::Inactive);

        assert!(!registry.should_suppress_push(7, 30));
    }

    #[test]
    fn does_not_suppress_push_for_stale_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7);
        entry.update_ping(AppPresenceState::Active);
        entry
            .last_ping_at
            .store(now_secs().saturating_sub(31), Ordering::Relaxed);

        assert!(!registry.should_suppress_push(7, 30));
    }

    #[test]
    fn suppresses_push_when_any_connection_is_active() {
        let registry = registry();
        let (inactive_entry, _rx1) = registry.register(7);
        inactive_entry.update_app_state(AppPresenceState::Inactive);
        let (active_entry, _rx2) = registry.register(7);
        active_entry.update_ping(AppPresenceState::Active);

        assert!(registry.should_suppress_push(7, 30));
    }
}
