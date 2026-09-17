//! WebSocket connection registry: maps user id to active connections, tracks app presence,
//! supports broadcast and stale-connection pruning.

mod metrics;
pub use metrics::WsMetrics;

use crate::dto::ws::{PresenceChangedPayload, PresenceUpdatePayload, ServerWsMessage};
use crate::services::activity_metrics::ActivityMetricsService;
use crate::services::presence::{record_presence_observation, PresenceObservationCause};
use crate::services::social;
use crate::state::DbPool;
use chrono::{NaiveDateTime, Utc};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AppPresenceState {
    Unknown = 0,
    Active = 1,
    Inactive = 2,
}

#[derive(Clone, Copy)]
pub struct PresenceTransitionLimits {
    pub window: Duration,
    pub per_connection: u32,
    pub per_uid: u32,
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
    /// This is only mutated under the registry state lane. Keeping it on the
    /// connection means reconnecting cannot reset another connection's budget.
    transition_limiter: std::sync::Mutex<TransitionLimiter>,
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

/// Sliding-window state-change limiter. It deliberately records only accepted
/// transitions: an over-limit frame closes the connection, so counting the
/// rejected frame cannot make the next connection's recovery less predictable.
#[derive(Debug)]
struct TransitionLimiter {
    changes: VecDeque<Instant>,
    last_used_at: Instant,
}

impl TransitionLimiter {
    fn new(now: Instant) -> Self {
        Self {
            changes: VecDeque::new(),
            last_used_at: now,
        }
    }

    fn permits(&mut self, now: Instant, window: Duration, limit: u32) -> bool {
        while self
            .changes
            .front()
            .is_some_and(|changed_at| now.duration_since(*changed_at) >= window)
        {
            self.changes.pop_front();
        }
        self.last_used_at = now;
        (self.changes.len() as u32) < limit
    }

    fn record(&mut self, now: Instant) {
        self.changes.push_back(now);
        self.last_used_at = now;
    }

    fn is_expired(&self, now: Instant, ttl: Duration) -> bool {
        now.duration_since(self.last_used_at) >= ttl
    }
}

#[derive(Debug)]
struct PresenceObservation {
    uid: i32,
    observed_at: NaiveDateTime,
    cause: PresenceObservationCause,
    published_online: Option<bool>,
}

#[derive(Clone)]
struct PresenceBroadcaster {
    connections: Arc<dashmap::DashMap<i32, Vec<Arc<ConnectionEntry>>>>,
    metrics: Arc<WsMetrics>,
    sequence: Arc<AtomicU64>,
    broadcast_lane: Arc<Mutex<()>>,
}

impl PresenceBroadcaster {
    async fn broadcast(
        &self,
        db: DbPool,
        uid: i32,
        online: bool,
        stored_last_seen_at: NaiveDateTime,
    ) {
        let recipients = tokio::task::spawn_blocking(move || {
            let mut conn = db.get().map_err(|error| error.to_string())?;
            social::presence_broadcast_recipients(&mut conn, uid).map_err(|error| error.to_string())
        })
        .await;
        let recipients = match recipients {
            Ok(Ok(recipients)) => recipients,
            Ok(Err(error)) => {
                tracing::error!(uid, %error, "presence recipient query failed; event suppressed");
                return;
            }
            Err(error) => {
                tracing::error!(
                    uid,
                    ?error,
                    "presence recipient query worker panicked; event suppressed"
                );
                return;
            }
        };
        if recipients.is_empty() {
            return;
        }

        self.broadcast_exact(
            recipients,
            uid,
            online,
            (!online).then_some(stored_last_seen_at),
        )
        .await;
    }

    async fn broadcast_exact(
        &self,
        recipients: Vec<i32>,
        uid: i32,
        online: bool,
        last_seen_at: Option<NaiveDateTime>,
    ) {
        self.broadcast_exact_with_delivery(recipients, uid, online, last_seen_at, false)
            .await;
    }

    /// Reconciliation revocations must not be silently lost: a connection
    /// either accepts the empty offline snapshot, or is evicted so its socket
    /// task closes instead of retaining stale presence client-side.
    async fn broadcast_revocation_exact(&self, recipients: Vec<i32>, uid: i32) {
        self.broadcast_exact_with_delivery(recipients, uid, false, None, true)
            .await;
    }

    async fn broadcast_exact_with_delivery(
        &self,
        recipients: Vec<i32>,
        uid: i32,
        online: bool,
        last_seen_at: Option<NaiveDateTime>,
        evict_on_failure: bool,
    ) {
        if recipients.is_empty() {
            return;
        }
        let _broadcast_lane = self.broadcast_lane.lock().await;
        let sequence = self
            .sequence
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let message = Arc::new(ServerWsMessage::PresenceChanged(PresenceChangedPayload {
            uid,
            online,
            last_seen_at: (!online)
                .then(|| {
                    last_seen_at
                        .map(|value| chrono::DateTime::<Utc>::from_naive_utc_and_offset(value, Utc))
                })
                .flatten(),
            changed_at: Utc::now(),
            sequence,
        }));
        let msg_type = message.message_type();
        for recipient in recipients {
            let mut failed_conn_ids = Vec::new();
            if let Some(entries) = self.connections.get(&recipient) {
                for entry in entries.iter() {
                    if entry.tx.try_send(message.clone()).is_err() {
                        if evict_on_failure {
                            failed_conn_ids.push(entry.conn_id);
                            tracing::warn!(
                                uid = recipient,
                                conn_id = entry.conn_id,
                                "ws presence revocation failed; evicting connection"
                            );
                        } else {
                            tracing::warn!(
                                uid = recipient,
                                conn_id = entry.conn_id,
                                "ws presence broadcast dropped"
                            );
                        }
                        self.metrics.record_message_dropped(msg_type);
                    } else {
                        self.metrics.record_message_pushed(msg_type);
                    }
                }
            }
            if evict_on_failure && !failed_conn_ids.is_empty() {
                self.evict_connections(recipient, &failed_conn_ids);
            }
        }
    }

    fn evict_connections(&self, uid: i32, conn_ids: &[u64]) {
        if let Some(mut entries) = self.connections.get_mut(&uid) {
            entries.retain(|entry| !conn_ids.contains(&entry.conn_id));
            if entries.is_empty() {
                drop(entries);
                self.connections.remove(&uid);
            }
        }
    }
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
        broadcaster: PresenceBroadcaster,
    ) -> Self {
        let (tx, mut rx) = mpsc::channel::<PresenceObservation>(queue_capacity);
        tokio::spawn(async move {
            while let Some(observation) = rx.recv().await {
                let db = db.clone();
                let activity_metrics = activity_metrics.clone();
                let persistence_db = db.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let mut conn = persistence_db.get().map_err(|error| error.to_string())?;
                    record_presence_observation(
                        &mut conn,
                        &activity_metrics,
                        observation.uid,
                        observation.observed_at,
                        observation.cause,
                    )
                    .map_err(|error| error.to_string())
                })
                .await;

                match result {
                    Ok(Ok(stored_last_seen_at)) => {
                        if let Some(online) = observation.published_online {
                            broadcaster
                                .broadcast(db, observation.uid, online, stored_last_seen_at)
                                .await;
                        }
                    }
                    Ok(Err(error)) => {
                        tracing::error!(%error, "presence observation persistence failed")
                    }
                    Err(error) => tracing::error!(?error, "presence observation worker panicked"),
                }
            }
        });
        Self { tx }
    }

    async fn enqueue(
        &self,
        uid: i32,
        observed_at: NaiveDateTime,
        cause: PresenceObservationCause,
        published_online: Option<bool>,
    ) {
        let observation = PresenceObservation {
            uid,
            observed_at,
            cause,
            published_online,
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

fn reconciled_presence_snapshot(
    visible: bool,
    online: bool,
    last_seen_at: Option<NaiveDateTime>,
) -> (bool, Option<NaiveDateTime>) {
    if visible {
        (online, last_seen_at)
    } else {
        (false, None)
    }
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
    presence_broadcaster: Option<PresenceBroadcaster>,
    disconnect_debounce: std::time::Duration,
    transition_window: Duration,
    per_connection_transition_limit: u32,
    per_uid_transition_limit: u32,
    /// This is intentionally independent of the physical connection map, so a
    /// disconnect/reconnect cannot bypass the uid-wide abuse budget.
    uid_transition_limiters: Arc<dashmap::DashMap<i32, TransitionLimiter>>,
    last_uid_limiter_cleanup_at: Arc<AtomicU64>,
}

impl ConnectionRegistry {
    pub fn new(metrics: Arc<WsMetrics>) -> Self {
        Self::with_disconnect_debounce(metrics, std::time::Duration::from_secs(45))
    }

    pub fn with_disconnect_debounce(
        metrics: Arc<WsMetrics>,
        disconnect_debounce: std::time::Duration,
    ) -> Self {
        Self::with_transition_rate_limits(
            metrics,
            disconnect_debounce,
            PresenceTransitionLimits {
                window: Duration::from_secs(10),
                per_connection: 12,
                per_uid: 20,
            },
        )
    }

    pub fn with_transition_rate_limits(
        metrics: Arc<WsMetrics>,
        disconnect_debounce: Duration,
        limits: PresenceTransitionLimits,
    ) -> Self {
        assert!(
            !limits.window.is_zero(),
            "transition window must be non-zero"
        );
        assert!(
            limits.per_connection > 0,
            "per-connection transition limit must be non-zero"
        );
        assert!(
            limits.per_uid > 0,
            "per-uid transition limit must be non-zero"
        );
        Self {
            inner: Arc::new(dashmap::DashMap::new()),
            published_presence: Arc::new(dashmap::DashMap::new()),
            metrics: metrics.clone(),
            state_lane: Arc::new(Mutex::new(())),
            persistence: None,
            presence_broadcaster: None,
            disconnect_debounce,
            transition_window: limits.window,
            per_connection_transition_limit: limits.per_connection,
            per_uid_transition_limit: limits.per_uid,
            uid_transition_limiters: Arc::new(dashmap::DashMap::new()),
            last_uid_limiter_cleanup_at: Arc::new(AtomicU64::new(now_secs())),
        }
    }

    pub fn with_presence_persistence(
        metrics: Arc<WsMetrics>,
        db: DbPool,
        activity_metrics: Arc<ActivityMetricsService>,
        queue_capacity: usize,
        disconnect_debounce: std::time::Duration,
        limits: PresenceTransitionLimits,
    ) -> Self {
        assert!(
            queue_capacity > 0,
            "presence persistence queue must be non-zero"
        );
        let inner = Arc::new(dashmap::DashMap::new());
        let presence_sequence = Arc::new(AtomicU64::new(0));
        let broadcaster = PresenceBroadcaster {
            connections: inner.clone(),
            metrics: metrics.clone(),
            sequence: presence_sequence,
            broadcast_lane: Arc::new(Mutex::new(())),
        };
        Self {
            inner: inner.clone(),
            published_presence: Arc::new(dashmap::DashMap::new()),
            metrics: metrics.clone(),
            state_lane: Arc::new(Mutex::new(())),
            persistence: Some(PresencePersistence::start(
                db,
                activity_metrics,
                queue_capacity,
                broadcaster.clone(),
            )),
            presence_broadcaster: Some(broadcaster),
            disconnect_debounce,
            transition_window: limits.window,
            per_connection_transition_limit: limits.per_connection,
            per_uid_transition_limit: limits.per_uid,
            uid_transition_limiters: Arc::new(dashmap::DashMap::new()),
            last_uid_limiter_cleanup_at: Arc::new(AtomicU64::new(now_secs())),
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
            transition_limiter: std::sync::Mutex::new(TransitionLimiter::new(Instant::now())),
        });
        self.inner.entry(uid).or_default().push(entry.clone());
        let transitioned_online =
            initial_state == AppPresenceState::Active && !self.is_published_online(uid);
        if initial_state == AppPresenceState::Active {
            self.cancel_disconnect_debounce(uid);
            self.set_published_online(uid, true);
        }
        self.metrics.record_connection_open();
        self.update_metrics();
        self.broadcast_presence_to_user(uid);
        if initial_state == AppPresenceState::Active {
            self.enqueue_observation_now(
                uid,
                PresenceObservationCause::ActiveCheckpoint,
                transitioned_online.then_some(true),
            )
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
        let changes_aggregate_state = changed_state
            && match app_state.expect("changed state is always present") {
                AppPresenceState::Active => !had_active_connection,
                AppPresenceState::Inactive | AppPresenceState::Unknown => {
                    previous_state == AppPresenceState::Active
                        && !self.has_other_active_connection(uid, conn_id)
                }
            };
        if changed_state
            && !self.permit_transition(entry, uid, changes_aggregate_state, Instant::now())
        {
            drop(entries);
            drop(_state_lane);
            tracing::warn!(
                uid,
                conn_id,
                "ws presence transition rate limit exceeded; closing connection"
            );
            self.metrics.record_presence_transition_rate_limited();
            self.remove_connection(uid, conn_id).await;
            self.metrics
                .record_presence_transition_rate_limit_eviction();
            return false;
        }
        if let Some(app_state) = app_state {
            entry.update_app_state(app_state);
        }
        drop(entries);
        self.update_metrics();

        if changed_state {
            let cause = match app_state.expect("changed state is always present") {
                AppPresenceState::Active => {
                    let transitioned_online = !self.is_published_online(uid);
                    self.cancel_disconnect_debounce(uid);
                    self.set_published_online(uid, true);
                    (
                        PresenceObservationCause::ActiveCheckpoint,
                        transitioned_online.then_some(true),
                    )
                }
                AppPresenceState::Inactive => {
                    let mut transitioned_offline = false;
                    if had_active_connection && !self.has_active_connection(uid) {
                        transitioned_offline = self.is_published_online(uid);
                        self.cancel_disconnect_debounce(uid);
                        self.set_published_online(uid, false);
                    }
                    (
                        PresenceObservationCause::ExplicitInactive,
                        transitioned_offline.then_some(false),
                    )
                }
                AppPresenceState::Unknown => return true,
            };
            self.enqueue_observation_now(uid, cause.0, cause.1).await;
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
                let transitioned_offline = self.is_published_online(uid);
                self.cancel_disconnect_debounce(uid);
                self.set_published_online(uid, false);
                self.enqueue_observation_now(
                    uid,
                    PresenceObservationCause::Prune,
                    transitioned_offline.then_some(false),
                )
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

    /// Reconcile a user's existing friend-presence snapshots after their
    /// visibility preference commits.  A revoked pair receives a deliberately
    /// empty offline snapshot in both directions; a newly visible pair receives
    /// the current published state.  The social query is fail-closed.
    pub async fn reconcile_visibility_change(
        &self,
        db: DbPool,
        uid: i32,
        change: social::PresenceVisibilityChange,
    ) {
        if change.previous == change.current {
            return;
        }
        let Some(broadcaster) = self.presence_broadcaster.clone() else {
            return;
        };
        let result = tokio::task::spawn_blocking(move || {
            let mut conn = db.get().map_err(|error| error.to_string())?;
            let own_last_seen_at =
                social::presence_last_seen_at(&mut conn, uid).map_err(|error| error.to_string())?;
            let peers = social::presence_visibility_reconciliation_peers(
                &mut conn,
                uid,
                change.previous,
                change.current,
            )
            .map_err(|error| error.to_string())?;
            Ok::<_, String>((own_last_seen_at, peers))
        })
        .await;
        let (own_last_seen_at, peers) = match result {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                tracing::error!(uid, %error, "presence visibility reconciliation query failed; events suppressed");
                return;
            }
            Err(error) => {
                tracing::error!(
                    uid,
                    ?error,
                    "presence visibility reconciliation worker panicked; events suppressed"
                );
                return;
            }
        };
        let mut observed_uids: Vec<i32> = peers.iter().map(|peer| peer.uid).collect();
        observed_uids.push(uid);
        let online = self.online_flags(&observed_uids);
        for peer in peers {
            match (peer.was_visible, peer.is_visible) {
                (true, false) => {
                    broadcaster
                        .broadcast_revocation_exact(vec![peer.uid], uid)
                        .await;
                    broadcaster
                        .broadcast_revocation_exact(vec![uid], peer.uid)
                        .await;
                }
                (false, true) => {
                    broadcaster
                        .broadcast_exact(
                            vec![peer.uid],
                            uid,
                            online.get(&uid).copied().unwrap_or(false),
                            own_last_seen_at,
                        )
                        .await;
                    broadcaster
                        .broadcast_exact(
                            vec![uid],
                            peer.uid,
                            online.get(&peer.uid).copied().unwrap_or(false),
                            peer.last_seen_at,
                        )
                        .await;
                }
                _ => {}
            }
        }
    }

    /// Reconcile the two directed presence snapshots affected by a friendship
    /// or block mutation. The relationship has already committed by the time
    /// this runs, so the current bilateral policy is authoritative. An
    /// ineligible direction gets an empty offline snapshot, which also safely
    /// revokes any presence that was sent before the mutation.
    pub async fn reconcile_social_presence_change(
        &self,
        db: DbPool,
        first_uid: i32,
        second_uid: i32,
    ) {
        if first_uid == second_uid {
            return;
        }
        let Some(broadcaster) = self.presence_broadcaster.clone() else {
            return;
        };
        let result = tokio::task::spawn_blocking(move || {
            let mut conn = db.get().map_err(|error| error.to_string())?;
            let first_for_second =
                social::visible_presence_records(&mut conn, second_uid, &[first_uid])
                    .map_err(|error| error.to_string())?
                    .remove(&first_uid)
                    .ok_or_else(|| "presence lookup omitted first user".to_owned())?;
            let second_for_first =
                social::visible_presence_records(&mut conn, first_uid, &[second_uid])
                    .map_err(|error| error.to_string())?
                    .remove(&second_uid)
                    .ok_or_else(|| "presence lookup omitted second user".to_owned())?;
            Ok::<_, String>((first_for_second, second_for_first))
        })
        .await;
        let (first_for_second, second_for_first) = match result {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                tracing::error!(first_uid, second_uid, %error, "social presence reconciliation query failed; events suppressed");
                return;
            }
            Err(error) => {
                tracing::error!(
                    first_uid,
                    second_uid,
                    ?error,
                    "social presence reconciliation worker panicked; events suppressed"
                );
                return;
            }
        };
        let online = self.online_flags(&[first_uid, second_uid]);
        let first_snapshot = reconciled_presence_snapshot(
            first_for_second.visible,
            online.get(&first_uid).copied().unwrap_or(false),
            first_for_second.last_seen_at,
        );
        let second_snapshot = reconciled_presence_snapshot(
            second_for_first.visible,
            online.get(&second_uid).copied().unwrap_or(false),
            second_for_first.last_seen_at,
        );
        if first_for_second.visible {
            broadcaster
                .broadcast_exact(
                    vec![second_uid],
                    first_uid,
                    first_snapshot.0,
                    first_snapshot.1,
                )
                .await;
        } else {
            broadcaster
                .broadcast_revocation_exact(vec![second_uid], first_uid)
                .await;
        }
        if second_for_first.visible {
            broadcaster
                .broadcast_exact(
                    vec![first_uid],
                    second_uid,
                    second_snapshot.0,
                    second_snapshot.1,
                )
                .await;
        } else {
            broadcaster
                .broadcast_revocation_exact(vec![first_uid], second_uid)
                .await;
        }
    }

    async fn enqueue_observation_now(
        &self,
        uid: i32,
        cause: PresenceObservationCause,
        published_online: Option<bool>,
    ) {
        self.enqueue_observation_at(uid, Utc::now().naive_utc(), cause, published_online)
            .await;
    }

    async fn enqueue_observation_at(
        &self,
        uid: i32,
        observed_at: NaiveDateTime,
        cause: PresenceObservationCause,
        published_online: Option<bool>,
    ) {
        if let Some(persistence) = &self.persistence {
            persistence
                .enqueue(uid, observed_at, cause, published_online)
                .await;
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
        let transitioned_offline = presence.online.load(Ordering::Relaxed);
        presence.online.store(false, Ordering::Relaxed);
        drop(presence);
        self.enqueue_observation_at(
            uid,
            candidate_time,
            PresenceObservationCause::Disconnect,
            transitioned_offline.then_some(false),
        )
        .await;
    }

    fn has_active_connection(&self, uid: i32) -> bool {
        self.inner.get(&uid).is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry.app_state() == AppPresenceState::Active)
        })
    }

    fn has_other_active_connection(&self, uid: i32, conn_id: u64) -> bool {
        self.inner.get(&uid).is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.conn_id != conn_id && entry.app_state() == AppPresenceState::Active
            })
        })
    }

    /// A connection is charged for every non-duplicate state input. The uid
    /// budget is charged only when that input changes the aggregate physical
    /// presence target, which bounds persistence/broadcast fan-out while
    /// allowing harmless multi-device state chatter.
    fn permit_transition(
        &self,
        entry: &ConnectionEntry,
        uid: i32,
        changes_aggregate_state: bool,
        now: Instant,
    ) -> bool {
        let mut connection_limiter = entry
            .transition_limiter
            .lock()
            .expect("connection transition limiter poisoned");
        if !connection_limiter.permits(
            now,
            self.transition_window,
            self.per_connection_transition_limit,
        ) {
            return false;
        }

        if changes_aggregate_state {
            self.maybe_cleanup_uid_transition_limiters(now);
            let mut uid_limiter = self
                .uid_transition_limiters
                .entry(uid)
                .or_insert_with(|| TransitionLimiter::new(now));
            if !uid_limiter.permits(now, self.transition_window, self.per_uid_transition_limit) {
                return false;
            }
            uid_limiter.record(now);
        }
        connection_limiter.record(now);
        true
    }

    fn maybe_cleanup_uid_transition_limiters(&self, now: Instant) {
        const UID_LIMITER_TTL_SECS: u64 = 60;
        let previous = self.last_uid_limiter_cleanup_at.load(Ordering::Relaxed);
        let current = now_secs();
        if current.saturating_sub(previous) < UID_LIMITER_TTL_SECS
            || self
                .last_uid_limiter_cleanup_at
                .compare_exchange(previous, current, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
        {
            return;
        }
        self.uid_transition_limiters.retain(|_, limiter| {
            !limiter.is_expired(now, Duration::from_secs(UID_LIMITER_TTL_SECS))
        });
    }

    fn is_published_online(&self, uid: i32) -> bool {
        self.published_presence
            .get(&uid)
            .is_some_and(|presence| presence.online.load(Ordering::Relaxed))
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

    fn rate_limited_registry(
        per_connection_transition_limit: u32,
        per_uid_transition_limit: u32,
    ) -> ConnectionRegistry {
        ConnectionRegistry::with_transition_rate_limits(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(45),
            PresenceTransitionLimits {
                window: Duration::from_secs(60),
                per_connection: per_connection_transition_limit,
                per_uid: per_uid_transition_limit,
            },
        )
    }

    fn broadcaster(registry: &ConnectionRegistry) -> PresenceBroadcaster {
        PresenceBroadcaster {
            connections: registry.inner.clone(),
            metrics: registry.metrics.clone(),
            sequence: Arc::new(AtomicU64::new(0)),
            broadcast_lane: Arc::new(Mutex::new(())),
        }
    }

    #[test]
    fn social_reconciliation_revokes_hidden_presence() {
        let last_seen_at = chrono::DateTime::from_timestamp(1_700_000_000, 0)
            .expect("valid timestamp")
            .naive_utc();

        assert_eq!(
            reconciled_presence_snapshot(false, true, Some(last_seen_at)),
            (false, None)
        );
        assert_eq!(
            reconciled_presence_snapshot(true, false, Some(last_seen_at)),
            (false, Some(last_seen_at))
        );
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

    #[tokio::test]
    async fn reconciliation_revocation_is_an_empty_offline_snapshot() {
        let registry = registry();
        let (_entry, mut rx) = registry.register(7, None).await;
        let broadcaster = broadcaster(&registry);

        broadcaster.broadcast_revocation_exact(vec![7], 9).await;

        let payload = loop {
            let Some(message) = rx.recv().await else {
                panic!("presence revocation was not delivered");
            };
            if let ServerWsMessage::PresenceChanged(payload) = message.as_ref() {
                break payload.clone();
            }
        };
        assert_eq!(payload.uid, 9);
        assert!(!payload.online);
        assert_eq!(payload.last_seen_at, None);
        assert_eq!(payload.sequence, 1);
    }

    #[tokio::test]
    async fn reconciliation_revocation_evicts_a_closed_connection() {
        let registry = registry();
        let (_entry, rx) = registry.register(7, None).await;
        drop(rx);

        broadcaster(&registry)
            .broadcast_revocation_exact(vec![7], 9)
            .await;

        assert!(!registry.inner.contains_key(&7));
    }

    #[tokio::test]
    async fn reconciliation_revocation_evicts_a_full_connection() {
        let registry = registry();
        let (entry, mut rx) = registry.register(7, None).await;
        let _ = rx.try_recv();
        let message = Arc::new(ServerWsMessage::PresenceUpdate(PresenceUpdatePayload {
            active_connections: 1,
        }));
        for _ in 0..256 {
            entry
                .tx
                .try_send(message.clone())
                .expect("channel has capacity");
        }

        broadcaster(&registry)
            .broadcast_revocation_exact(vec![7], 9)
            .await;

        assert!(!registry.inner.contains_key(&7));
    }

    #[tokio::test]
    async fn ordinary_presence_broadcast_keeps_a_full_connection() {
        let registry = registry();
        let (entry, mut rx) = registry.register(7, None).await;
        let _ = rx.try_recv();
        let message = Arc::new(ServerWsMessage::PresenceUpdate(PresenceUpdatePayload {
            active_connections: 1,
        }));
        for _ in 0..256 {
            entry
                .tx
                .try_send(message.clone())
                .expect("channel has capacity");
        }

        broadcaster(&registry)
            .broadcast_exact(vec![7], 9, false, None)
            .await;

        assert!(registry.inner.contains_key(&7));
    }

    #[tokio::test]
    async fn transition_limit_rejects_the_state_change_and_removes_the_connection() {
        let registry = rate_limited_registry(2, 10);
        let (entry, _rx) = registry.register(7, None).await;

        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Active))
                .await
        );
        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );
        assert!(
            !registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Active))
                .await
        );
        assert!(!registry.inner.contains_key(&7));
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&false));
    }

    #[tokio::test]
    async fn ping_state_changes_share_the_app_state_transition_limiter() {
        let registry = rate_limited_registry(2, 10);
        let (entry, _rx) = registry.register(7, None).await;

        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Active))
                .await
        );
        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );
        assert!(
            !registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Active))
                .await
        );
    }

    #[tokio::test]
    async fn uid_limit_survives_an_empty_connection_set_and_reconnect() {
        let registry = rate_limited_registry(10, 2);
        let (first, _rx) = registry.register(7, None).await;
        assert!(
            registry
                .heartbeat(7, first.conn_id(), Some(AppPresenceState::Active))
                .await
        );
        assert!(
            registry
                .heartbeat(7, first.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );
        registry.remove_connection(7, first.conn_id()).await;

        let (second, _rx) = registry.register(7, None).await;
        assert!(
            !registry
                .heartbeat(7, second.conn_id(), Some(AppPresenceState::Active))
                .await
        );
        assert!(!registry.inner.contains_key(&7));
    }
}
