//! WebSocket connection registry: maps user id to active connections, tracks app presence,
//! supports broadcast and stale-connection pruning.

mod metrics;
pub use metrics::WsMetrics;

use crate::dto::ws::{PresenceUpdatePayload, ServerWsMessage};
use crate::services::activity_metrics::ActivityMetricsService;
use crate::services::presence::{record_presence_observation, PresenceObservationCause};
use crate::state::DbPool;
use chrono::{NaiveDateTime, Utc};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AppPresenceState {
    Unknown = 0,
    Active = 1,
    Inactive = 2,
}

impl AppPresenceState {
    fn from_u8(value: u8) -> Self {
        match value {
            x if x == Self::Active as u8 => Self::Active,
            x if x == Self::Inactive as u8 => Self::Inactive,
            _ => Self::Unknown,
        }
    }
}

/// Per-connection state: sender to push messages to the socket task, last ping time for timeout.
#[derive(Debug)]
pub struct ConnectionEntry {
    conn_id: u64,
    tx: mpsc::Sender<Arc<ServerWsMessage>>,
    /// Unix timestamp (seconds) when we last received a ping from the client.
    last_ping_at: AtomicU64,
    app_state: AtomicU8,
    last_state_at: AtomicU64,
}

impl ConnectionEntry {
    pub fn conn_id(&self) -> u64 {
        self.conn_id
    }

    /// Refresh the connection heartbeat without changing its reported app state.
    fn update_ping(&self) {
        let now = now_secs();
        self.last_ping_at.store(now, Ordering::Relaxed);
    }

    fn update_app_state(&self, state: AppPresenceState) {
        let now = now_secs();
        self.last_ping_at.store(now, Ordering::Relaxed);
        self.app_state.store(state as u8, Ordering::Relaxed);
        self.last_state_at.store(now, Ordering::Relaxed);
    }

    fn app_state(&self) -> AppPresenceState {
        AppPresenceState::from_u8(self.app_state.load(Ordering::Relaxed))
    }
}

#[derive(Debug)]
struct PresenceObservation {
    uid: i32,
    observed_at: NaiveDateTime,
    cause: PresenceObservationCause,
}

/// State exposed to presence consumers. The generation invalidates an earlier
/// disconnect timer after the user becomes active again.
#[derive(Debug)]
struct PublishedPresence {
    online: AtomicBool,
    disconnect_generation: AtomicU64,
}

impl PublishedPresence {
    fn new(online: bool) -> Self {
        Self {
            online: AtomicBool::new(online),
            disconnect_generation: AtomicU64::new(0),
        }
    }
}

/// The persistence half of the coordinator. State commands enqueue observations
/// here, while Diesel work always runs outside the WebSocket task and state lock.
///
/// A later coordinator stage will add an acknowledgement command from this worker
/// back to the state lane before using observations to publish online/offline
/// transitions.
#[derive(Clone)]
struct PresencePersistence {
    tx: mpsc::Sender<PresenceObservation>,
}

impl PresencePersistence {
    fn start(
        db: DbPool,
        activity_metrics: Arc<ActivityMetricsService>,
        queue_capacity: usize,
    ) -> Self {
        let (tx, mut rx) = mpsc::channel::<PresenceObservation>(queue_capacity);
        tokio::spawn(async move {
            while let Some(observation) = rx.recv().await {
                let db = db.clone();
                let activity_metrics = activity_metrics.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let mut conn = db.get().map_err(|error| error.to_string())?;
                    record_presence_observation(
                        &mut conn,
                        &activity_metrics,
                        observation.uid,
                        observation.observed_at,
                        observation.cause,
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
                })
                .await;

                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        tracing::error!(%error, "presence observation persistence failed")
                    }
                    Err(error) => tracing::error!(?error, "presence observation worker panicked"),
                }
            }
        });
        Self { tx }
    }

    async fn enqueue(&self, uid: i32, observed_at: NaiveDateTime, cause: PresenceObservationCause) {
        let observation = PresenceObservation {
            uid,
            observed_at,
            cause,
        };
        if self.tx.send(observation).await.is_err() {
            tracing::error!(uid, "presence persistence worker stopped");
        }
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

/// Registry of active WebSocket connections per user id. Thread-safe; shared via Arc.
#[derive(Clone)]
pub struct ConnectionRegistry {
    /// uid -> list of connection entries (multiple tabs/devices per user).
    inner: Arc<dashmap::DashMap<i32, Vec<Arc<ConnectionEntry>>>>,
    /// Logical online state. Unlike the physical connection set, this remains
    /// online while a normal disconnect is in its reconnect grace period.
    published_presence: Arc<dashmap::DashMap<i32, Arc<PublishedPresence>>>,
    metrics: Arc<WsMetrics>,
    /// A single command lane for connection lifecycle and app-state mutations.
    /// Readers retain their lock-free DashMap access for broadcasts and push
    /// suppression, but cannot mutate a connection entry directly.
    state_lane: Arc<Mutex<()>>,
    persistence: Option<PresencePersistence>,
    disconnect_debounce: std::time::Duration,
}

impl ConnectionRegistry {
    pub fn new(metrics: Arc<WsMetrics>) -> Self {
        Self::with_disconnect_debounce(metrics, std::time::Duration::from_secs(45))
    }

    pub fn with_disconnect_debounce(
        metrics: Arc<WsMetrics>,
        disconnect_debounce: std::time::Duration,
    ) -> Self {
        Self {
            inner: Arc::new(dashmap::DashMap::new()),
            published_presence: Arc::new(dashmap::DashMap::new()),
            metrics,
            state_lane: Arc::new(Mutex::new(())),
            persistence: None,
            disconnect_debounce,
        }
    }

    pub fn with_presence_persistence(
        metrics: Arc<WsMetrics>,
        db: DbPool,
        activity_metrics: Arc<ActivityMetricsService>,
        queue_capacity: usize,
        disconnect_debounce: std::time::Duration,
    ) -> Self {
        assert!(
            queue_capacity > 0,
            "presence persistence queue must be non-zero"
        );
        Self {
            inner: Arc::new(dashmap::DashMap::new()),
            published_presence: Arc::new(dashmap::DashMap::new()),
            metrics,
            state_lane: Arc::new(Mutex::new(())),
            persistence: Some(PresencePersistence::start(
                db,
                activity_metrics,
                queue_capacity,
            )),
            disconnect_debounce,
        }
    }

    /// Register a new connection for the given user. Returns the entry (to update last_ping_at)
    /// and the receiver for the send task. Caller must call `remove_connection(uid, conn_id)` when the socket closes.
    pub async fn register(
        &self,
        uid: i32,
        initial_state: Option<AppPresenceState>,
    ) -> (Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>) {
        let _state_lane = self.state_lane.lock().await;
        let conn_id = next_conn_id();
        let (tx, rx) = mpsc::channel(256);
        let now = now_secs();
        let initial_state = initial_state.unwrap_or(AppPresenceState::Unknown);
        let entry = Arc::new(ConnectionEntry {
            conn_id,
            tx,
            last_ping_at: AtomicU64::new(now),
            app_state: AtomicU8::new(initial_state as u8),
            last_state_at: AtomicU64::new(now),
        });
        self.inner.entry(uid).or_default().push(entry.clone());
        if initial_state == AppPresenceState::Active {
            self.cancel_disconnect_debounce(uid);
            self.set_published_online(uid, true);
        }
        self.metrics.record_connection_open();
        self.update_metrics();
        self.broadcast_presence_to_user(uid);
        if initial_state == AppPresenceState::Active {
            self.enqueue_observation_now(uid, PresenceObservationCause::ActiveCheckpoint)
                .await;
        }
        (entry, rx)
    }

    /// Remove a single connection. Call when the socket closes.
    pub async fn remove_connection(&self, uid: i32, conn_id: u64) {
        let _state_lane = self.state_lane.lock().await;
        let mut empty = false;
        let mut removed_active = false;
        if let Some(mut vec) = self.inner.get_mut(&uid) {
            removed_active = vec
                .iter()
                .find(|entry| entry.conn_id == conn_id)
                .is_some_and(|entry| entry.app_state() == AppPresenceState::Active);
            vec.retain(|e| e.conn_id != conn_id);
            empty = vec.is_empty();
        }
        if empty {
            self.inner.remove(&uid);
        }
        let no_active_connections = !self.has_active_connection(uid);
        self.update_metrics();
        self.broadcast_presence_to_user(uid);
        if removed_active && no_active_connections {
            self.start_disconnect_debounce(uid, Utc::now().naive_utc());
        }
    }

    /// Record a valid heartbeat and, if supplied, apply its app state. The
    /// command is serialized with registration, disconnect and pruning.
    pub async fn heartbeat(
        &self,
        uid: i32,
        conn_id: u64,
        app_state: Option<AppPresenceState>,
    ) -> bool {
        let _state_lane = self.state_lane.lock().await;
        let Some(entries) = self.inner.get(&uid) else {
            return false;
        };
        let Some(entry) = entries.iter().find(|entry| entry.conn_id == conn_id) else {
            return false;
        };

        let had_active_connection = self.has_active_connection(uid);
        let previous_state = entry.app_state();
        entry.update_ping();
        let changed_state = app_state.is_some_and(|state| state != previous_state);
        if let Some(app_state) = app_state {
            entry.update_app_state(app_state);
        }
        drop(entries);
        self.update_metrics();

        if changed_state {
            let cause = match app_state.expect("changed state is always present") {
                AppPresenceState::Active => {
                    self.cancel_disconnect_debounce(uid);
                    self.set_published_online(uid, true);
                    PresenceObservationCause::ActiveCheckpoint
                }
                AppPresenceState::Inactive => {
                    if had_active_connection && !self.has_active_connection(uid) {
                        self.cancel_disconnect_debounce(uid);
                        self.set_published_online(uid, false);
                    }
                    PresenceObservationCause::ExplicitInactive
                }
                AppPresenceState::Unknown => return true,
            };
            self.enqueue_observation_now(uid, cause).await;
        }
        true
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
    pub async fn prune_stale(&self, max_age_secs: u64) {
        let _state_lane = self.state_lane.lock().await;
        let now = now_secs();
        let mut uids_to_trim: Vec<(i32, Vec<u64>, bool)> = Vec::new();
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
                let removed_active = ref_entry.iter().any(|entry| {
                    stale.contains(&entry.conn_id) && entry.app_state() == AppPresenceState::Active
                });
                uids_to_trim.push((uid, stale, removed_active));
            }
        }
        let mut pruned_uids: Vec<(i32, bool)> = Vec::new();
        for (uid, conn_ids, removed_active) in uids_to_trim {
            if let Some(mut vec) = self.inner.get_mut(&uid) {
                vec.retain(|e| !conn_ids.contains(&e.conn_id));
                if vec.is_empty() {
                    drop(vec);
                    self.inner.remove(&uid);
                }
            }
            pruned_uids.push((uid, removed_active));
        }
        self.update_metrics();
        for (uid, removed_active) in pruned_uids {
            self.broadcast_presence_to_user(uid);
            if removed_active && !self.has_active_connection(uid) {
                self.cancel_disconnect_debounce(uid);
                self.set_published_online(uid, false);
                self.enqueue_observation_now(uid, PresenceObservationCause::Prune)
                    .await;
            }
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

    /// Return the logical, externally visible online state for each requested
    /// user. A uid omitted from the registry has never been observed online.
    pub fn online_flags(&self, uids: &[i32]) -> HashMap<i32, bool> {
        uids.iter()
            .copied()
            .map(|uid| {
                let online = self
                    .published_presence
                    .get(&uid)
                    .is_some_and(|presence| presence.online.load(Ordering::Relaxed));
                (uid, online)
            })
            .collect()
    }

    async fn enqueue_observation_now(&self, uid: i32, cause: PresenceObservationCause) {
        self.enqueue_observation_at(uid, Utc::now().naive_utc(), cause)
            .await;
    }

    async fn enqueue_observation_at(
        &self,
        uid: i32,
        observed_at: NaiveDateTime,
        cause: PresenceObservationCause,
    ) {
        if let Some(persistence) = &self.persistence {
            persistence.enqueue(uid, observed_at, cause).await;
        }
    }

    fn presence_for(&self, uid: i32) -> Arc<PublishedPresence> {
        self.published_presence
            .entry(uid)
            .or_insert_with(|| Arc::new(PublishedPresence::new(false)))
            .clone()
    }

    fn set_published_online(&self, uid: i32, online: bool) {
        self.presence_for(uid)
            .online
            .store(online, Ordering::Relaxed);
    }

    fn cancel_disconnect_debounce(&self, uid: i32) {
        if let Some(presence) = self.published_presence.get(&uid) {
            presence
                .disconnect_generation
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    fn start_disconnect_debounce(&self, uid: i32, candidate_time: NaiveDateTime) {
        let presence = self.presence_for(uid);
        let generation = presence
            .disconnect_generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let registry = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(registry.disconnect_debounce).await;
            registry
                .finish_disconnect_debounce(uid, generation, candidate_time)
                .await;
        });
    }

    async fn finish_disconnect_debounce(
        &self,
        uid: i32,
        generation: u64,
        candidate_time: NaiveDateTime,
    ) {
        let _state_lane = self.state_lane.lock().await;
        let Some(presence) = self.published_presence.get(&uid) else {
            return;
        };
        if presence.disconnect_generation.load(Ordering::Relaxed) != generation
            || self.has_active_connection(uid)
        {
            return;
        }
        presence.online.store(false, Ordering::Relaxed);
        drop(presence);
        self.enqueue_observation_at(uid, candidate_time, PresenceObservationCause::Disconnect)
            .await;
    }

    fn has_active_connection(&self, uid: i32) -> bool {
        self.inner.get(&uid).is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry.app_state() == AppPresenceState::Active)
        })
    }

    fn update_metrics(&self) {
        let mut active_connections = 0usize;
        let mut inactive_connections = 0usize;

        for ref_entry in self.inner.iter() {
            for entry in ref_entry.iter() {
                match entry.app_state() {
                    AppPresenceState::Active => active_connections += 1,
                    AppPresenceState::Inactive => inactive_connections += 1,
                    AppPresenceState::Unknown => {}
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
    async fn suppresses_push_for_fresh_active_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        entry.update_ping();

        assert!(registry.should_suppress_push(7, 30));
    }

    #[tokio::test]
    async fn does_not_suppress_push_for_inactive_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, None).await;
        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );

        assert!(!registry.should_suppress_push(7, 30));
    }

    #[tokio::test]
    async fn does_not_suppress_push_for_stale_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        entry.update_ping();
        entry
            .last_ping_at
            .store(now_secs().saturating_sub(31), Ordering::Relaxed);

        assert!(!registry.should_suppress_push(7, 30));
    }

    #[tokio::test]
    async fn suppresses_push_when_any_connection_is_active() {
        let registry = registry();
        let (inactive_entry, _rx1) = registry.register(7, None).await;
        inactive_entry.update_app_state(AppPresenceState::Inactive);
        let (active_entry, _rx2) = registry.register(7, Some(AppPresenceState::Active)).await;
        active_entry.update_ping();

        assert!(registry.should_suppress_push(7, 30));
    }

    #[tokio::test]
    async fn connection_without_initial_state_is_unknown_and_does_not_suppress_push() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, None).await;

        assert_eq!(entry.app_state(), AppPresenceState::Unknown);
        assert!(!registry.should_suppress_push(7, 30));
    }

    #[tokio::test]
    async fn heartbeat_does_not_change_app_state() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Inactive)).await;

        assert!(registry.heartbeat(7, entry.conn_id(), None).await);

        assert_eq!(entry.app_state(), AppPresenceState::Inactive);
    }

    #[tokio::test]
    async fn online_flags_use_the_published_state() {
        let registry = registry();
        let (_entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;

        assert_eq!(
            registry.online_flags(&[7, 8]),
            HashMap::from([(7, true), (8, false)])
        );
    }

    #[tokio::test]
    async fn normal_disconnect_keeps_user_online_until_debounce_expires() {
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            std::time::Duration::from_millis(25),
        );
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;

        registry.remove_connection(7, entry.conn_id()).await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&false));
    }

    #[tokio::test]
    async fn active_reconnect_cancels_a_pending_disconnect_debounce() {
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            std::time::Duration::from_millis(25),
        );
        let (first, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;

        registry.remove_connection(7, first.conn_id()).await;
        let (_second, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));
    }
}
