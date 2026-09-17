//! WebSocket connection registry: maps user id to active connections, tracks app presence,
//! supports broadcast and stale-connection pruning.

mod metrics;
pub use metrics::WsMetrics;

use crate::dto::ws::{PresenceChangedPayload, PresenceUpdatePayload, ServerWsMessage};
use crate::errors::AppError;
use crate::services::activity_metrics::ActivityMetricsService;
use crate::services::presence::{record_presence_observation, PresenceObservationCause};
use crate::services::social;
use crate::state::DbPool;
use chrono::{NaiveDateTime, Utc};
use futures::stream::{FuturesUnordered, StreamExt};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::time::DelayQueue;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum AppPresenceState {
    Unknown = 0,
    Active = 1,
    Inactive = 2,
}

#[derive(Clone, Copy, Debug)]
struct HeartbeatSample {
    version: u64,
    received_at: Instant,
    observed_at: NaiveDateTime,
}

/// Capability exposed to the socket task. It can record one coherent
/// heartbeat sample, but cannot alter the app state, connection collection or
/// published presence.
#[derive(Clone, Debug)]
pub struct HeartbeatHandle {
    sample: Arc<StdMutex<HeartbeatSample>>,
}

impl HeartbeatHandle {
    fn new() -> Self {
        Self {
            sample: Arc::new(StdMutex::new(HeartbeatSample {
                version: 0,
                received_at: Instant::now(),
                observed_at: Utc::now().naive_utc(),
            })),
        }
    }

    pub fn record(&self) {
        let mut sample = self.sample.lock().expect("heartbeat sample lock poisoned");
        *sample = HeartbeatSample {
            version: sample.version.saturating_add(1),
            received_at: Instant::now(),
            observed_at: Utc::now().naive_utc(),
        };
    }

    fn sample(&self) -> HeartbeatSample {
        *self.sample.lock().expect("heartbeat sample lock poisoned")
    }

    #[cfg(test)]
    fn record_at(&self, received_at: Instant, observed_at: NaiveDateTime) {
        let mut sample = self.sample.lock().expect("heartbeat sample lock poisoned");
        *sample = HeartbeatSample {
            version: sample.version.saturating_add(1),
            received_at,
            observed_at,
        };
    }
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
    heartbeat: HeartbeatHandle,
    app_state: AtomicU8,
    /// Monotonic timestamp used only for the Unknown-state deadline.  Wall
    /// clock changes must never make a connection look newly unknown or stale.
    last_state_at: StdMutex<Instant>,
    unknown_generation: AtomicU64,
    long_lived_unknown_counted: AtomicBool,
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
        self.heartbeat.record();
    }

    fn update_app_state(&self, state: AppPresenceState) -> u64 {
        self.heartbeat.record();
        self.app_state.store(state as u8, Ordering::Relaxed);
        *self
            .last_state_at
            .lock()
            .expect("connection state timestamp lock poisoned") = Instant::now();
        self.unknown_generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1)
    }

    fn app_state(&self) -> AppPresenceState {
        AppPresenceState::from_u8(self.app_state.load(Ordering::Relaxed))
    }

    pub fn heartbeat_handle(&self) -> HeartbeatHandle {
        self.heartbeat.clone()
    }

    /// Invalidate pending Unknown-deadline timers and refund the long-lived
    /// Unknown gauge when a connection leaves the registry (explicit close,
    /// prune or revocation eviction). Returns true when a gauge refund was due.
    fn retire_unknown_accounting(&self) -> bool {
        self.unknown_generation.fetch_add(1, Ordering::Relaxed);
        self.long_lived_unknown_counted
            .swap(false, Ordering::Relaxed)
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

#[derive(Debug, Clone)]
struct PresenceObservation {
    operation_id: u64,
    attempt_id: u64,
    uid: i32,
    observed_at: NaiveDateTime,
    cause: PresenceObservationCause,
    published_online: Option<bool>,
}

/// The outcome of one specific persistence attempt.  Keeping both ids on the
/// acknowledgement makes it safe for the supervisor to ignore a late result
/// after a failed operation has been resubmitted. Successful acknowledgements
/// carry the completed operation's published target so the coordinator can
/// commit the transition it already matched.
#[derive(Debug)]
struct PresencePersistenceAck {
    operation_id: u64,
    attempt_id: u64,
    uid: i32,
    result: Result<NaiveDateTime, String>,
    /// Only set on success, copied from the completed operation.
    published_online: Option<bool>,
}

impl PresenceObservation {
    fn matches_ack(&self, ack: &PresencePersistenceAck) -> bool {
        self.operation_id == ack.operation_id
            && self.attempt_id == ack.attempt_id
            && self.uid == ack.uid
    }

    fn retry_delay(&self, max_retry_backoff: Duration) -> Duration {
        // The attempt id starts at one.  Cap before shifting so a pathological
        // long DB outage cannot overflow or turn retries into an hours-long
        // blackout.
        const BASE_DELAY: Duration = Duration::from_millis(100);
        let exponent = self.attempt_id.saturating_sub(2).min(6) as u32;
        BASE_DELAY
            .checked_mul(1_u32 << exponent)
            .unwrap_or(max_retry_backoff)
            .min(max_retry_backoff)
    }
}

#[derive(Clone)]
struct PresenceBroadcaster {
    /// Shared with the registry: connection lists live inside the per-uid
    /// presence slot (§6.1); delivery takes short shared guards.
    slots: Arc<dashmap::DashMap<i32, PresenceSlot>>,
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
        changed_at: chrono::DateTime<Utc>,
    ) {
        let audience = tokio::task::spawn_blocking(move || {
            let mut conn = db.get().map_err(|error| error.to_string())?;
            social::presence_broadcast_recipients(&mut conn, uid).map_err(|error| error.to_string())
        })
        .await;
        let audience = match audience {
            Ok(Ok(audience)) => audience,
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
        self.metrics.record_presence_broadcast_audience(
            audience.candidates,
            audience.candidates - audience.recipients.len(),
        );
        if audience.recipients.is_empty() {
            return;
        }

        self.broadcast_exact_with_delivery(
            audience.recipients,
            uid,
            online,
            (!online).then_some(stored_last_seen_at),
            changed_at,
            false,
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
        self.broadcast_exact_with_delivery(
            recipients,
            uid,
            online,
            last_seen_at,
            Utc::now(),
            false,
        )
        .await;
    }

    /// Reconciliation revocations must not be silently lost: a connection
    /// either accepts the empty offline snapshot, or is evicted so its socket
    /// task closes instead of retaining stale presence client-side.
    async fn broadcast_revocation_exact(&self, recipients: Vec<i32>, uid: i32) {
        self.broadcast_exact_with_delivery(recipients, uid, false, None, Utc::now(), true)
            .await;
    }

    async fn broadcast_exact_with_delivery(
        &self,
        recipients: Vec<i32>,
        uid: i32,
        online: bool,
        last_seen_at: Option<NaiveDateTime>,
        changed_at: chrono::DateTime<Utc>,
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
            changed_at,
            sequence,
        }));
        let msg_type = message.message_type();
        for recipient in recipients {
            let mut failed_conn_ids = Vec::new();
            if let Some(slot) = self.slots.get(&recipient) {
                let entries = &slot.connections;
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
            if evict_on_failure {
                self.metrics.record_presence_revocation_enqueued();
                if !failed_conn_ids.is_empty() {
                    self.metrics.record_presence_revocation_eviction();
                }
                self.evict_connections(recipient, &failed_conn_ids);
            }
        }
    }

    fn evict_connections(&self, uid: i32, conn_ids: &[u64]) {
        // Keep the occupied-entry guard through the empty check and removal.
        // Dropping a `get_mut` guard and then calling `remove` permits a
        // concurrent register to insert a new connection in between, which
        // would incorrectly evict that new connection too.
        if let dashmap::mapref::entry::Entry::Occupied(mut occupied) = self.slots.entry(uid) {
            let mut unknown_refunds = 0i64;
            occupied.get_mut().connections.retain(|entry| {
                if conn_ids.contains(&entry.conn_id) && entry.retire_unknown_accounting() {
                    unknown_refunds -= 1;
                }
                !conn_ids.contains(&entry.conn_id)
            });
            if unknown_refunds != 0 {
                self.metrics
                    .add_long_lived_unknown_connections(unknown_refunds);
            }
            {
                let slot = occupied.get();
                if slot.connections.is_empty()
                    && !slot.published_online
                    && !slot.debouncing
                    && slot.queued_online_target.is_none()
                {
                    occupied.remove();
                }
            }
        }
    }
}

/// The unified per-uid state slot (§6.1): every piece of a user's presence
/// state that the coordinator mutates lives in one entry of one map, so no
/// reader can observe half of a transition. Only the uid-wide transition
/// limiter is deliberately separate (§6.3: it must outlive empty slots), and
/// the operation queue lives with the persistence supervisor, which alone
/// touches it. Cross-task readers (push suppression, broadcast delivery)
/// take short shared guards on this map.
#[derive(Debug, Default)]
struct PresenceSlot {
    /// Connections for this uid (multiple tabs/devices per user).
    connections: Vec<Arc<ConnectionEntry>>,
    /// Per-slot operation id counter (§6.1). Ids only need to distinguish
    /// operations of one uid; the attempt id guards resubmission.
    next_operation_id: u64,
    /// The published (externally visible) online state. Unlike the physical
    /// connection set, this remains online while a normal disconnect is in
    /// its reconnect grace period.
    published_online: bool,
    /// True while a normal disconnect is awaiting its debounce deadline.
    debouncing: bool,
    /// The generation that invalidates an earlier disconnect timer after the
    /// user becomes active again.
    disconnect_generation: u64,
    /// The online target already promised by a queued observation and not yet
    /// committed (§6.3 tail-target rule).
    queued_online_target: Option<bool>,
    /// The instant the last checkpoint was enqueued, so many active
    /// connections cannot multiply the periodic observation rate.
    last_checkpoint_enqueued_at: Option<Instant>,
}

impl PresenceSlot {
    fn new(published_online: bool) -> Self {
        Self {
            published_online,
            ..PresenceSlot::default()
        }
    }
}

/// The persistence half of the coordinator. State commands enqueue observations
/// here, while Diesel work always runs outside the WebSocket task and state lock.
/// The worker owns the per-uid operation queues and returns acknowledgements to
/// the coordinator, which alone commits published state and broadcasts.
#[derive(Clone)]
struct PresencePersistence {
    tx: mpsc::Sender<PresenceObservation>,
    queued_operations: Arc<AtomicUsize>,
    metrics: Arc<WsMetrics>,
    supervisor: Arc<StdMutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Operations parked when the global persistence lane is full. The
    /// coordinator drains these back into the lane at every loop turn.
    spillway: Arc<dashmap::DashMap<i32, VecDeque<PresenceObservation>>>,
}

impl PresencePersistence {
    /// Do not let a database outage turn every accepted presence operation
    /// into a blocking-pool job. Per-uid ordering still permits unrelated
    /// users to make bounded progress.
    const MAX_CONCURRENT_ATTEMPTS: usize = 4;

    fn start(
        db: DbPool,
        activity_metrics: Arc<ActivityMetricsService>,
        queue_capacity: usize,
        operation_queue_capacity: usize,
        max_retry_backoff: Duration,
        ack_tx: mpsc::Sender<PresencePersistenceAck>,
        metrics: Arc<WsMetrics>,
    ) -> Self {
        let (tx, mut rx) = mpsc::channel::<PresenceObservation>(queue_capacity);
        let queued_operations = Arc::new(AtomicUsize::new(0));
        let supervisor_queue_depth = queued_operations.clone();
        let supervisor_metrics = metrics.clone();
        let supervisor = tokio::spawn(async move {
            Self::run_supervisor(
                &mut rx,
                db,
                activity_metrics,
                ack_tx,
                queue_capacity,
                operation_queue_capacity,
                max_retry_backoff,
                supervisor_queue_depth,
                supervisor_metrics,
            )
            .await;
        });
        Self {
            tx,
            queued_operations,
            metrics,
            supervisor: Arc::new(StdMutex::new(Some(supervisor))),
            spillway: Arc::new(dashmap::DashMap::new()),
        }
    }

    fn take_supervisor(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.supervisor
            .lock()
            .expect("presence persistence supervisor lock poisoned")
            .take()
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the supervisor receives independently owned runtime dependencies"
    )]
    async fn run_supervisor(
        rx: &mut mpsc::Receiver<PresenceObservation>,
        db: DbPool,
        activity_metrics: Arc<ActivityMetricsService>,
        ack_tx: mpsc::Sender<PresencePersistenceAck>,
        queue_capacity: usize,
        operation_queue_capacity: usize,
        max_retry_backoff: Duration,
        queue_depth: Arc<AtomicUsize>,
        metrics: Arc<WsMetrics>,
    ) {
        let mut queues: HashMap<i32, VecDeque<PresenceObservation>> = HashMap::new();
        let mut in_flight_uids = std::collections::HashSet::new();
        let mut attempts = FuturesUnordered::new();
        let mut input_open = true;
        let mut queued_operations = 0usize;

        loop {
            Self::start_ready_attempts(
                &mut queues,
                &mut in_flight_uids,
                &mut attempts,
                db.clone(),
                activity_metrics.clone(),
                max_retry_backoff,
            );

            if !input_open && attempts.is_empty() {
                return;
            }

            tokio::select! {
                operation = rx.recv(), if input_open && queued_operations < queue_capacity => match operation {
                    Some(operation) => {
                        let queue = queues.entry(operation.uid).or_default();
                        // Checkpoints carry no externally published transition.
                        // When persistence is behind, retaining only the newest
                        // unstarted checkpoint preserves the monotonic DB fact
                        // while bounding redundant work for an active uid.
                        if operation.cause == PresenceObservationCause::ActiveCheckpoint
                            && queue
                                .iter_mut()
                                .skip(usize::from(in_flight_uids.contains(&operation.uid)))
                                .rev()
                                .find(|queued| {
                                    queued.cause == PresenceObservationCause::ActiveCheckpoint
                                        && queued.published_online.is_none()
                                })
                                .is_some_and(|queued| {
                                    queued.observed_at = operation.observed_at;
                                    true
                                })
                        {
                            metrics.record_presence_checkpoint_coalesced();
                            continue;
                        }
                        if queue.len() >= operation_queue_capacity {
                            // The queue head is the one authoritative operation
                            // already selected for persistence. Under a DB
                            // outage, discard only redundant checkpoints first.
                            let before = queue.len();
                            let mut retained = VecDeque::with_capacity(before);
                            for (index, queued) in queue.drain(..).enumerate() {
                                if index == 0
                                    || queued.cause != PresenceObservationCause::ActiveCheckpoint
                                {
                                    retained.push_back(queued);
                                }
                            }
                            *queue = retained;
                            let dropped = before.saturating_sub(queue.len());
                            if dropped > 0 {
                                metrics
                                    .record_presence_checkpoint_coalesced();
                                metrics.record_presence_degradation();
                            }
                            queued_operations = queued_operations.saturating_sub(dropped);
                            queue_depth.fetch_sub(dropped, Ordering::Relaxed);
                        }
                        if queue.len() >= operation_queue_capacity {
                            if operation.published_online.is_none() {
                                tracing::warn!(uid = operation.uid, "presence checkpoint dropped while operation queue is saturated");
                                metrics.record_presence_degradation();
                                continue;
                            }
                            // Explicit transitions are normally never merged.
                            // During sustained persistence failure, retaining the
                            // head and the latest target is the shortest safe
                            // sequence to converge to the current physical state.
                            let head = queue.pop_front().expect("non-empty saturated queue");
                            let dropped = queue.len();
                            if dropped > 0 {
                                metrics.record_presence_degradation();
                            }
                            queue.clear();
                            queue.push_back(head);
                            queued_operations = queued_operations.saturating_sub(dropped);
                            queue_depth.fetch_sub(dropped, Ordering::Relaxed);
                        }
                        metrics.record_presence_observation_submitted(
                            operation.cause.metric_label(),
                        );
                        queue.push_back(operation);
                        queued_operations += 1;
                        metrics.set_presence_persistence_queue_depth(
                            queue_depth.load(Ordering::Relaxed),
                        );
                        let total: usize = queues.values().map(VecDeque::len).sum();
                        metrics.set_presence_operation_queue_depth(total);
                    }
                    None => input_open = false,
                },
                Some(ack) = attempts.next(), if !attempts.is_empty() => {
                    let Some(queue) = queues.get_mut(&ack.uid) else {
                        tracing::warn!(uid = ack.uid, operation_id = ack.operation_id, attempt_id = ack.attempt_id, "presence persistence acknowledgement has no operation queue");
                        continue;
                    };
                    let Some(head) = queue.front_mut() else {
                        tracing::warn!(uid = ack.uid, operation_id = ack.operation_id, attempt_id = ack.attempt_id, "presence persistence acknowledgement has an empty operation queue");
                        continue;
                    };
                    if !head.matches_ack(&ack) {
                        tracing::warn!(uid = ack.uid, operation_id = ack.operation_id, attempt_id = ack.attempt_id, "stale presence persistence acknowledgement ignored");
                        continue;
                    }
                    in_flight_uids.remove(&ack.uid);
                    match ack.result {
                        Ok(stored_last_seen_at) => {
                            let completed = queue.pop_front().expect("matching presence operation queue head");
                            queued_operations = queued_operations.saturating_sub(1);
                            queue_depth.fetch_sub(1, Ordering::Relaxed);
                            metrics.set_presence_persistence_queue_depth(
                                queue_depth.load(Ordering::Relaxed),
                            );
                            metrics.record_presence_persistence_success();
                            let total_after_pop: usize = queue.len();
                            if total_after_pop == 0 {
                                queues.remove(&ack.uid);
                            }
                            let total: usize = queues.values().map(VecDeque::len).sum();
                            metrics.set_presence_operation_queue_depth(
                                total + total_after_pop,
                            );
                            // The coordinator alone commits published state and
                            // broadcasts: a bounded ack channel cannot drop a
                            // completed operation, and a dead coordinator means
                            // the process is being torn down anyway.
                            if ack_tx
                                .send(PresencePersistenceAck {
                                    operation_id: ack.operation_id,
                                    attempt_id: ack.attempt_id,
                                    uid: ack.uid,
                                    result: Ok(stored_last_seen_at),
                                    published_online: completed.published_online,
                                })
                                .await
                                .is_err()
                            {
                                tracing::error!(uid = ack.uid, operation_id = ack.operation_id, "presence coordinator stopped; dropping success acknowledgement");
                            }
                        }
                        Err(error) => {
                            tracing::error!(uid = ack.uid, operation_id = ack.operation_id, attempt_id = ack.attempt_id, %error, "presence observation persistence failed; retrying");
                            head.attempt_id = head.attempt_id.saturating_add(1);
                            metrics.record_presence_persistence_failure();
                            metrics.record_presence_persistence_retry();
                        }
                    }
                }
            }
        }
    }

    fn start_ready_attempts(
        queues: &mut HashMap<i32, VecDeque<PresenceObservation>>,
        in_flight_uids: &mut std::collections::HashSet<i32>,
        attempts: &mut FuturesUnordered<
            std::pin::Pin<Box<dyn std::future::Future<Output = PresencePersistenceAck> + Send>>,
        >,
        db: DbPool,
        activity_metrics: Arc<ActivityMetricsService>,
        max_retry_backoff: Duration,
    ) {
        for (&uid, queue) in queues.iter() {
            if in_flight_uids.contains(&uid)
                || in_flight_uids.len() >= Self::MAX_CONCURRENT_ATTEMPTS
            {
                continue;
            }
            let Some(observation) = queue.front().cloned() else {
                continue;
            };
            in_flight_uids.insert(uid);
            attempts.push(Box::pin(Self::run_attempt(
                observation,
                db.clone(),
                activity_metrics.clone(),
                max_retry_backoff,
            )));
        }
    }

    async fn run_attempt(
        observation: PresenceObservation,
        db: DbPool,
        activity_metrics: Arc<ActivityMetricsService>,
        max_retry_backoff: Duration,
    ) -> PresencePersistenceAck {
        let retry_delay = observation.retry_delay(max_retry_backoff);
        if !retry_delay.is_zero() && observation.attempt_id > 1 {
            tokio::time::sleep(retry_delay).await;
        }
        let persistence_observation = observation.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut conn = db.get().map_err(|error| error.to_string())?;
            record_presence_observation(
                &mut conn,
                &activity_metrics,
                persistence_observation.uid,
                persistence_observation.observed_at,
                persistence_observation.cause,
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("presence observation worker failed: {error}"))
        .and_then(std::convert::identity);
        PresencePersistenceAck {
            operation_id: observation.operation_id,
            attempt_id: observation.attempt_id,
            uid: observation.uid,
            result,
            published_online: observation.published_online,
        }
    }

    /// Hands an operation to the persistence supervisor. Never waits for
    /// channel capacity: a full input lane means the supervisor's per-uid
    /// degradation path will decide what survives, and the coordinator loop
    /// must keep serving every other uid (§6.2). The operation is parked in a
    /// bounded spillway and retried by the coordinator; nothing is dropped
    /// here.
    fn enqueue(
        &self,
        uid: i32,
        operation_id: u64,
        observed_at: NaiveDateTime,
        cause: PresenceObservationCause,
        published_online: Option<bool>,
    ) -> Option<PresenceObservation> {
        let observation = PresenceObservation {
            operation_id,
            attempt_id: 1,
            uid,
            observed_at,
            cause,
            published_online,
        };
        self.queued_operations.fetch_add(1, Ordering::Relaxed);
        self.metrics_queue_depth();
        if self.tx.try_send(observation.clone()).is_ok() {
            return None;
        }
        self.queued_operations.fetch_sub(1, Ordering::Relaxed);
        self.metrics_queue_depth();
        Some(observation)
    }

    fn metrics_queue_depth(&self) {
        // The supervisor counts operations from receipt until success. This
        // atomic also includes items still waiting in the bounded input lane.
        // It therefore reflects every observation not yet durably acknowledged.
        self.metrics
            .set_presence_persistence_queue_depth(self.queued_operations.load(Ordering::Relaxed));
    }
}

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(0);

fn next_conn_id() -> u64 {
    NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed)
}

/// Read a connection's current app state through a fresh map lookup. Used
/// after the borrowed entry guard is dropped, before the state lane is
/// released, so the observed state cannot race with the same lane.
fn entry_snapshot_state(
    slots: &dashmap::DashMap<i32, PresenceSlot>,
    uid: i32,
    conn_id: u64,
) -> AppPresenceState {
    slots
        .get(&uid)
        .and_then(|slot| {
            slot.connections
                .iter()
                .find(|entry| entry.conn_id == conn_id)
                .map(|entry| entry.app_state())
        })
        .unwrap_or(AppPresenceState::Unknown)
}

enum CoordinatorCommand {
    Register {
        uid: i32,
        initial_state: Option<AppPresenceState>,
        reply: oneshot::Sender<(Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>)>,
    },
    Remove {
        uid: i32,
        conn_id: u64,
        reply: oneshot::Sender<()>,
    },
    Heartbeat {
        uid: i32,
        conn_id: u64,
        app_state: Option<AppPresenceState>,
        reply: oneshot::Sender<bool>,
    },
    Prune {
        max_age_secs: u64,
        reply: oneshot::Sender<()>,
    },
    ReconcileSocialFacts {
        facts: social::PresencePairReconciliation,
    },
    ReconcileVisibilityFacts {
        facts: social::PresenceVisibilityReconciliation,
    },
}

pub struct ReconciliationPermit {
    permit: mpsc::OwnedPermit<CoordinatorCommand>,
}

impl std::fmt::Debug for ReconciliationPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReconciliationPermit").finish()
    }
}

impl ReconciliationPermit {
    pub fn send_social(self, facts: social::PresencePairReconciliation) {
        self.permit
            .send(CoordinatorCommand::ReconcileSocialFacts { facts });
    }

    pub fn send_visibility(self, facts: social::PresenceVisibilityReconciliation) {
        self.permit
            .send(CoordinatorCommand::ReconcileVisibilityFacts { facts });
    }
}

#[derive(Clone, Copy)]
enum CoordinatorTimer {
    Disconnect {
        uid: i32,
        generation: u64,
        candidate_time: NaiveDateTime,
    },
    UnknownDeadline {
        uid: i32,
        conn_id: u64,
        generation: u64,
    },
}

/// Registry of active WebSocket connections per user id. Thread-safe; shared via Arc.
#[derive(Clone)]
pub struct ConnectionRegistry {
    /// The per-uid presence state slot (§6.1): published online state,
    /// debounce state, the queued online target and the checkpoint reference
    /// live in one entry so a transition cannot be observed half-applied.
    slots: Arc<dashmap::DashMap<i32, PresenceSlot>>,
    metrics: Arc<WsMetrics>,
    /// Per-uid command lanes serialize lifecycle and state transitions for one
    /// user without making an unrelated user's heartbeat wait behind it.
    state_lanes: Arc<dashmap::DashMap<i32, Arc<Mutex<()>>>>,
    persistence: Option<PresencePersistence>,
    /// Set when persistence is configured; the coordinator uses it to query
    /// broadcast recipients after committing a persisted operation.
    db: Option<DbPool>,
    presence_broadcaster: Option<PresenceBroadcaster>,
    disconnect_debounce: std::time::Duration,
    transition_window: Duration,
    per_connection_transition_limit: u32,
    per_uid_transition_limit: u32,
    unknown_connection_threshold: Duration,
    checkpoint_interval: Duration,

    /// This is intentionally independent of the physical connection map, so a
    /// disconnect/reconnect cannot bypass the uid-wide abuse budget.
    uid_transition_limiters: Arc<dashmap::DashMap<i32, TransitionLimiter>>,
    last_uid_limiter_cleanup_at: Arc<StdMutex<Instant>>,
    command_tx: mpsc::Sender<CoordinatorCommand>,
    coordinator_supervisor: Arc<StdMutex<Option<tokio::task::JoinHandle<()>>>>,
    prune_interval: Duration,
    stale_timeout: Duration,
    /// Incremental gauge totals. Only coordinator commands mutate connection
    /// state and debounce/published transitions (revocation eviction refunds
    /// the unknown gauge through the shared metrics handle), so the totals stay
    /// consistent without a full registry rescan per command.
    connected_users_total: Arc<AtomicUsize>,
    active_connections_total: Arc<AtomicUsize>,
    inactive_connections_total: Arc<AtomicUsize>,
    physical_online_users_total: Arc<AtomicUsize>,
}

/// Snapshot of the registry-derived presence gauges, recomputed from scratch.
/// Used by the low-frequency drift audit, not by per-command accounting.
struct GaugeSnapshot {
    connected_users: usize,
    active_connections: usize,
    inactive_connections: usize,
    long_lived_unknown_connections: usize,
    physical_online_users: usize,
    published_online_users: usize,
    debouncing_users: usize,
}

impl ConnectionRegistry {
    /// Hard bound on parked operations per uid while the global persistence
    /// lane is saturated (§11).
    const PARKED_OPERATIONS_PER_UID: usize = 4;

    fn state_lane_for(&self, uid: i32) -> Arc<Mutex<()>> {
        self.state_lanes
            .entry(uid)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

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
        let (command_tx, _) = mpsc::channel(1);
        let slots = Arc::new(dashmap::DashMap::new());
        let broadcaster = PresenceBroadcaster {
            slots: slots.clone(),
            metrics: metrics.clone(),
            sequence: Arc::new(AtomicU64::new(0)),
            broadcast_lane: Arc::new(Mutex::new(())),
        };
        Self::build(
            Self {
                slots,
                metrics: metrics.clone(),
                state_lanes: Arc::new(dashmap::DashMap::new()),
                persistence: None,
                db: None,
                presence_broadcaster: Some(broadcaster),
                disconnect_debounce,
                transition_window: limits.window,
                per_connection_transition_limit: limits.per_connection,
                per_uid_transition_limit: limits.per_uid,
                unknown_connection_threshold: Duration::from_secs(60),
                checkpoint_interval: Duration::from_secs(5 * 60),
                uid_transition_limiters: Arc::new(dashmap::DashMap::new()),
                last_uid_limiter_cleanup_at: Arc::new(StdMutex::new(Instant::now())),
                command_tx,
                coordinator_supervisor: Arc::new(StdMutex::new(None)),
                prune_interval: Duration::from_secs(60),
                stale_timeout: Duration::from_secs(90),
                connected_users_total: Arc::new(AtomicUsize::new(0)),
                active_connections_total: Arc::new(AtomicUsize::new(0)),
                inactive_connections_total: Arc::new(AtomicUsize::new(0)),
                physical_online_users_total: Arc::new(AtomicUsize::new(0)),
            },
            4096,
            None,
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "startup wires the independently configured presence dependencies"
    )]
    pub fn with_presence_persistence(
        metrics: Arc<WsMetrics>,
        db: DbPool,
        activity_metrics: Arc<ActivityMetricsService>,
        queue_capacity: usize,
        disconnect_debounce: std::time::Duration,
        limits: PresenceTransitionLimits,
        unknown_connection_threshold: Duration,
        checkpoint_interval: Duration,
        operation_queue_capacity: usize,
        max_retry_backoff: Duration,
        command_queue_capacity: usize,
        prune_interval: Duration,
        stale_timeout: Duration,
    ) -> Self {
        assert!(
            queue_capacity > 0,
            "presence persistence queue must be non-zero"
        );
        assert!(
            !unknown_connection_threshold.is_zero(),
            "unknown connection threshold must be non-zero"
        );
        assert!(
            !checkpoint_interval.is_zero(),
            "checkpoint interval must be non-zero"
        );
        assert!(
            !max_retry_backoff.is_zero(),
            "retry backoff must be non-zero"
        );
        assert!(
            operation_queue_capacity > 0,
            "operation queue capacity must be non-zero"
        );
        let slots = Arc::new(dashmap::DashMap::new());
        let presence_sequence = Arc::new(AtomicU64::new(0));
        let broadcaster = PresenceBroadcaster {
            slots: slots.clone(),
            metrics: metrics.clone(),
            sequence: presence_sequence,
            broadcast_lane: Arc::new(Mutex::new(())),
        };
        let (command_tx, _) = mpsc::channel(1);
        // Success acknowledgements flow back to the coordinator, which alone
        // commits published state and broadcasts. Capacity bounds the
        // outstanding completed operations; senders only await after the DB
        // work is done, so this never blocks the state lane.
        let (ack_tx, ack_rx) = mpsc::channel::<PresencePersistenceAck>(queue_capacity);
        Self::build(
            Self {
                slots,
                metrics: metrics.clone(),
                state_lanes: Arc::new(dashmap::DashMap::new()),
                persistence: Some(PresencePersistence::start(
                    db.clone(),
                    activity_metrics,
                    queue_capacity,
                    operation_queue_capacity,
                    max_retry_backoff,
                    ack_tx,
                    metrics.clone(),
                )),
                db: Some(db.clone()),
                presence_broadcaster: Some(broadcaster),
                disconnect_debounce,
                transition_window: limits.window,
                per_connection_transition_limit: limits.per_connection,
                per_uid_transition_limit: limits.per_uid,
                unknown_connection_threshold,
                checkpoint_interval,
                uid_transition_limiters: Arc::new(dashmap::DashMap::new()),
                last_uid_limiter_cleanup_at: Arc::new(StdMutex::new(Instant::now())),
                command_tx,
                coordinator_supervisor: Arc::new(StdMutex::new(None)),
                prune_interval,
                stale_timeout,
                connected_users_total: Arc::new(AtomicUsize::new(0)),
                active_connections_total: Arc::new(AtomicUsize::new(0)),
                inactive_connections_total: Arc::new(AtomicUsize::new(0)),
                physical_online_users_total: Arc::new(AtomicUsize::new(0)),
            },
            command_queue_capacity,
            Some(ack_rx),
        )
    }

    fn build(
        mut registry: Self,
        command_queue_capacity: usize,
        ack_rx: Option<mpsc::Receiver<PresencePersistenceAck>>,
    ) -> Self {
        assert!(
            command_queue_capacity > 0,
            "presence command queue must be non-zero"
        );
        let (command_tx, command_rx) = mpsc::channel(command_queue_capacity);
        registry.command_tx = command_tx;
        // The coordinator's clone must not hold a sender back to its own
        // command channel: that self-reference keeps the channel open after
        // every external handle is dropped, so the coordinator task could
        // never observe shutdown.
        let mut coordinator = registry.clone();
        let (dead_tx, _) = mpsc::channel(1);
        coordinator.command_tx = dead_tx;
        let supervisor = tokio::spawn(async move {
            coordinator.run_coordinator(command_rx, ack_rx).await;
        });
        *registry
            .coordinator_supervisor
            .lock()
            .expect("presence coordinator supervisor lock poisoned") = Some(supervisor);
        registry
    }

    async fn run_coordinator(
        &self,
        mut rx: mpsc::Receiver<CoordinatorCommand>,
        mut persistence_ack_rx: Option<mpsc::Receiver<PresencePersistenceAck>>,
    ) {
        let mut timers = DelayQueue::new();
        let mut prune = tokio::time::interval(self.prune_interval);
        // Low-frequency drift audit per §11: the full registry rescan happens
        // here instead of on every command, and any incremental drift is both
        // alerted on and corrected.
        let mut metrics_audit = tokio::time::interval(Duration::from_secs(5 * 60));
        metrics_audit.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            self.drain_parked_operations();
            tokio::select! {
                command = rx.recv() => match command {
                    Some(CoordinatorCommand::Register { uid, initial_state, reply }) => {
                        let result = self.register_inner(uid, initial_state).await;
                        if result.0.app_state() == AppPresenceState::Unknown {
                            self.schedule_unknown_deadline(&mut timers, uid, &result.0);
                        }
                        let _ = reply.send(result);
                    }
                    Some(CoordinatorCommand::Remove { uid, conn_id, reply }) => {
                        self.remove_connection_inner(uid, conn_id, &mut timers).await;
                        let _ = reply.send(());
                    }
                    Some(CoordinatorCommand::Heartbeat { uid, conn_id, app_state, reply }) => {
                        let result = self.heartbeat_inner(uid, conn_id, app_state, &mut timers).await;
                        if result && app_state == Some(AppPresenceState::Unknown) {
                            if let Some(slot) = self.slots.get(&uid) {
                                if let Some(entry) = slot
                                    .connections
                                    .iter()
                                    .find(|entry| entry.conn_id == conn_id)
                                {
                                    self.schedule_unknown_deadline(&mut timers, uid, entry);
                                }
                            }
                        }
                        let _ = reply.send(result);
                    }
                    Some(CoordinatorCommand::Prune { max_age_secs, reply }) => {
                        self.prune_stale_inner(max_age_secs, &mut timers).await;
                        let _ = reply.send(());
                    }
                    Some(CoordinatorCommand::ReconcileSocialFacts { facts }) => {
                        self.metrics.record_presence_reconciliation();
                        self.reconcile_social_presence_facts(facts).await;
                    }
                    Some(CoordinatorCommand::ReconcileVisibilityFacts { facts }) => {
                        self.metrics.record_presence_reconciliation();
                        self.reconcile_directed_presence_facts(facts.directions).await;
                    }
                    None => return,
                },
                ack = async {
                    match persistence_ack_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                }, if persistence_ack_rx.is_some() => match ack {
                    Some(ack) => self.commit_persisted_operation(ack).await,
                    None => {
                        // The persistence supervisor is gone: the process
                        // supervisor will observe its exit and terminate the
                        // process; nothing further can be committed.
                        persistence_ack_rx = None;
                    }
                },
                Some(expired) = timers.next(), if !timers.is_empty() => {
                    match expired.into_inner() {
                        CoordinatorTimer::Disconnect { uid, generation, candidate_time } =>
                            self.finish_disconnect_debounce_inner(uid, generation, candidate_time).await,
                        CoordinatorTimer::UnknownDeadline { uid, conn_id, generation } =>
                            self.finish_unknown_deadline(uid, conn_id, generation),
                    }
                },
                _ = prune.tick() => self.prune_stale_inner(self.stale_timeout.as_secs(), &mut timers).await,
                _ = metrics_audit.tick() => self.audit_metrics().await,
            }
        }
    }

    /// Commit a successfully persisted operation: §6.2 step 3. The operation
    /// was matched and popped by the persistence supervisor; only publishing
    /// remains here, so the coordinator is the single writer of the published
    /// online state and the single producer of presence broadcasts.
    async fn commit_persisted_operation(&self, ack: PresencePersistenceAck) {
        let Ok(stored_last_seen_at) = ack.result else {
            return;
        };
        let Some(online) = ack.published_online else {
            return;
        };
        let changed_at = Utc::now();
        {
            let mut slot = self.slot_for(ack.uid);
            if slot.published_online != online {
                self.metrics.add_published_online_users(
                    i64::from(online) - i64::from(slot.published_online),
                );
            }
            slot.published_online = online;
            if !online {
                if slot.debouncing {
                    self.metrics.add_debouncing_users(-1);
                }
                slot.debouncing = false;
            }
            // Clear the tail target only when it still describes this
            // operation; a newer enqueue has already replaced it.
            if slot.queued_online_target == Some(online) {
                slot.queued_online_target = None;
            }
        }
        if let Some(broadcaster) = self.presence_broadcaster.clone() {
            broadcaster
                .broadcast(
                    self.db_pool().expect("persistence implies a database pool"),
                    ack.uid,
                    online,
                    stored_last_seen_at,
                    changed_at,
                )
                .await;
        }
    }

    pub fn take_presence_coordinator_supervisor(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.coordinator_supervisor
            .lock()
            .expect("presence coordinator supervisor lock poisoned")
            .take()
    }

    fn db_pool(&self) -> Option<DbPool> {
        self.db.clone()
    }

    pub async fn reserve_reconciliation(&self) -> Result<ReconciliationPermit, AppError> {
        self.command_tx
            .clone()
            .reserve_owned()
            .await
            .map(|permit| ReconciliationPermit { permit })
            .map_err(|_| AppError::ServiceUnavailable("Presence coordinator unavailable"))
    }

    /// Register a new connection for the given user. Returns the entry and
    /// receiver for the send task.
    /// and the receiver for the send task. Caller must call `remove_connection(uid, conn_id)` when the socket closes.
    pub async fn register(
        &self,
        uid: i32,
        initial_state: Option<AppPresenceState>,
    ) -> (Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>) {
        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .command_tx
            .send(CoordinatorCommand::Register {
                uid,
                initial_state,
                reply: reply_tx,
            })
            .await
            .is_err()
        {
            panic!("presence coordinator stopped while registering websocket");
        }
        reply_rx
            .await
            .expect("presence coordinator stopped while registering websocket")
    }

    async fn register_inner(
        &self,
        uid: i32,
        initial_state: Option<AppPresenceState>,
    ) -> (Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>) {
        let state_lane = self.state_lane_for(uid);
        let _state_lane = state_lane.lock().await;
        let conn_id = next_conn_id();
        let (tx, rx) = mpsc::channel(256);
        let initial_state = initial_state.unwrap_or(AppPresenceState::Unknown);
        let entry = Arc::new(ConnectionEntry {
            conn_id,
            tx,
            heartbeat: HeartbeatHandle::new(),
            app_state: AtomicU8::new(initial_state as u8),
            last_state_at: StdMutex::new(Instant::now()),
            unknown_generation: AtomicU64::new(1),
            long_lived_unknown_counted: AtomicBool::new(false),
            transition_limiter: std::sync::Mutex::new(TransitionLimiter::new(Instant::now())),
        });
        let had_active_connection = self.has_active_connection(uid);
        // §6.3 tail-target rule: a reconnect during a disconnect debounce (or
        // behind an already-queued Online) is not a new transition; only an
        // Offline promise still turns the first Active into an Online.
        let promised_online_before = self.promised_online(uid);
        self.slot_for(uid).connections.push(entry.clone());
        let transitioned_online =
            initial_state == AppPresenceState::Active && !promised_online_before;
        self.account_connected_users_change(1);
        self.account_connection_transition(AppPresenceState::Unknown, initial_state);
        if had_active_connection {
            // The previous entries of this uid already carry the physical
            // online gauge; only a first Active connection adds a user.
        } else if initial_state == AppPresenceState::Active {
            self.account_physical_online_change(1);
        }
        if initial_state == AppPresenceState::Active {
            self.cancel_disconnect_debounce(uid);
            if self.persistence.is_none() {
                self.set_published_online(uid, true);
            }
        }
        self.metrics.record_connection_open();
        self.broadcast_presence_to_user(uid);
        // Persistence backpressure must not hold this uid's lifecycle lane.
        drop(_state_lane);
        if initial_state == AppPresenceState::Active {
            // A fresh Active writes its first observation immediately when it
            // transitions the published state; otherwise the 5-minute
            // checkpoint interval governs.
            let checkpoint_due = !transitioned_online
                && self
                    .slots
                    .get(&uid)
                    .and_then(|slot| slot.last_checkpoint_enqueued_at)
                    .is_none_or(|last| last.elapsed() >= self.checkpoint_interval);
            if transitioned_online || checkpoint_due {
                self.slot_for(uid).last_checkpoint_enqueued_at = Some(Instant::now());
            }
            self.enqueue_observation_now(
                uid,
                PresenceObservationCause::ActiveCheckpoint,
                transitioned_online.then_some(true),
            );
        }
        (entry, rx)
    }

    /// Remove a single connection. Call when the socket closes.
    pub async fn remove_connection(&self, uid: i32, conn_id: u64) {
        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .command_tx
            .send(CoordinatorCommand::Remove {
                uid,
                conn_id,
                reply: reply_tx,
            })
            .await
            .is_err()
        {
            tracing::error!(
                uid,
                conn_id,
                "presence coordinator stopped while removing websocket"
            );
            return;
        }
        let _ = reply_rx.await;
    }

    async fn remove_connection_inner(
        &self,
        uid: i32,
        conn_id: u64,
        _timers: &mut DelayQueue<CoordinatorTimer>,
    ) {
        let state_lane = self.state_lane_for(uid);
        let _state_lane = state_lane.lock().await;
        let mut removed_active = false;
        let mut removed_state = AppPresenceState::Unknown;
        // Occupied-entry removal: a concurrent register for the same uid can
        // never observe a vacated slot between "vec became empty" and "key
        // removed" (§6.5).
        if let dashmap::mapref::entry::Entry::Occupied(mut occupied) = self.slots.entry(uid) {
            let slot = occupied.get_mut();
            if let Some(entry) = slot
                .connections
                .iter()
                .find(|entry| entry.conn_id == conn_id)
            {
                removed_state = entry.app_state();
                if entry.retire_unknown_accounting() {
                    self.metrics.add_long_lived_unknown_connections(-1);
                }
            }
            removed_active = removed_state == AppPresenceState::Active;
            slot.connections.retain(|e| e.conn_id != conn_id);
            // Keep the slot itself: the published state and debounce must
            // survive the last connection's departure (§6.5 removes only the
            // connection collection).
            if slot.connections.is_empty()
                && !slot.published_online
                && !slot.debouncing
                && slot.queued_online_target.is_none()
            {
                occupied.remove();
            }
        }
        self.account_connected_users_change(-1);
        self.account_connection_transition(removed_state, AppPresenceState::Unknown);
        if removed_active && !self.has_active_connection(uid) {
            self.account_physical_online_change(-1);
        }
        let no_active_connections = !self.has_active_connection(uid);
        self.broadcast_presence_to_user(uid);
        if removed_active && no_active_connections {
            self.start_disconnect_debounce(_timers, uid, Utc::now().naive_utc());
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
        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .command_tx
            .send(CoordinatorCommand::Heartbeat {
                uid,
                conn_id,
                app_state,
                reply: reply_tx,
            })
            .await
            .is_err()
        {
            return false;
        }
        reply_rx.await.unwrap_or(false)
    }

    async fn heartbeat_inner(
        &self,
        uid: i32,
        conn_id: u64,
        app_state: Option<AppPresenceState>,
        _timers: &mut DelayQueue<CoordinatorTimer>,
    ) -> bool {
        let state_lane = self.state_lane_for(uid);
        let _state_lane = state_lane.lock().await;
        let entries = self.slots.entry(uid).or_default();
        let Some(entry) = entries
            .connections
            .iter()
            .find(|entry| entry.conn_id == conn_id)
            .cloned()
        else {
            return false;
        };
        drop(entries);

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
            && !self.permit_transition(&entry, uid, changes_aggregate_state, Instant::now())
        {
            drop(_state_lane);
            tracing::warn!(
                uid,
                conn_id,
                "ws presence transition rate limit exceeded; closing connection"
            );
            self.metrics.record_presence_transition_rate_limited();
            self.remove_connection_inner(uid, conn_id, _timers).await;
            self.metrics
                .record_presence_transition_rate_limit_eviction();
            return false;
        }
        if let Some(app_state) = app_state {
            if app_state != AppPresenceState::Unknown
                && entry
                    .long_lived_unknown_counted
                    .swap(false, Ordering::Relaxed)
            {
                self.metrics.add_long_lived_unknown_connections(-1);
            }
            entry.update_app_state(app_state);
        }
        let checkpoint_due = entry.app_state() == AppPresenceState::Active
            && self
                .slots
                .get(&uid)
                .and_then(|slot| slot.last_checkpoint_enqueued_at)
                .is_none_or(|last| last.elapsed() >= self.checkpoint_interval);
        if changed_state {
            self.account_connection_transition(
                previous_state,
                entry_snapshot_state(&self.slots, uid, conn_id),
            );
            if changes_aggregate_state {
                self.account_physical_online_change(
                    if app_state == Some(AppPresenceState::Active) {
                        1
                    } else {
                        -1
                    },
                );
            }
        }
        // The operation is now fully derived from the serialized state.  Do
        // not make subsequent commands wait for persistence queue capacity.
        drop(_state_lane);

        if changed_state {
            match app_state.expect("changed state is always present") {
                AppPresenceState::Active => {
                    // §6.3: the published state is what the tail target
                    // promises, not merely whether an Active connection
                    // exists. A reconnect absorbed by the disconnect debounce
                    // must not re-announce online; a reconnect behind an
                    // in-flight Offline must queue the matching Online.
                    let transitioned_online = !self.promised_online(uid);
                    self.cancel_disconnect_debounce(uid);
                    if self.persistence.is_none() {
                        self.set_published_online(uid, true);
                    }
                    // A fresh Active writes its first observation immediately
                    // when it transitions the published state; a repeated
                    // Active (state flip back or extra device) only checkpoints
                    // on the shared interval.
                    let checkpoint_due = !transitioned_online
                        && self
                            .slots
                            .get(&uid)
                            .and_then(|slot| slot.last_checkpoint_enqueued_at)
                            .is_none_or(|last| last.elapsed() >= self.checkpoint_interval);
                    if transitioned_online {
                        self.metrics.record_presence_transition();
                        self.enqueue_observation_now(
                            uid,
                            PresenceObservationCause::ActiveCheckpoint,
                            Some(true),
                        );
                    } else if checkpoint_due {
                        self.metrics.record_presence_checkpoint_submitted();
                        self.slot_for(uid).last_checkpoint_enqueued_at = Some(Instant::now());
                        self.enqueue_observation_now(
                            uid,
                            PresenceObservationCause::ActiveCheckpoint,
                            None,
                        );
                    }
                }
                AppPresenceState::Inactive => {
                    let mut transitioned_offline = false;
                    if had_active_connection && !self.has_active_connection(uid) {
                        transitioned_offline = true;
                        self.cancel_disconnect_debounce(uid);
                        if self.persistence.is_none() {
                            self.set_published_online(uid, false);
                        }
                    }
                    let cause = (
                        PresenceObservationCause::ExplicitInactive,
                        transitioned_offline.then_some(false),
                    );
                    if cause.1.is_some() {
                        self.metrics.record_presence_transition();
                    } else {
                        self.metrics.record_presence_checkpoint_submitted();
                    }
                    self.enqueue_observation_now(uid, cause.0, cause.1);
                }
                AppPresenceState::Unknown => return true,
            }
        } else if checkpoint_due {
            self.metrics.record_presence_checkpoint_submitted();
            self.slot_for(uid).last_checkpoint_enqueued_at = Some(Instant::now());
            self.enqueue_observation_now(uid, PresenceObservationCause::ActiveCheckpoint, None);
        }
        true
    }

    /// Broadcast a JSON string to all connections for the given user ids. Each uid may have multiple connections.
    /// Failures to send (e.g. full buffer) are logged but do not remove the connection here.
    pub fn broadcast_to_uids(&self, uids: &[i32], message: Arc<ServerWsMessage>) {
        let msg_type = message.message_type();
        for &uid in uids {
            if let Some(slot) = self.slots.get(&uid) {
                for entry in slot.connections.iter() {
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
        let now = Instant::now();
        self.slots.get(&uid).is_some_and(|slot| {
            slot.connections.iter().any(|entry| {
                now.duration_since(entry.heartbeat.sample().received_at)
                    <= Duration::from_secs(freshness_secs)
                    && entry.app_state() == AppPresenceState::Active
            })
        })
    }

    /// Remove connections that have not sent a ping in more than `max_age` seconds.
    /// Call periodically (e.g. every 60s) from a background task.
    pub async fn prune_stale(&self, max_age_secs: u64) {
        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .command_tx
            .send(CoordinatorCommand::Prune {
                max_age_secs,
                reply: reply_tx,
            })
            .await
            .is_err()
        {
            return;
        }
        let _ = reply_rx.await;
    }

    async fn prune_stale_inner(
        &self,
        max_age_secs: u64,
        _timers: &mut DelayQueue<CoordinatorTimer>,
    ) {
        let now = Instant::now();
        let uids: Vec<i32> = self.slots.iter().map(|entry| *entry.key()).collect();
        let mut pruned_uids: Vec<(i32, bool, NaiveDateTime)> = Vec::new();
        let mut connected_delta = 0i64;
        for uid in uids {
            // The second freshness check and deletion are serialized with a
            // heartbeat for this uid, but unrelated users continue in their
            // own lanes.
            let _state_lane = self.state_lane_for(uid).lock_owned().await;
            let mut removed_active = false;
            let mut offline_candidate = None;
            if let dashmap::mapref::entry::Entry::Occupied(mut occupied) = self.slots.entry(uid) {
                let stale: Vec<u64> = occupied
                    .get()
                    .connections
                    .iter()
                    .filter(|entry| {
                        now.duration_since(entry.heartbeat.sample().received_at)
                            > Duration::from_secs(max_age_secs)
                    })
                    .map(|entry| entry.conn_id)
                    .collect();
                if !stale.is_empty() {
                    removed_active = occupied.get().connections.iter().any(|entry| {
                        stale.contains(&entry.conn_id)
                            && entry.app_state() == AppPresenceState::Active
                    });
                    offline_candidate = occupied
                        .get()
                        .connections
                        .iter()
                        .filter(|entry| {
                            stale.contains(&entry.conn_id)
                                && entry.app_state() == AppPresenceState::Active
                        })
                        .map(|entry| entry.heartbeat.sample().observed_at)
                        .max();
                    let mut unknown_refunds = 0i64;
                    let mut state_deltas: HashMap<AppPresenceState, i64> = HashMap::new();
                    occupied.get_mut().connections.retain(|entry| {
                        if stale.contains(&entry.conn_id) {
                            *state_deltas.entry(entry.app_state()).or_insert(0) -= 1;
                            if entry.retire_unknown_accounting() {
                                unknown_refunds -= 1;
                            }
                        }
                        !stale.contains(&entry.conn_id)
                    });
                    if unknown_refunds != 0 {
                        self.metrics
                            .add_long_lived_unknown_connections(unknown_refunds);
                    }
                    for (state, delta) in state_deltas {
                        self.account_connection_transition(
                            state,
                            if delta < 0 {
                                AppPresenceState::Unknown
                            } else {
                                state
                            },
                        );
                        connected_delta += delta;
                    }
                    {
                        let slot = occupied.get();
                        if slot.connections.is_empty()
                            && !slot.published_online
                            && !slot.debouncing
                            && slot.queued_online_target.is_none()
                        {
                            occupied.remove();
                        }
                    }
                }
            }
            if removed_active && !self.has_active_connection(uid) {
                self.account_physical_online_change(-1);
                let transitioned_offline =
                    self.persistence.is_some() || self.is_published_online(uid);
                self.cancel_disconnect_debounce(uid);
                if self.persistence.is_none() {
                    self.set_published_online(uid, false);
                }
                pruned_uids.push((
                    uid,
                    transitioned_offline,
                    offline_candidate.expect("removed active connection has a heartbeat sample"),
                ));
            }
        }
        self.account_connected_users_change(connected_delta);
        for (uid, transitioned_offline, offline_candidate) in pruned_uids {
            self.broadcast_presence_to_user(uid);
            if transitioned_offline {
                self.metrics.record_presence_transition();
            } else {
                self.metrics.record_presence_checkpoint_submitted();
            }
            self.enqueue_observation_at(
                uid,
                offline_candidate,
                PresenceObservationCause::Prune,
                transitioned_offline.then_some(false),
            );
        }
    }

    /// Notify all of a user's connections about the current connection count.
    pub fn broadcast_presence_to_user(&self, uid: i32) {
        if let Some(slot) = self.slots.get(&uid) {
            let count = slot.connections.len() as u32;
            let msg = Arc::new(ServerWsMessage::PresenceUpdate(PresenceUpdatePayload {
                active_connections: count,
            }));
            for entry in slot.connections.iter() {
                let _ = entry.tx.try_send(msg.clone());
            }
        }
    }

    pub fn refresh_metrics(&self) {
        self.apply_gauge_snapshot(&self.gauge_snapshot());
    }

    /// Transfers ownership of the persistence supervisor to the process
    /// lifecycle owner. A stopped supervisor cannot safely be restarted: it
    /// may have lost the in-flight operation bookkeeping, so main treats any
    /// completion as fatal instead.
    pub fn take_presence_persistence_supervisor(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.persistence
            .as_ref()
            .and_then(PresencePersistence::take_supervisor)
    }

    /// Return the logical, externally visible online state for each requested
    /// user. A uid omitted from the registry has never been observed online.
    pub fn online_flags(&self, uids: &[i32]) -> HashMap<i32, bool> {
        uids.iter()
            .copied()
            .map(|uid| {
                let online = self
                    .slots
                    .get(&uid)
                    .is_some_and(|slot| slot.published_online);
                (uid, online)
            })
            .collect()
    }

    async fn reconcile_social_presence_facts(&self, facts: social::PresencePairReconciliation) {
        self.reconcile_directed_presence_facts(vec![facts.first_to_second, facts.second_to_first])
            .await;
    }

    async fn reconcile_directed_presence_facts(
        &self,
        directions: Vec<social::DirectedPresenceReconciliation>,
    ) {
        for directed in directions {
            match (directed.was_visible, directed.is_visible) {
                (true, false) => {
                    if let Some(broadcaster) = self.presence_broadcaster.clone() {
                        broadcaster
                            .broadcast_revocation_exact(
                                vec![directed.viewer_uid],
                                directed.subject_uid,
                            )
                            .await;
                    }
                }
                (false, true) => {
                    if let Some(broadcaster) = self.presence_broadcaster.clone() {
                        let online = self
                            .online_flags(&[directed.subject_uid])
                            .get(&directed.subject_uid)
                            .copied()
                            .unwrap_or(false);
                        broadcaster
                            .broadcast_exact(
                                vec![directed.viewer_uid],
                                directed.subject_uid,
                                online,
                                directed.last_seen_at,
                            )
                            .await;
                    }
                }
                _ => {}
            }
        }
    }

    fn enqueue_observation_now(
        &self,
        uid: i32,
        cause: PresenceObservationCause,
        published_online: Option<bool>,
    ) {
        self.enqueue_observation_at(uid, Utc::now().naive_utc(), cause, published_online);
    }

    fn enqueue_observation_at(
        &self,
        uid: i32,
        observed_at: NaiveDateTime,
        cause: PresenceObservationCause,
        published_online: Option<bool>,
    ) {
        if let Some(persistence) = &self.persistence {
            // §6.1: operation ids are allocated per uid slot. The slot may
            // be removed between operations; ids only need to distinguish
            // concurrent queue entries of one uid, and the attempt id guards
            // resubmission, so reuse after removal is safe.
            let operation_id = {
                let mut slot = self.slot_for(uid);
                slot.next_operation_id = slot.next_operation_id.saturating_add(1);
                let operation_id = slot.next_operation_id;
                if published_online.is_some() {
                    slot.queued_online_target = published_online;
                }
                operation_id
            };
            if let Some(spilled) =
                persistence.enqueue(uid, operation_id, observed_at, cause, published_online)
            {
                // §11: nothing is dropped at the submission boundary. Park the
                // operation on the uid's spillway; the coordinator retries it
                // on every loop turn, so a saturated global lane degrades to
                // bounded per-uid backpressure instead of blocking all uids.
                {
                    let mut parked = persistence
                        .spillway
                        .entry(uid)
                        .or_insert_with(|| VecDeque::with_capacity(4));
                    parked.push_back(spilled);
                    self.metrics.record_presence_degradation();
                    while parked.len() > Self::PARKED_OPERATIONS_PER_UID {
                        let head = parked.pop_front().expect("parked overflow above one");
                        if head.published_online.is_none() {
                            self.metrics.record_presence_checkpoint_coalesced();
                            continue;
                        }
                        // Collapse the parked explicit transitions to their
                        // latest target: the shortest sequence converging to
                        // the current physical state under sustained
                        // saturation.
                        let latest = parked.iter().skip(1).last().cloned();
                        let mut collapsed = VecDeque::with_capacity(2);
                        collapsed.push_back(head);
                        if let Some(latest) = latest {
                            collapsed.push_back(latest);
                        }
                        *parked = collapsed;
                        self.metrics.record_presence_degradation();
                        break;
                    }
                }
                // The entry guard must be released before the shared-borrow
                // refresh below: dashmap would deadlock on the same shard.
                self.refresh_spillway_depth();
            }
        }
    }

    fn refresh_spillway_depth(&self) {
        let Some(persistence) = &self.persistence else {
            return;
        };
        let total: usize = persistence
            .spillway
            .iter()
            .map(|entry| entry.value().len())
            .sum();
        self.metrics.set_presence_spillway_queue_depth(total);
    }

    /// Drain parked operations back into the persistence lane at the top of
    /// every coordinator iteration.
    fn drain_parked_operations(&self) {
        let Some(persistence) = &self.persistence else {
            return;
        };
        let uids: Vec<i32> = persistence
            .spillway
            .iter()
            .filter(|entry| !entry.value().is_empty())
            .map(|entry| *entry.key())
            .collect();
        for uid in uids {
            {
                let mut parked = persistence
                    .spillway
                    .entry(uid)
                    .or_insert_with(VecDeque::new);
                while let Some(observation) = parked.pop_front() {
                    if persistence.tx.try_send(observation.clone()).is_err() {
                        parked.push_front(observation);
                        break;
                    }
                }
            }
            // Entry guard released before the shared-borrow refresh: dashmap
            // would deadlock on the same shard otherwise.
            self.refresh_spillway_depth();
        }
    }

    /// The online state already promised to viewers: the tail target of the
    /// uid's operation queue, or the committed published state when the queue
    /// is empty (§6.1).
    fn promised_online(&self, uid: i32) -> bool {
        if let Some(slot) = self.slots.get(&uid) {
            if let Some(target) = slot.queued_online_target {
                return target;
            }
        }
        self.is_published_online(uid)
    }

    /// The uid's presence slot, created empty-offline when absent. Callers
    /// run inside the coordinator, which serializes slot mutation per uid.
    fn slot_for(&self, uid: i32) -> dashmap::mapref::one::RefMut<'_, i32, PresenceSlot> {
        self.slots
            .entry(uid)
            .or_insert_with(|| PresenceSlot::new(false))
    }

    fn set_published_online(&self, uid: i32, online: bool) {
        let mut slot = self.slot_for(uid);
        let was_online = slot.published_online;
        slot.published_online = online;
        if was_online != online {
            self.metrics.add_published_online_users(i64::from(online));
        }
    }

    fn cancel_disconnect_debounce(&self, uid: i32) {
        let mut absorbed = false;
        if let Some(mut slot) = self.slots.get_mut(&uid) {
            slot.disconnect_generation = slot.disconnect_generation.wrapping_add(1);
            absorbed = slot.debouncing;
            slot.debouncing = false;
        }
        if absorbed {
            self.metrics.record_presence_debounce_absorbed();
            self.metrics.add_debouncing_users(-1);
        }
    }

    fn start_disconnect_debounce(
        &self,
        timers: &mut DelayQueue<CoordinatorTimer>,
        uid: i32,
        candidate_time: NaiveDateTime,
    ) {
        let mut slot = self.slot_for(uid);
        slot.disconnect_generation = slot.disconnect_generation.wrapping_add(1);
        let generation = slot.disconnect_generation;
        slot.debouncing = true;
        drop(slot);
        self.metrics.add_debouncing_users(1);
        timers.insert(
            CoordinatorTimer::Disconnect {
                uid,
                generation,
                candidate_time,
            },
            self.disconnect_debounce,
        );
    }

    async fn finish_disconnect_debounce_inner(
        &self,
        uid: i32,
        generation: u64,
        candidate_time: NaiveDateTime,
    ) {
        // All slot reads and writes happen under one guard; the connection
        // scan runs after the guard is released (a dashmap shard write guard
        // re-entered for the same uid would deadlock).
        let decision = {
            let Some(mut slot) = self.slots.get_mut(&uid) else {
                return;
            };
            if slot.disconnect_generation != generation {
                return;
            }
            let should_publish_offline = self.persistence.is_some() || slot.published_online;
            if self.persistence.is_none() {
                slot.published_online = false;
            }
            slot.debouncing = false;
            should_publish_offline
        };
        let still_has_active = self.has_active_connection(uid);
        if decision && still_has_active {
            // An Active connection appeared between the timer firing and this
            // commit: keep the user online and skip the offline observation.
            self.metrics.add_debouncing_users(-1);
            return;
        }
        self.metrics.add_debouncing_users(-1);
        self.enqueue_observation_at(
            uid,
            candidate_time,
            PresenceObservationCause::Disconnect,
            decision.then_some(false),
        );
    }

    fn schedule_unknown_deadline(
        &self,
        timers: &mut DelayQueue<CoordinatorTimer>,
        uid: i32,
        entry: &ConnectionEntry,
    ) {
        timers.insert(
            CoordinatorTimer::UnknownDeadline {
                uid,
                conn_id: entry.conn_id,
                generation: entry.unknown_generation.load(Ordering::Relaxed),
            },
            self.unknown_connection_threshold,
        );
    }

    fn finish_unknown_deadline(&self, uid: i32, conn_id: u64, generation: u64) {
        let Some(slot) = self.slots.get(&uid) else {
            return;
        };
        let Some(entry) = slot
            .connections
            .iter()
            .find(|entry| entry.conn_id == conn_id)
        else {
            return;
        };
        if entry.app_state() == AppPresenceState::Unknown
            && entry.unknown_generation.load(Ordering::Relaxed) == generation
            && !entry
                .long_lived_unknown_counted
                .swap(true, Ordering::Relaxed)
        {
            self.metrics.add_long_lived_unknown_connections(1);
        }
    }

    fn has_active_connection(&self, uid: i32) -> bool {
        self.slots.get(&uid).is_some_and(|slot| {
            slot.connections
                .iter()
                .any(|entry| entry.app_state() == AppPresenceState::Active)
        })
    }

    fn has_other_active_connection(&self, uid: i32, conn_id: u64) -> bool {
        self.slots.get(&uid).is_some_and(|slot| {
            slot.connections.iter().any(|entry| {
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
        let mut previous = self
            .last_uid_limiter_cleanup_at
            .lock()
            .expect("uid limiter cleanup timestamp lock poisoned");
        if now.duration_since(*previous) < Duration::from_secs(UID_LIMITER_TTL_SECS) {
            return;
        }
        *previous = now;
        drop(previous);
        self.uid_transition_limiters.retain(|_, limiter| {
            !limiter.is_expired(now, Duration::from_secs(UID_LIMITER_TTL_SECS))
        });
    }

    fn is_published_online(&self, uid: i32) -> bool {
        self.slots
            .get(&uid)
            .is_some_and(|slot| slot.published_online)
    }

    /// Recompute every registry-derived gauge from scratch. Only the
    /// low-frequency drift audit and tests call this; per-command accounting
    /// applies deltas through the `add_*_metric` helpers instead.
    fn gauge_snapshot(&self) -> GaugeSnapshot {
        let mut active_connections = 0usize;
        let mut inactive_connections = 0usize;
        let mut long_lived_unknown_connections = 0usize;
        let mut physical_online_users = 0usize;

        for slot_ref in self.slots.iter() {
            let mut has_active_connection = false;
            for entry in slot_ref.connections.iter() {
                match entry.app_state() {
                    AppPresenceState::Active => {
                        active_connections += 1;
                        has_active_connection = true;
                    }
                    AppPresenceState::Inactive => inactive_connections += 1,
                    AppPresenceState::Unknown => {
                        long_lived_unknown_connections +=
                            usize::from(entry.long_lived_unknown_counted.load(Ordering::Relaxed));
                    }
                }
            }
            physical_online_users += usize::from(has_active_connection);
        }
        let published_online_users = self
            .slots
            .iter()
            .filter(|slot| slot.published_online)
            .count();
        let debouncing_users = self.slots.iter().filter(|slot| slot.debouncing).count();

        GaugeSnapshot {
            connected_users: self.slots.len(),
            active_connections,
            inactive_connections,
            long_lived_unknown_connections,
            physical_online_users,
            published_online_users,
            debouncing_users,
        }
    }

    fn apply_gauge_snapshot(&self, snapshot: &GaugeSnapshot) {
        self.metrics.set_connected_users(snapshot.connected_users);
        self.metrics
            .set_connection_states(snapshot.active_connections, snapshot.inactive_connections);
        self.metrics
            .set_long_lived_unknown_connections(snapshot.long_lived_unknown_connections);
        self.metrics.set_presence_users(
            snapshot.physical_online_users,
            snapshot.published_online_users,
            snapshot.debouncing_users,
        );
        self.connected_users_total
            .store(snapshot.connected_users, Ordering::Relaxed);
        self.active_connections_total
            .store(snapshot.active_connections, Ordering::Relaxed);
        self.inactive_connections_total
            .store(snapshot.inactive_connections, Ordering::Relaxed);
        self.physical_online_users_total
            .store(snapshot.physical_online_users, Ordering::Relaxed);
    }

    /// Apply one connection's contribution to the connection-count gauges.
    /// Called while holding the uid state lane, so per-uid accounting is
    /// serialized; the atomics keep unrelated readers wait-free.
    fn account_connection_transition(&self, previous: AppPresenceState, next: AppPresenceState) {
        if previous == next {
            return;
        }
        let mut active_delta = 0i64;
        let mut inactive_delta = 0i64;
        match previous {
            AppPresenceState::Active => active_delta -= 1,
            AppPresenceState::Inactive => inactive_delta -= 1,
            AppPresenceState::Unknown => {}
        }
        match next {
            AppPresenceState::Active => active_delta += 1,
            AppPresenceState::Inactive => inactive_delta += 1,
            AppPresenceState::Unknown => {}
        }
        if active_delta != 0 {
            let delta = active_delta.unsigned_abs() as usize;
            if active_delta > 0 {
                self.active_connections_total
                    .fetch_add(delta, Ordering::Relaxed);
            } else {
                self.active_connections_total
                    .fetch_sub(delta, Ordering::Relaxed);
            }
        }
        if inactive_delta != 0 {
            let delta = inactive_delta.unsigned_abs() as usize;
            if inactive_delta > 0 {
                self.inactive_connections_total
                    .fetch_add(delta, Ordering::Relaxed);
            } else {
                self.inactive_connections_total
                    .fetch_sub(delta, Ordering::Relaxed);
            }
        }
        self.metrics.set_connection_states(
            self.active_connections_total.load(Ordering::Relaxed),
            self.inactive_connections_total.load(Ordering::Relaxed),
        );
    }

    fn account_connected_users_change(&self, delta: i64) {
        if delta == 0 {
            return;
        }
        let amount = delta.unsigned_abs() as usize;
        if delta > 0 {
            self.connected_users_total
                .fetch_add(amount, Ordering::Relaxed);
        } else {
            self.connected_users_total
                .fetch_sub(amount, Ordering::Relaxed);
        }
        self.metrics
            .set_connected_users(self.connected_users_total.load(Ordering::Relaxed));
    }

    /// Publish the physical-online-user gauge from the incremental total.
    fn account_physical_online_change(&self, delta: i64) {
        if delta == 0 {
            return;
        }
        let amount = delta.unsigned_abs() as usize;
        if delta > 0 {
            self.physical_online_users_total
                .fetch_add(amount, Ordering::Relaxed);
        } else {
            self.physical_online_users_total
                .fetch_sub(amount, Ordering::Relaxed);
        }
        self.metrics.add_physical_online_users(delta);
    }

    /// Low-frequency drift audit: recompute every gauge from the registry and
    /// correct any incremental drift, recording an alert metric when found.
    async fn audit_metrics(&self) {
        let snapshot = self.gauge_snapshot();
        let drift = snapshot.connected_users != self.connected_users_total.load(Ordering::Relaxed)
            || snapshot.active_connections != self.active_connections_total.load(Ordering::Relaxed)
            || snapshot.inactive_connections
                != self.inactive_connections_total.load(Ordering::Relaxed)
            || snapshot.physical_online_users
                != self.physical_online_users_total.load(Ordering::Relaxed);
        if drift {
            self.metrics.record_presence_metrics_drift();
            tracing::warn!(
                connected_users_audit = snapshot.connected_users,
                connected_users_total = self.connected_users_total.load(Ordering::Relaxed),
                active_connections_audit = snapshot.active_connections,
                active_connections_total = self.active_connections_total.load(Ordering::Relaxed),
                inactive_connections_audit = snapshot.inactive_connections,
                inactive_connections_total =
                    self.inactive_connections_total.load(Ordering::Relaxed),
                physical_online_audit = snapshot.physical_online_users,
                physical_online_total = self.physical_online_users_total.load(Ordering::Relaxed),
                "presence gauge drift detected; resetting from registry audit"
            );
        }
        self.apply_gauge_snapshot(&snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Snapshot of a uid's slot (connections omitted; tests assert on state
    /// flags via the targeted accessors below).
    fn slot_of(registry: &ConnectionRegistry, uid: i32) -> PresenceSlot {
        registry
            .slots
            .get(&uid)
            .map(|slot| PresenceSlot {
                published_online: slot.published_online,
                debouncing: slot.debouncing,
                disconnect_generation: slot.disconnect_generation,
                queued_online_target: slot.queued_online_target,
                last_checkpoint_enqueued_at: slot.last_checkpoint_enqueued_at,
                next_operation_id: slot.next_operation_id,
                connections: Vec::new(),
            })
            .unwrap_or_else(|| PresenceSlot::new(false))
    }

    fn slot_has_uid(registry: &ConnectionRegistry, uid: i32) -> bool {
        registry.slots.contains_key(&uid)
    }

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
            slots: registry.slots.clone(),
            metrics: registry.metrics.clone(),
            sequence: Arc::new(AtomicU64::new(0)),
            broadcast_lane: Arc::new(Mutex::new(())),
        }
    }

    fn observation(operation_id: u64, attempt_id: u64) -> PresenceObservation {
        PresenceObservation {
            operation_id,
            attempt_id,
            uid: 7,
            observed_at: chrono::DateTime::from_timestamp(1_700_000_000, 0)
                .expect("valid timestamp")
                .naive_utc(),
            cause: PresenceObservationCause::ActiveCheckpoint,
            published_online: Some(true),
        }
    }

    #[test]
    fn persistence_acknowledgement_requires_matching_operation_and_attempt() {
        let operation = observation(11, 3);
        let matching = PresencePersistenceAck {
            operation_id: 11,
            attempt_id: 3,
            uid: 7,
            result: Ok(operation.observed_at),
            published_online: operation.published_online,
        };
        let stale_attempt = PresencePersistenceAck {
            operation_id: 11,
            attempt_id: 2,
            uid: 7,
            result: Ok(operation.observed_at),
            published_online: operation.published_online,
        };
        let stale_operation = PresencePersistenceAck {
            operation_id: 10,
            attempt_id: 3,
            uid: 7,
            result: Ok(operation.observed_at),
            published_online: operation.published_online,
        };

        assert!(operation.matches_ack(&matching));
        assert!(!operation.matches_ack(&stale_attempt));
        assert!(!operation.matches_ack(&stale_operation));
    }

    #[test]
    fn persistence_retry_backoff_is_bounded_and_increases_per_attempt() {
        let max_backoff = Duration::from_secs(5);
        assert_eq!(
            observation(1, 2).retry_delay(max_backoff),
            Duration::from_millis(100)
        );
        assert_eq!(
            observation(1, 3).retry_delay(max_backoff),
            Duration::from_millis(200)
        );
        assert_eq!(observation(1, 100).retry_delay(max_backoff), max_backoff);
        assert_eq!(
            observation(1, 100).retry_delay(Duration::from_secs(1)),
            Duration::from_secs(1)
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
        entry.heartbeat.record_at(
            Instant::now()
                .checked_sub(Duration::from_secs(31))
                .expect("valid stale sample"),
            Utc::now().naive_utc(),
        );

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

    #[tokio::test(start_paused = true)]
    async fn metrics_refresh_counts_long_lived_unknown_connections() {
        let prometheus_registry = prometheus::Registry::new();
        let metrics = Arc::new(WsMetrics::new(&prometheus_registry));
        let registry = ConnectionRegistry::with_transition_rate_limits(
            metrics,
            Duration::from_secs(45),
            PresenceTransitionLimits {
                window: Duration::from_secs(10),
                per_connection: 12,
                per_uid: 20,
            },
        );
        let (entry, _rx) = registry.register(7, None).await;
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;

        let rendered = crate::metrics::encode(&prometheus_registry).expect("metrics should render");
        assert!(rendered.contains("ws_long_lived_unknown_connections 1"));

        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );
        let rendered = crate::metrics::encode(&prometheus_registry).expect("metrics should render");
        assert!(rendered.contains("ws_long_lived_unknown_connections 0"));
    }

    #[tokio::test]
    async fn heartbeat_does_not_change_app_state() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Inactive)).await;

        assert!(registry.heartbeat(7, entry.conn_id(), None).await);

        assert_eq!(entry.app_state(), AppPresenceState::Inactive);
    }

    #[tokio::test]
    async fn active_heartbeat_renews_a_due_uid_checkpoint() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        registry
            .slots
            .entry(7)
            .or_insert_with(|| PresenceSlot::new(false))
            .last_checkpoint_enqueued_at = Some(
            Instant::now()
                .checked_sub(registry.checkpoint_interval)
                .expect("checkpoint interval is smaller than process uptime in this test"),
        );

        assert!(registry.heartbeat(7, entry.conn_id(), None).await);
        let renewed = slot_of(&registry, 7)
            .last_checkpoint_enqueued_at
            .expect("active heartbeat renews checkpoint");
        assert!(renewed.elapsed() < Duration::from_secs(1));
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

    #[tokio::test(start_paused = true)]
    async fn normal_disconnect_keeps_user_online_until_debounce_expires() {
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            std::time::Duration::from_secs(25),
        );
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;

        registry.remove_connection(7, entry.conn_id()).await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));

        tokio::time::advance(Duration::from_secs(25)).await;
        tokio::task::yield_now().await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&false));
    }

    #[tokio::test(start_paused = true)]
    async fn active_reconnect_cancels_a_pending_disconnect_debounce() {
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            std::time::Duration::from_secs(25),
        );
        let (first, mut first_rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        // Drain the initial connection-count broadcast so later assertions see
        // only presence events.
        drain_messages(&mut first_rx).await;

        registry.remove_connection(7, first.conn_id()).await;
        let (_second, mut second_rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        // §6.3: the reconnect was absorbed by the debounce, so the user was
        // never published offline and no Online event may be broadcast.
        assert!(
            next_presence_change_opt(&mut second_rx).await.is_none(),
            "an absorbed reconnect must not re-announce online"
        );

        tokio::time::advance(Duration::from_secs(25)).await;
        tokio::task::yield_now().await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));
    }

    #[tokio::test]
    async fn explicit_offline_then_active_transitions_published_state_both_ways() {
        // An explicit Inactive transitions the user offline immediately; the
        // reconnect that follows is a real Online transition and restores the
        // published state. Without persistence there is no broadcast stage:
        // the published state is the assertion surface.
        let registry = registry();
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;

        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&false));

        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Active))
                .await
        );
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));
        // The second Active is a real transition after an Offline, not an
        // absorbed reconnect: no debounce generation may have absorbed it.
        assert!(!slot_of(&registry, 7).debouncing);
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_active_heartbeats_do_not_checkpoint_before_the_interval() {
        let registry = ConnectionRegistry::with_transition_rate_limits(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(45),
            PresenceTransitionLimits {
                window: Duration::from_secs(10),
                per_connection: 12,
                per_uid: 20,
            },
        );
        let registry = registry;
        // Establish the checkpoint reference through the interval-gated path:
        // register Active (immediate online observation), then expire the
        // interval and renew via a stateless heartbeat.
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        tokio::time::advance(registry.checkpoint_interval).await;
        assert!(registry.heartbeat(7, entry.conn_id(), None).await);
        let recorded_at = slot_of(&registry, 7)
            .last_checkpoint_enqueued_at
            .expect("due heartbeat recorded the checkpoint reference");

        // Well inside the 5-minute interval: an Inactive -> Active flip must
        // not enqueue a checkpoint on top of the standing reference.
        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );
        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Active))
                .await
        );
        assert_eq!(
            slot_of(&registry, 7)
                .last_checkpoint_enqueued_at
                .expect("checkpoint reference survives"),
            recorded_at,
            "the 5-minute checkpoint interval must gate repeated Active transitions"
        );
    }

    #[tokio::test]
    async fn a_saturated_persistence_lane_does_not_block_other_uids() {
        // The pool points at an unroutable port: the single persistence
        // attempt blocks on pool checkout, which keeps the global lane
        // saturated for the whole test without depending on real database
        // timing. No other test's rows are touched.
        // build_unchecked skips eager connection attempts (r2d2's build
        // retries failures until the connection timeout, which would hang):
        // the checkout inside the persistence attempt is the first real
        // connection attempt, and it blocks there for the whole test.
        let db = crate::state::DbPool::builder()
            .connection_timeout(std::time::Duration::from_millis(20))
            .build_unchecked(diesel::r2d2::ConnectionManager::new(
                "postgresql://wetty_chat:unused@127.0.0.1:1/none",
            ));
        let metrics = Arc::new(WsMetrics::new(&prometheus::Registry::new()));
        let activity_metrics = Arc::new(
            crate::services::activity_metrics::ActivityMetricsService::new(Arc::new(
                crate::services::client_tracking::ClientTrackingMetrics::new(
                    &prometheus::Registry::new(),
                ),
            )),
        );
        let registry = ConnectionRegistry::with_presence_persistence(
            metrics,
            db,
            activity_metrics,
            1, // queue capacity: a single observation saturates the lane
            Duration::from_secs(45),
            PresenceTransitionLimits {
                window: Duration::from_secs(10),
                per_connection: 12,
                per_uid: 20,
            },
            Duration::from_secs(60),
            Duration::from_secs(5 * 60),
            1, // per-uid operation queue capacity
            Duration::from_secs(60),
            4096,
            Duration::from_secs(60),
            Duration::from_secs(90),
        );

        // Saturate the global lane: this operation occupies the single slot.
        let (_first, _first_rx) = registry.register(1, Some(AppPresenceState::Active)).await;
        // The following operations from a different uid must not wait on
        // persistence capacity: they complete promptly because the
        // coordinator loop never awaits the persistence lane.
        let started = std::time::Instant::now();
        for _ in 0..8 {
            let (_entry, _rx) = registry.register(2, Some(AppPresenceState::Active)).await;
        }
        let conn_id = registry.slots.get(&2).unwrap().connections[0].conn_id();
        let hb = registry
            .heartbeat(2, conn_id, Some(AppPresenceState::Inactive))
            .await;
        assert!(
            hb,
            "an unrelated uid's heartbeat must be served while the lane is full"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "state handling must stay responsive while the lane is saturated"
        );
    }

    #[tokio::test]
    async fn removing_the_last_connection_then_registering_again_keeps_the_new_connection() {
        // Serializes the §6.5 hazard: removing the last connection vacates the
        // uid slot, and an immediately following register for the same uid
        // must not be dropped by the slot removal.
        let registry = registry();
        let (first, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        registry.remove_connection(7, first.conn_id()).await;

        let (second, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        assert!(
            registry
                .heartbeat(7, second.conn_id(), Some(AppPresenceState::Active))
                .await,
            "the re-registered connection must be addressable"
        );
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));
    }

    #[tokio::test(start_paused = true)]
    async fn stale_disconnect_timer_does_not_complete_a_later_disconnect() {
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(45),
        );
        let (first, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        registry.remove_connection(7, first.conn_id()).await;

        tokio::time::advance(Duration::from_secs(15)).await;
        let (second, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        registry.remove_connection(7, second.conn_id()).await;

        tokio::time::advance(Duration::from_secs(30)).await;
        tokio::task::yield_now().await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));
        assert!(slot_of(&registry, 7).debouncing);

        tokio::time::advance(Duration::from_secs(15)).await;
        tokio::task::yield_now().await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&false));
    }

    #[tokio::test(start_paused = true)]
    async fn unknown_deadline_is_generation_guarded_and_decremented_on_state_change() {
        let prometheus_registry = prometheus::Registry::new();
        let registry = ConnectionRegistry::with_transition_rate_limits(
            Arc::new(WsMetrics::new(&prometheus_registry)),
            Duration::from_secs(45),
            PresenceTransitionLimits {
                window: Duration::from_secs(10),
                per_connection: 12,
                per_uid: 20,
            },
        );
        let (entry, _rx) = registry.register(7, None).await;
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        assert!(crate::metrics::encode(&prometheus_registry)
            .expect("metrics render")
            .contains("ws_long_lived_unknown_connections 1"));

        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );
        assert!(crate::metrics::encode(&prometheus_registry)
            .expect("metrics render")
            .contains("ws_long_lived_unknown_connections 0"));
    }

    #[tokio::test]
    async fn heartbeat_handle_before_command_lane_entry_keeps_connection() {
        // Hold the command lane so the barrier fixes the ordering: the socket
        // task has recorded its HeartbeatHandle sample before the state command
        // can run, and prune must still keep the connection.
        let registry = Arc::new(registry());
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        entry.heartbeat.record_at(
            Instant::now()
                .checked_sub(Duration::from_secs(10))
                .expect("valid stale sample"),
            Utc::now().naive_utc(),
        );
        let lane = registry.state_lane_for(7);
        let lane_guard = lane.lock().await;
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let prune_registry = registry.clone();
        let prune_barrier = barrier.clone();
        let prune = tokio::spawn(async move {
            prune_barrier.wait().await;
            prune_registry.prune_stale(5).await;
        });

        barrier.wait().await;
        entry.heartbeat_handle().record();
        drop(lane_guard);
        prune.await.expect("prune task completes");

        assert!(slot_has_uid(&registry, 7));
        assert!(registry.should_suppress_push(7, 30));
    }

    #[tokio::test]
    async fn prune_deciding_before_the_ping_closes_the_revolving_connection() {
        // The second §6.5 interleaving: the prune pass reads freshness inside
        // the uid lane and decides stale while the connection's last heartbeat
        // is still old; the ping command that arrives only after the prune
        // decision gets NotFound from the command lane, which is the signal
        // for the handler to close the socket and reconnect.
        let registry = registry();
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        entry.heartbeat.record_at(
            Instant::now()
                .checked_sub(Duration::from_secs(120))
                .expect("valid stale sample"),
            Utc::now().naive_utc(),
        );

        // The prune decision (and removal) completes before the late ping
        // command enters the command lane: the sequential awaits fix the
        // interleaving deterministically.
        registry.prune_stale(5).await;
        assert!(
            !slot_has_uid(&registry, 7) || registry.slots.get(&7).unwrap().connections.is_empty(),
            "the stale connection is removed from the slot"
        );
        assert!(
            !registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Active))
                .await,
            "the late ping must be rejected so the handler closes the socket"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn debounce_expiry_before_reregister_publishes_offline_then_online() {
        // Order 1: the disconnect debounce expires before the reconnect
        // registers, so the user publishes offline and comes back online with
        // the new connection.
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(25),
        );
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        registry.remove_connection(7, entry.conn_id()).await;

        tokio::time::advance(Duration::from_secs(25)).await;
        tokio::task::yield_now().await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&false));

        let (_second, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));
    }

    #[tokio::test(start_paused = true)]
    async fn register_winning_the_race_against_debounce_expiry_stays_online() {
        // Order 2: the reconnect registers before the debounce deadline, so
        // the offline transition never publishes even when the deadline later
        // elapses.
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(25),
        );
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        registry.remove_connection(7, entry.conn_id()).await;

        tokio::time::advance(Duration::from_secs(10)).await;
        let (_second, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        tokio::time::advance(Duration::from_secs(15)).await;
        tokio::task::yield_now().await;

        assert_eq!(
            registry.online_flags(&[7]).get(&7),
            Some(&true),
            "the re-registered Active connection must keep the user online"
        );
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
    async fn ordinary_and_reconciliation_broadcasts_share_one_monotonic_sequence() {
        let registry = registry();
        let (_entry, mut rx) = registry.register(7, None).await;
        let broadcaster = broadcaster(&registry);

        let ordinary = broadcaster.clone();
        let revocation = broadcaster.clone();
        let ((), ()) = tokio::join!(
            ordinary.broadcast_exact(vec![7], 9, true, None),
            revocation.broadcast_revocation_exact(vec![7], 10),
        );

        let mut sequences = Vec::new();
        while sequences.len() < 2 {
            let message = rx.recv().await.expect("both presence events are delivered");
            if let ServerWsMessage::PresenceChanged(payload) = message.as_ref() {
                sequences.push(payload.sequence);
            }
        }
        assert_eq!(sequences, vec![1, 2]);
    }

    #[tokio::test]
    async fn explicit_inactive_does_not_enter_disconnect_debounce() {
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(60),
        );
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;

        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );

        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&false));
        assert!(!slot_of(&registry, 7).debouncing);
    }

    #[tokio::test]
    async fn prune_offline_does_not_enter_disconnect_debounce() {
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(60),
        );
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        entry.heartbeat.record_at(
            Instant::now()
                .checked_sub(Duration::from_secs(10))
                .expect("valid stale sample"),
            Utc::now().naive_utc(),
        );

        registry.prune_stale(5).await;

        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&false));
        assert!(!slot_of(&registry, 7).debouncing);
    }

    #[tokio::test(start_paused = true)]
    async fn pruning_a_counted_unknown_connection_refunds_the_gauge() {
        let prometheus_registry = prometheus::Registry::new();
        let registry = ConnectionRegistry::with_transition_rate_limits(
            Arc::new(WsMetrics::new(&prometheus_registry)),
            Duration::from_secs(45),
            PresenceTransitionLimits {
                window: Duration::from_secs(10),
                per_connection: 12,
                per_uid: 20,
            },
        );
        let (entry, _rx) = registry.register(7, None).await;
        // Let the Unknown deadline pass so the connection is counted, then
        // let the heartbeat go stale so prune removes it.
        tokio::time::advance(Duration::from_secs(120)).await;
        tokio::task::yield_now().await;
        assert!(crate::metrics::encode(&prometheus_registry)
            .expect("metrics render")
            .contains("ws_long_lived_unknown_connections 1"));

        // The recorded sample must actually look stale to the prune pass.
        entry.heartbeat.record_at(
            Instant::now()
                .checked_sub(Duration::from_secs(120))
                .expect("valid stale sample"),
            Utc::now().naive_utc(),
        );
        registry.prune_stale(90).await;
        assert!(!slot_has_uid(&registry, 7));
        assert!(crate::metrics::encode(&prometheus_registry)
            .expect("metrics render")
            .contains("ws_long_lived_unknown_connections 0"));
    }

    #[tokio::test]
    async fn reconciliation_revocation_evicts_a_closed_connection() {
        let registry = registry();
        let (_entry, rx) = registry.register(7, None).await;
        drop(rx);

        broadcaster(&registry)
            .broadcast_revocation_exact(vec![7], 9)
            .await;

        assert!(!slot_has_uid(&registry, 7));
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

        assert!(!slot_has_uid(&registry, 7));
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

        assert!(slot_has_uid(&registry, 7));
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
        assert!(!slot_has_uid(&registry, 7));
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
        assert!(!slot_has_uid(&registry, 7));
    }

    fn directed_facts(
        viewer_uid: i32,
        subject_uid: i32,
        was_visible: bool,
        is_visible: bool,
        last_seen_at: Option<NaiveDateTime>,
    ) -> social::DirectedPresenceReconciliation {
        social::DirectedPresenceReconciliation {
            viewer_uid,
            subject_uid,
            was_visible,
            is_visible,
            last_seen_at,
        }
    }

    async fn next_presence_change(
        rx: &mut mpsc::Receiver<Arc<ServerWsMessage>>,
    ) -> PresenceChangedPayload {
        loop {
            let Some(message) = rx.recv().await else {
                panic!("presence change was not delivered");
            };
            if let ServerWsMessage::PresenceChanged(payload) = message.as_ref() {
                return payload.clone();
            }
        }
    }

    /// Resolves once the channel is empty: every queued broadcast has been
    /// observed, so a subsequent presence assertion can rely on absence.
    async fn next_presence_change_opt(
        rx: &mut mpsc::Receiver<Arc<ServerWsMessage>>,
    ) -> Option<PresenceChangedPayload> {
        while let Ok(message) = rx.try_recv() {
            if let ServerWsMessage::PresenceChanged(payload) = message.as_ref() {
                return Some(payload.clone());
            }
        }
        None
    }

    async fn drain_messages(rx: &mut mpsc::Receiver<Arc<ServerWsMessage>>) {
        while rx.try_recv().is_ok() {}
    }

    #[tokio::test]
    async fn reserved_permit_delivers_revocation_even_after_the_request_future_drops() {
        let registry = registry();
        // The viewer stays connected so the revocation lands in its queue.
        let (_viewer, mut rx) = registry.register(9, None).await;

        // Reserving a permit and only sending it later models an HTTP request
        // whose database transaction already committed but whose future was
        // cancelled before the coordinator picked up the command: the permit
        // keeps the slot, so the command cannot be lost to a full channel.
        let permit = registry
            .reserve_reconciliation()
            .await
            .expect("coordinator accepts the reservation");
        let last_seen_at = chrono::DateTime::from_timestamp(1_700_000_000, 0)
            .expect("valid timestamp")
            .naive_utc();
        permit.send_social(social::PresencePairReconciliation {
            first_to_second: directed_facts(9, 7, true, false, Some(last_seen_at)),
            second_to_first: directed_facts(7, 9, false, false, None),
        });

        let payload = next_presence_change(&mut rx).await;
        assert_eq!(payload.uid, 7);
        assert!(!payload.online);
        assert_eq!(payload.last_seen_at, None);
    }

    #[tokio::test]
    async fn reserved_permit_delivers_a_visibility_snapshot_to_newly_visible_viewers() {
        let registry = registry();
        let (_viewer, mut rx) = registry.register(9, None).await;

        let permit = registry
            .reserve_reconciliation()
            .await
            .expect("coordinator accepts the reservation");
        let last_seen_at = chrono::DateTime::from_timestamp(1_700_000_000, 0)
            .expect("valid timestamp")
            .naive_utc();
        permit.send_visibility(social::PresenceVisibilityReconciliation {
            directions: vec![directed_facts(9, 7, false, true, Some(last_seen_at))],
        });

        let payload = next_presence_change(&mut rx).await;
        assert_eq!(payload.uid, 7);
        // Subject is offline in this test registry; offline snapshots carry
        // the transaction-time last-seen value, not null.
        assert!(!payload.online);
        assert_eq!(payload.last_seen_at, Some(last_seen_at.and_utc()));
    }

    /// §10: deleting a friend must revoke the presence the ex-friend could
    /// previously see, for both directions of the relationship.
    #[tokio::test]
    async fn friendship_removal_facts_revoke_presence_in_both_directions() {
        let registry = registry();
        let (_alice, mut alice_rx) = registry.register(1, None).await;
        let (_bob, mut bob_rx) = registry.register(2, None).await;

        let permit = registry
            .reserve_reconciliation()
            .await
            .expect("coordinator accepts the reservation");
        permit.send_social(social::PresencePairReconciliation {
            // Alice loses sight of Bob and vice versa: both were visible, now
            // neither is. Content is an empty offline snapshot, so it bypasses
            // the (new) block filter by construction.
            first_to_second: directed_facts(1, 2, true, false, None),
            second_to_first: directed_facts(2, 1, true, false, None),
        });

        let to_alice = next_presence_change(&mut alice_rx).await;
        assert_eq!(to_alice.uid, 2);
        assert!(!to_alice.online);
        assert_eq!(to_alice.last_seen_at, None);
        let to_bob = next_presence_change(&mut bob_rx).await;
        assert_eq!(to_bob.uid, 1);
        assert!(!to_bob.online);
        assert_eq!(to_bob.last_seen_at, None);
    }

    /// §10: blocking a friend must revoke the presence the blocker and the
    /// blocked used to see of each other, using the transaction-captured old
    /// eligibility rather than the new (blocking) relationship.
    #[tokio::test]
    async fn blocking_facts_revoke_presence_despite_the_new_block() {
        let registry = registry();
        let (_blocker, mut blocker_rx) = registry.register(1, None).await;
        let (_blocked, mut blocked_rx) = registry.register(2, None).await;

        let permit = registry
            .reserve_reconciliation()
            .await
            .expect("coordinator accepts the reservation");
        permit.send_social(social::PresencePairReconciliation {
            first_to_second: directed_facts(1, 2, true, false, None),
            second_to_first: directed_facts(2, 1, true, false, None),
        });

        // Both sides still receive exactly one revocation; nothing leaks the
        // real presence values.
        let to_blocker = next_presence_change(&mut blocker_rx).await;
        assert_eq!(to_blocker.uid, 2);
        assert!(!to_blocker.online);
        assert_eq!(to_blocker.last_seen_at, None);
        let to_blocked = next_presence_change(&mut blocked_rx).await;
        assert_eq!(to_blocked.uid, 1);
        assert!(!to_blocked.online);
        assert_eq!(to_blocked.last_seen_at, None);
    }

    /// §10: unblocking (or accepting a friend request) restores an authoritative
    /// snapshot built from the current published state, not from the facts'
    /// was/is flags alone.
    #[tokio::test]
    async fn unblocking_facts_deliver_a_fresh_online_snapshot() {
        let registry = registry();
        let (_viewer, mut viewer_rx) = registry.register(1, None).await;
        // The subject is a fresh Active connection, so the snapshot must say
        // online with a null last seen even though the facts carry an older
        // last-seen value.
        let (_subject, _subject_rx) = registry.register(2, Some(AppPresenceState::Active)).await;

        let permit = registry
            .reserve_reconciliation()
            .await
            .expect("coordinator accepts the reservation");
        permit.send_social(social::PresencePairReconciliation {
            // The pair became visible for the viewer: (false, true) triggers
            // the authoritative snapshot; the reverse direction was and stays
            // hidden, so it emits nothing.
            first_to_second: directed_facts(1, 2, false, true, None),
            second_to_first: directed_facts(2, 1, false, false, None),
        });

        let to_viewer = next_presence_change(&mut viewer_rx).await;
        assert_eq!(to_viewer.uid, 2);
        assert!(to_viewer.online);
        assert_eq!(to_viewer.last_seen_at, None);
    }

    /// §12 multi-connection matrix: with one Active and one Inactive
    /// connection, removing the Active one keeps the user online.
    #[tokio::test]
    async fn removing_the_only_active_connection_keeps_online_while_another_active_remains() {
        let registry = registry();
        let (active, _active_rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        let (inactive, _inactive_rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        assert!(
            registry
                .heartbeat(7, inactive.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );

        registry.remove_connection(7, active.conn_id()).await;
        assert_eq!(
            registry.online_flags(&[7]).get(&7),
            Some(&true),
            "the remaining Active connection keeps the user online"
        );
    }

    /// §12 multi-connection matrix: removing an Inactive connection while an
    /// Active one remains must not start the disconnect debounce nor flip the
    /// published state.
    #[tokio::test(start_paused = true)]
    async fn removing_an_inactive_connection_while_active_remains_does_not_debounce() {
        let registry = ConnectionRegistry::with_disconnect_debounce(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(25),
        );
        let (active, _active_rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        let (inactive, _inactive_rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        assert!(
            registry
                .heartbeat(7, inactive.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );

        registry.remove_connection(7, inactive.conn_id()).await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));
        assert!(!slot_of(&registry, 7).debouncing);
        let _ = active;

        // The debounce never fires for the surviving Active connection.
        tokio::time::advance(Duration::from_secs(25)).await;
        tokio::task::yield_now().await;
        assert_eq!(registry.online_flags(&[7]).get(&7), Some(&true));
    }

    /// §12 multi-connection matrix: pruning one of two connections where the
    /// surviving one is Active must not produce an offline transition.
    #[tokio::test(start_paused = true)]
    async fn pruning_a_stale_connection_keeps_online_when_another_stays_active() {
        let registry = ConnectionRegistry::with_transition_rate_limits(
            Arc::new(WsMetrics::new(&prometheus::Registry::new())),
            Duration::from_secs(25),
            PresenceTransitionLimits {
                window: Duration::from_secs(10),
                per_connection: 12,
                per_uid: 20,
            },
        );
        let (stale, _stale_rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        let (fresh, _fresh_rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        stale.heartbeat.record_at(
            Instant::now()
                .checked_sub(Duration::from_secs(120))
                .expect("valid stale sample"),
            Utc::now().naive_utc(),
        );
        // Keep the surviving connection's sample fresh: record at a fixed
        // offset relative to now.
        fresh
            .heartbeat
            .record_at(Instant::now(), Utc::now().naive_utc());

        registry.prune_stale(90).await;
        assert_eq!(
            registry.online_flags(&[7]).get(&7),
            Some(&true),
            "the surviving Active connection keeps the user published online"
        );
    }

    #[tokio::test]
    async fn reserve_reconciliation_fails_once_the_coordinator_stops() {
        // A registry whose command channel has no live coordinator sender
        // models the coordinator having exited: reserving must fail with a
        // service error instead of accepting a command nobody will process.
        let mut registry = registry();
        let (dead_tx, dead_rx) = mpsc::channel(1);
        registry.command_tx = dead_tx;
        drop(dead_rx);

        let error = registry
            .reserve_reconciliation()
            .await
            .expect_err("coordinator channel is closed");
        assert!(matches!(
            error,
            crate::errors::AppError::ServiceUnavailable(_)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn metric_audit_resets_incremental_gauge_drift_and_alerts() {
        let prometheus_registry = prometheus::Registry::new();
        let registry = ConnectionRegistry::with_transition_rate_limits(
            Arc::new(WsMetrics::new(&prometheus_registry)),
            Duration::from_secs(45),
            PresenceTransitionLimits {
                window: Duration::from_secs(10),
                per_connection: 12,
                per_uid: 20,
            },
        );
        let (entry, _rx) = registry.register(7, Some(AppPresenceState::Active)).await;
        assert!(
            registry
                .heartbeat(7, entry.conn_id(), Some(AppPresenceState::Inactive))
                .await
        );
        registry.register(8, Some(AppPresenceState::Active)).await;

        // Simulate a lost increment: the incremental total drops below the
        // real registry content without a matching state command, so the
        // published gauge (still derived from the last command) disagrees
        // with the incremental total the next command would publish.
        registry
            .inactive_connections_total
            .fetch_sub(1, Ordering::Relaxed);
        let drift_render = crate::metrics::encode(&prometheus_registry).expect("metrics render");
        assert!(drift_render.contains("ws_inactive_connections 1"));
        assert!(!drift_render.contains("ws_presence_metrics_drift_total 1"));

        registry.audit_metrics().await;

        let rendered = crate::metrics::encode(&prometheus_registry).expect("metrics render");
        assert!(rendered.contains("ws_inactive_connections 1"));
        assert!(rendered.contains("ws_presence_metrics_drift_total 1"));
        assert!(rendered.contains("ws_connected_users 2"));
    }
}
