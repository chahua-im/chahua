//! WebSocket connection registry: maps user id to active connections, tracks app presence,
//! supports broadcast and stale-connection pruning.

mod metrics;
pub use metrics::WsMetrics;

use crate::dto::ws::{OnlineClientStatus, PresenceUpdatePayload, ServerWsMessage};
use crate::services::client_tracking::LastSeen;
use crate::services::message_sync::SyncSubscription;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

pub const STALE_CONNECTION_TIMEOUT_SECS: u64 = 300;
const AWAY_TIMEOUT_SECS: u64 = 300;
const PRESENCE_FRESHNESS_SECS: u64 = 60;

#[derive(Default)]
struct UserPresence {
    connections: HashMap<u64, PresenceConnection>,
    last_end: Option<u64>,
}

#[derive(Default)]
struct PresenceConnection {
    active: bool,
    last_ping: u64,
    last_active: u64,
    away: bool,
}

impl UserPresence {
    fn expire(&mut self, now: u64) -> Option<u64> {
        let mut end = None;
        for connection in self.connections.values_mut() {
            if connection.active
                && now.saturating_sub(connection.last_ping) >= PRESENCE_FRESHNESS_SECS
            {
                connection.active = false;
                connection.away = false;
                let expired = connection.last_ping.saturating_add(PRESENCE_FRESHNESS_SECS);
                end = Some(end.map_or(expired, |previous: u64| previous.max(expired)));
            }
        }
        if self
            .connections
            .values()
            .any(|connection| connection.active)
        {
            None
        } else {
            if let Some(end) = end {
                self.last_end = Some(end);
            }
            end
        }
    }

    fn state(&self, now: u64, entries: &[Arc<ConnectionEntry>]) -> Option<AppPresenceState> {
        let open = entries
            .iter()
            .filter(|entry| !entry.tx.is_closed())
            .filter_map(|entry| self.connections.get(&entry.conn_id));
        let mut away = false;
        for connection in open {
            if connection.active {
                return Some(AppPresenceState::Active);
            }
            away |= connection.away
                && now.saturating_sub(connection.last_ping) < PRESENCE_FRESHNESS_SECS
                && now.saturating_sub(connection.last_active) < AWAY_TIMEOUT_SECS;
        }
        away.then_some(AppPresenceState::Inactive)
    }
}

fn record_observation(observer: &OnceLock<Arc<LastSeen>>, uid: i32, at: u64) {
    if let (Some(observer), Ok(seconds)) = (observer.get(), i64::try_from(at)) {
        if let Some(at) = chrono::DateTime::from_timestamp(seconds, 0) {
            observer.record(uid, at.naive_utc());
        }
    }
}

fn record_end(observer: &OnceLock<Arc<LastSeen>>, uid: i32, at: u64) {
    if let (Some(observer), Ok(seconds)) = (observer.get(), i64::try_from(at)) {
        if let Some(at) = chrono::DateTime::from_timestamp(seconds, 0) {
            observer.record_end(uid, at.naive_utc());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AppPresenceState {
    Active = 1,
    Inactive = 2,
}

impl From<OnlineClientStatus> for AppPresenceState {
    fn from(status: OnlineClientStatus) -> Self {
        match status {
            OnlineClientStatus::Active => Self::Active,
            OnlineClientStatus::Inactive => Self::Inactive,
        }
    }
}

impl AppPresenceState {
    const fn from_u8(value: u8) -> Self {
        match value {
            x if x == Self::Inactive as u8 => Self::Inactive,
            _ => Self::Active,
        }
    }
}

/// Per-connection state: sender to push messages to the socket task, last ping time for timeout.
pub struct ConnectionEntry {
    pub conn_id: u64,
    pub client_id: String,
    pub message_sync: Option<Arc<SyncSubscription>>,
    pub tx: mpsc::Sender<Arc<ServerWsMessage>>,
    /// Sticky, coalescing invalidation independent of the lossy ordinary-event queue.
    pub unread_changed: Arc<tokio::sync::Notify>,
    pub states_changed: Arc<tokio::sync::Notify>,
    /// A dropped ordinary event requires reconnect calibration.
    pub lagged: tokio::sync::Notify,
    /// Unix timestamp (seconds) when we last received a ping from the client.
    pub last_ping_at: AtomicU64,
    /// Unix timestamp (seconds) when the app last transitioned from active to inactive, packed
    /// with the current app state so presence readers never observe a mismatched pair.
    state_and_last_transition_at: AtomicU64,
    uid: i32,
    presence: Arc<Mutex<UserPresence>>,
    last_seen: Arc<OnceLock<Arc<LastSeen>>>,
}

impl ConnectionEntry {
    pub fn update_ping(&self, state: AppPresenceState) {
        self.update_app_state(state);
    }

    pub fn update_app_state(&self, state: AppPresenceState) {
        self.update_app_state_at(state, now_secs());
    }

    fn update_app_state_at(&self, state: AppPresenceState, now: u64) {
        let mut presence = self.presence.lock().unwrap();
        if let Some(end) = presence.expire(now) {
            record_end(&self.last_seen, self.uid, end);
        }
        let was_active = presence
            .connections
            .values()
            .any(|connection| connection.active);
        if let Some(connection) = presence.connections.get_mut(&self.conn_id) {
            connection.last_ping = now;
            if state == AppPresenceState::Active {
                connection.active = true;
                connection.last_active = now;
                connection.away = false;
                record_observation(&self.last_seen, self.uid, now);
            } else {
                connection.away |= connection.active;
                connection.active = false;
            }
        }
        if was_active
            && !presence
                .connections
                .values()
                .any(|connection| connection.active)
        {
            presence.last_end = Some(now);
            record_end(&self.last_seen, self.uid, now);
        }
        self.last_ping_at.store(now, Ordering::Relaxed);
        let mut current = self.state_and_last_transition_at.load(Ordering::Relaxed);
        loop {
            let (previous_state, _) = Self::unpack_state(current);
            let transition_at = if previous_state == AppPresenceState::Active
                && state == AppPresenceState::Inactive
            {
                now
            } else if state == AppPresenceState::Active {
                0
            } else {
                Self::unpack_state(current).1
            };
            let next = Self::pack_state(state, transition_at);
            match self.state_and_last_transition_at.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return,
                Err(observed) => current = observed,
            }
        }
    }

    fn app_state(&self) -> AppPresenceState {
        self.state_and_last_transition_at().0
    }

    fn state_and_last_transition_at(&self) -> (AppPresenceState, u64) {
        Self::unpack_state(self.state_and_last_transition_at.load(Ordering::Relaxed))
    }

    const fn pack_state(state: AppPresenceState, transition_at: u64) -> u64 {
        (transition_at << 8) | state as u64
    }

    const fn unpack_state(value: u64) -> (AppPresenceState, u64) {
        (AppPresenceState::from_u8(value as u8), value >> 8)
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
    last_seen: Arc<OnceLock<Arc<LastSeen>>>,
}

impl ConnectionRegistry {
    pub fn new(metrics: Arc<WsMetrics>) -> Self {
        Self {
            inner: dashmap::DashMap::new(),
            metrics,
            last_seen: Arc::new(OnceLock::new()),
        }
    }

    /// Attach the shared batched activity observer.
    pub fn set_last_seen(&self, last_seen: Arc<LastSeen>) {
        let _ = self.last_seen.set(last_seen);
    }

    /// Register a new connection for the authenticated user and client. Returns the entry (to
    /// update last_ping_at) and the receiver for the send task. Caller must call
    /// `remove_connection(uid, conn_id)` when the socket closes.
    pub fn register(
        &self,
        uid: i32,
        client_id: String,
    ) -> (Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>) {
        self.register_inner(uid, client_id, None)
    }

    pub fn register_sync(
        &self,
        uid: i32,
        client_id: String,
    ) -> (Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>) {
        self.register_inner(uid, client_id, Some(Arc::new(SyncSubscription::default())))
    }

    fn register_inner(
        &self,
        uid: i32,
        client_id: String,
        message_sync: Option<Arc<SyncSubscription>>,
    ) -> (Arc<ConnectionEntry>, mpsc::Receiver<Arc<ServerWsMessage>>) {
        let conn_id = next_conn_id();
        let (tx, rx) = mpsc::channel(256);
        let now = now_secs();
        let mut connections = self.inner.entry(uid).or_default();
        let presence = connections
            .first()
            .map(|entry| entry.presence.clone())
            .unwrap_or_else(|| Arc::new(Mutex::new(UserPresence::default())));
        presence
            .lock()
            .unwrap()
            .connections
            .insert(conn_id, PresenceConnection::default());
        let entry = Arc::new(ConnectionEntry {
            conn_id,
            client_id,
            tx,
            message_sync,
            unread_changed: Arc::new(tokio::sync::Notify::new()),
            states_changed: Arc::new(tokio::sync::Notify::new()),
            lagged: tokio::sync::Notify::new(),
            uid,
            presence,
            last_seen: self.last_seen.clone(),
            last_ping_at: AtomicU64::new(now),
            state_and_last_transition_at: AtomicU64::new(ConnectionEntry::pack_state(
                AppPresenceState::Inactive,
                0,
            )),
        });
        connections.push(entry.clone());
        drop(connections);
        self.metrics.record_connection_open();
        self.update_metrics();
        self.broadcast_presence_to_user(uid);
        (entry, rx)
    }

    /// Remove a single connection. Call when the socket closes.
    pub fn remove_connection(&self, uid: i32, conn_id: u64) {
        if let dashmap::mapref::entry::Entry::Occupied(mut entry) = self.inner.entry(uid) {
            if let Some(connection) = entry
                .get()
                .iter()
                .find(|connection| connection.conn_id == conn_id)
            {
                let now = now_secs();
                let mut presence = connection.presence.lock().unwrap();
                if let Some(end) = presence.expire(now) {
                    record_end(&self.last_seen, uid, end);
                }
                let removed_active = presence
                    .connections
                    .remove(&conn_id)
                    .is_some_and(|connection| connection.active);
                if removed_active
                    && !presence
                        .connections
                        .values()
                        .any(|connection| connection.active)
                {
                    presence.last_end = Some(now);
                    for connection in presence.connections.values_mut() {
                        connection.away = false;
                    }
                    record_end(&self.last_seen, uid, now);
                }
            }
            entry.get_mut().retain(|connection| {
                if connection.conn_id == conn_id {
                    if let Some(subscription) = &connection.message_sync {
                        subscription.close();
                    }
                    false
                } else {
                    true
                }
            });
            if entry.get().is_empty() {
                entry.remove();
            }
        }
        self.update_metrics();
        self.broadcast_presence_to_user(uid);
    }

    /// Broadcast a JSON string to all connections for the given user ids. Each uid may have multiple connections.
    /// A full buffer signals the socket to disconnect; its owner removes the connection.
    pub fn broadcast_to_uids(&self, uids: &[i32], message: Arc<ServerWsMessage>) {
        if matches!(
            &*message,
            ServerWsMessage::ReactionUpdated(_)
                | ServerWsMessage::Message(_)
                | ServerWsMessage::MessageUpdated(_)
                | ServerWsMessage::MessageDeleted(_)
                | ServerWsMessage::MessagesBulkDeleted(_)
                | ServerWsMessage::ThreadUpdate(_)
                | ServerWsMessage::ThreadMembershipChanged(_)
                | ServerWsMessage::ChatMembershipChanged(_)
                | ServerWsMessage::ChatArchiveStateChanged(_)
                | ServerWsMessage::NotificationExceptionsCleared(_)
                | ServerWsMessage::NotificationSettingsChanged(_)
                | ServerWsMessage::ChatNotificationSettingChanged(_)
                | ServerWsMessage::FriendRequestResolved(_)
                | ServerWsMessage::FriendshipRemoved(_)
                | ServerWsMessage::Notification(_)
        ) {
            self.invalidate_unread(uids);
        }
        let msg_type = message.message_type();
        let (sync_chat, suppress_sync) = match &*message {
            ServerWsMessage::Message(payload)
            | ServerWsMessage::MessageUpdated(payload)
            | ServerWsMessage::MessageDeleted(payload) => (Some(payload.chat_id), true),
            ServerWsMessage::MessagesBulkDeleted(payload) => (payload.chat_id.parse().ok(), true),
            ServerWsMessage::ReactionUpdated(payload) => (Some(payload.chat_id), true),
            ServerWsMessage::ThreadUpdate(payload) => (Some(payload.chat_id), false),
            ServerWsMessage::MembershipMessagePolicyChanged(payload) => {
                (Some(payload.chat_id), false)
            }
            _ => (None, false),
        };
        // Replay must advance even for members excluded from the legacy
        // recipient list, such as members who cannot see an announcement.
        if let Some(chat_id) = sync_chat {
            for entries in self.inner.iter() {
                for entry in entries.value() {
                    if let Some(subscription) = &entry.message_sync {
                        subscription.mark_if_attached(chat_id);
                    }
                }
            }
        }
        for &uid in uids {
            if let Some(vec) = self.inner.get(&uid) {
                for entry in vec.iter() {
                    if let Some(subscription) = &entry.message_sync {
                        if let ServerWsMessage::ChatMembershipChanged(payload) = &*message {
                            subscription.mark(payload.chat_id);
                        }
                        if matches!(&*message, ServerWsMessage::ChatSettingsChanged(_)) {
                            subscription.mark_attached();
                        }
                        if suppress_sync {
                            continue;
                        }
                    }
                    if entry.tx.try_send(message.clone()).is_err() {
                        tracing::warn!(
                            uid,
                            conn_id = entry.conn_id,
                            "ws broadcast queue rejected message; reconnect required"
                        );
                        self.metrics.record_message_dropped(msg_type);
                        entry.lagged.notify_one();
                    } else {
                        self.metrics.record_message_pushed(msg_type);
                    }
                }
            }
        }
    }

    /// Wake only the specified users' sync connections after a committed membership change.
    pub fn wake_message_sync(&self, uids: &[i32], chat_id: i64) {
        for uid in uids {
            if let Some(entries) = self.inner.get(uid) {
                for entry in entries.iter() {
                    if let Some(subscription) = &entry.message_sync {
                        subscription.mark(chat_id);
                    }
                }
            }
        }
    }

    /// Refresh collection/app badges without reloading watched message visibility.
    pub fn invalidate_unread_counts(&self, uids: &[i32]) {
        for uid in uids {
            if let Some(entries) = self.inner.get(uid) {
                for entry in entries.iter() {
                    entry.unread_changed.notify_one();
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
                    entry.states_changed.notify_one();
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

    /// Returns whether the user has a fresh active connection.
    pub fn is_online(&self, uid: i32) -> bool {
        self.is_online_at(uid, now_secs())
    }

    /// Aggregates personal presence across fresh connections; active wins over away.
    pub fn personal_presence(&self, uid: i32) -> Option<AppPresenceState> {
        self.personal_presence_at(uid, now_secs())
    }

    fn personal_presence_at(&self, uid: i32, now: u64) -> Option<AppPresenceState> {
        let entries = self.inner.get(&uid)?;
        let mut presence = entries.first()?.presence.lock().unwrap();
        if let Some(end) = presence.expire(now) {
            record_end(&self.last_seen, uid, end);
        }
        presence.state(now, &entries)
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
        self.personal_presence_at(uid, now) == Some(AppPresenceState::Active)
    }

    /// Active-period end observed while this user has a registered connection.
    pub fn active_period_end(&self, uid: i32) -> Option<chrono::NaiveDateTime> {
        let entries = self.inner.get(&uid)?;
        let mut presence = entries.first()?.presence.lock().unwrap();
        if let Some(end) = presence.expire(now_secs()) {
            record_end(&self.last_seen, uid, end);
        }
        chrono::DateTime::from_timestamp(i64::try_from(presence.last_end?).ok()?, 0)
            .map(|at| at.naive_utc())
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
        for (uid, conn_ids) in uids_to_trim {
            for conn_id in conn_ids {
                self.remove_connection(uid, conn_id);
            }
        }
        // Resolve silent expiry even for connections retained for transport liveness.
        for entry in self.inner.iter() {
            let mut presence = entry[0].presence.lock().unwrap();
            if let Some(end) = presence.expire(now) {
                record_end(&self.last_seen, *entry.key(), end);
            }
        }
        self.update_metrics();
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
mod tests;
