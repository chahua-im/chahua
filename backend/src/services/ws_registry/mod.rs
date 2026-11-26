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
mod tests {
    use super::*;

    fn registry() -> ConnectionRegistry {
        ConnectionRegistry::new(Arc::new(WsMetrics::new(&prometheus::Registry::new())))
    }

    #[tokio::test]
    async fn sync_connections_wake_without_legacy_message_frames_and_close_on_removal() {
        let registry = registry();
        let (_legacy, mut legacy_rx) = registry.register(7, "legacy".into());
        let (sync, mut sync_rx) = registry.register_sync(7, "sync".into());
        let subscription = sync.message_sync.as_ref().unwrap();
        subscription.attach([42]);
        let (hidden, mut hidden_rx) = registry.register_sync(8, "hidden".into());
        let hidden_subscription = hidden.message_sync.as_ref().unwrap();
        hidden_subscription.attach([42]);
        while legacy_rx.try_recv().is_ok() {}
        while sync_rx.try_recv().is_ok() {}
        while hidden_rx.try_recv().is_ok() {}

        registry.broadcast_to_uids(
            &[7],
            Arc::new(ServerWsMessage::ReactionUpdated(
                crate::dto::ws::ReactionUpdatePayload {
                    message_id: 1,
                    chat_id: 42,
                    reactions: vec![],
                },
            )),
        );
        assert!(matches!(
            &*legacy_rx.try_recv().unwrap(),
            ServerWsMessage::ReactionUpdated(_)
        ));
        assert!(sync_rx.try_recv().is_err());
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            subscription.notified(),
        )
        .await
        .unwrap();
        assert!(hidden_rx.try_recv().is_err());
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            hidden_subscription.notified(),
        )
        .await
        .unwrap();

        crate::services::chat::publish_membership_changed(&registry, 7, 43);
        assert!(matches!(
            &*legacy_rx.try_recv().unwrap(),
            ServerWsMessage::ChatMembershipChanged(_)
        ));
        assert!(matches!(
            &*sync_rx.try_recv().unwrap(),
            ServerWsMessage::ChatMembershipChanged(_)
        ));
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            subscription.notified(),
        )
        .await
        .unwrap();

        registry.remove_connection(7, sync.conn_id);
        assert!(subscription.is_closed());
        let (stale, _rx) = registry.register_sync(8, "stale".into());
        stale.last_ping_at.store(0, Ordering::Relaxed);
        registry.prune_stale(1);
        assert!(stale.message_sync.as_ref().unwrap().is_closed());
    }

    #[tokio::test]
    async fn chat_membership_event_reaches_only_the_members_devices_without_a_message() {
        let registry = registry();
        let (first, mut first_rx) = registry.register(7, "first".into());
        let (second, mut second_rx) = registry.register(7, "second".into());
        let (_, mut other_rx) = registry.register(8, "other".into());
        for rx in [&mut first_rx, &mut second_rx, &mut other_rx] {
            while rx.try_recv().is_ok() {}
        }

        crate::services::chat::publish_membership_changed(&registry, 7, 9_007_199_254_740_993);

        for rx in [&mut first_rx, &mut second_rx] {
            let event = rx.try_recv().unwrap();
            assert_eq!(event.message_type(), "chatMembershipChanged");
            assert_eq!(
                serde_json::to_value(&*event).unwrap(),
                serde_json::json!({
                    "type": "chatMembershipChanged",
                    "payload": { "chatId": "9007199254740993" }
                })
            );
            assert!(rx.try_recv().is_err());
        }
        assert!(other_rx.try_recv().is_err());
        for entry in [first, second] {
            for changed in [&entry.unread_changed, &entry.states_changed] {
                tokio::time::timeout(std::time::Duration::from_millis(50), changed.notified())
                    .await
                    .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn notification_preferences_reach_only_the_owners_devices_and_refresh_unread() {
        use crate::dto::{
            groups::ChatNotificationSettingResponse, users::NotificationSettingsResponse,
        };
        let registry = registry();
        let (first, mut rx1) = registry.register(7, "a".into());
        let (second, mut rx2) = registry.register(7, "b".into());
        let (_, mut other) = registry.register(8, "other".into());
        while rx1.try_recv().is_ok() {}
        while rx2.try_recv().is_ok() {}
        while other.try_recv().is_ok() {}
        registry.broadcast_to_uids(
            &[7],
            Arc::new(ServerWsMessage::NotificationSettingsChanged(
                NotificationSettingsResponse {
                    mute_group_chats_by_default: true,
                    mute_direct_chats_by_default: false,
                },
            )),
        );
        crate::services::notification_preferences::publish_chat_notification_setting(
            &registry,
            7,
            ChatNotificationSettingResponse {
                chat_id: 42,
                kind: crate::models::GroupKind::Group,
                archived: false,
                muted_until: None,
                mute_override: Some(false),
                is_muted: false,
            },
        );
        for rx in [&mut rx1, &mut rx2] {
            assert!(matches!(
                &*rx.try_recv().unwrap(),
                ServerWsMessage::NotificationSettingsChanged(_)
            ));
            assert!(matches!(
                &*rx.try_recv().unwrap(),
                ServerWsMessage::ChatArchiveStateChanged(_)
            ));
            let snapshot = rx.try_recv().unwrap();
            assert!(
                matches!(&*snapshot, ServerWsMessage::ChatNotificationSettingChanged(setting) if setting.mute_override == Some(false) && !setting.is_muted)
            );
            let value = serde_json::to_value(&*snapshot).unwrap();
            assert_eq!(value["payload"]["chatId"], "42");
            assert!(value["payload"]["mutedUntil"].is_null());
            assert_eq!(value["payload"]["muteOverride"], false);
        }
        registry.broadcast_to_uids(
            &[7],
            Arc::new(ServerWsMessage::NotificationExceptionsCleared(
                crate::dto::groups::NotificationExceptionsCleared {
                    kind: crate::models::GroupKind::Group,
                    chat_ids: vec!["9007199254740993".into()],
                },
            )),
        );
        for rx in [&mut rx1, &mut rx2] {
            let event = rx.try_recv().unwrap();
            let value = serde_json::to_value(&*event).unwrap();
            assert_eq!(value["type"], "notificationExceptionsCleared");
            assert_eq!(value["payload"]["chatIds"][0], "9007199254740993");
            assert!(rx.try_recv().is_err());
        }
        assert!(other.try_recv().is_err());
        for entry in [first, second] {
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                entry.unread_changed.notified(),
            )
            .await
            .unwrap();
        }
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
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            first.lagged.notified(),
        )
        .await
        .unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            second.lagged.notified()
        )
        .await
        .is_err());
        for entry in [&first, &second] {
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                entry.states_changed.notified(),
            )
            .await
            .unwrap();
        }
        registry.invalidate_unread(&[7]);
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            first.unread_changed.notified(),
        )
        .await
        .unwrap();
    }

    #[test]
    fn personal_away_expires_at_five_minutes_despite_inactive_reports() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client-a".into());

        entry.update_app_state_at(AppPresenceState::Active, 1_000);
        entry.update_app_state_at(AppPresenceState::Inactive, 1_050);
        for at in [1_100, 1_150, 1_200, 1_250, 1_299] {
            entry.update_app_state_at(AppPresenceState::Inactive, at);
        }
        assert_eq!(
            entry.state_and_last_transition_at(),
            (AppPresenceState::Inactive, 1_050)
        );
        assert_eq!(
            registry.personal_presence_at(7, 1_299),
            Some(AppPresenceState::Inactive)
        );
        entry.update_app_state_at(AppPresenceState::Inactive, 1_300);
        assert_eq!(registry.personal_presence_at(7, 1_300), None);
    }

    #[test]
    fn expired_away_connection_stays_live_without_suppressing_push() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client-a".into());
        let now = now_secs();
        entry.update_app_state_at(AppPresenceState::Active, now - AWAY_TIMEOUT_SECS - 1);
        entry.update_app_state_at(AppPresenceState::Inactive, now - AWAY_TIMEOUT_SECS);

        entry.update_ping(AppPresenceState::Inactive);

        assert_eq!(registry.personal_presence(7), None);
        assert_eq!(registry.count_online(&[7]), 0);
        assert!(!registry.should_suppress_push(7, 30));
    }

    #[test]
    fn personal_presence_prefers_active_device_over_away_device() {
        let registry = registry();
        let (away, _away_rx) = registry.register(7, "away".into());
        away.update_app_state_at(AppPresenceState::Active, 100);
        away.update_app_state_at(AppPresenceState::Inactive, 150);
        let (active, _active_rx) = registry.register(7, "active".into());
        active.update_app_state_at(AppPresenceState::Active, 180);
        assert_eq!(
            registry.personal_presence_at(7, 180),
            Some(AppPresenceState::Active)
        );
        away.update_app_state_at(AppPresenceState::Inactive, 230);
        assert_eq!(
            registry.personal_presence_at(7, 239),
            Some(AppPresenceState::Active)
        );
        assert_eq!(
            registry.personal_presence_at(7, 240),
            Some(AppPresenceState::Inactive)
        );
        assert_eq!(away.presence.lock().unwrap().last_end, Some(240));
    }

    #[test]
    fn initial_or_reconnected_inactive_connection_has_no_personal_away_grace() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client-a".into());

        entry.update_app_state_at(AppPresenceState::Inactive, 1_000);
        assert_eq!(registry.personal_presence_at(7, 1_000), None);

        entry.update_app_state_at(AppPresenceState::Active, 1_010);
        entry.update_app_state_at(AppPresenceState::Inactive, 1_020);
        assert_eq!(
            registry.personal_presence_at(7, 1_020),
            Some(AppPresenceState::Inactive)
        );
        registry.remove_connection(7, entry.conn_id);

        let (reconnected, _reconnected_rx) = registry.register(7, "client-a".into());
        reconnected.update_app_state_at(AppPresenceState::Inactive, 1_100);
        assert_eq!(registry.personal_presence_at(7, 1_100), None);
    }

    #[test]
    fn last_active_disconnect_cancels_other_devices_away() {
        let registry = registry();
        let (away, _away_rx) = registry.register(7, "away".into());
        let (active, _active_rx) = registry.register(7, "active".into());
        away.update_ping(AppPresenceState::Active);
        away.update_ping(AppPresenceState::Inactive);
        active.update_ping(AppPresenceState::Active);
        registry.remove_connection(7, active.conn_id);
        assert_eq!(registry.personal_presence(7), None);
        away.update_ping(AppPresenceState::Inactive);
        assert_eq!(registry.personal_presence(7), None);
        assert!(registry.active_period_end(7).is_some());
    }

    #[test]
    fn silent_expiry_ends_at_freshness_deadline_and_cannot_become_away() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client".into());
        entry.update_app_state_at(AppPresenceState::Active, 1_000);
        assert_eq!(
            registry.personal_presence_at(7, 1_059),
            Some(AppPresenceState::Active)
        );
        assert_eq!(registry.personal_presence_at(7, 1_060), None);
        assert_eq!(entry.presence.lock().unwrap().last_end, Some(1_060));
        entry.update_app_state_at(AppPresenceState::Inactive, 1_061);
        assert_eq!(registry.personal_presence_at(7, 1_061), None);
        assert_eq!(entry.presence.lock().unwrap().last_end, Some(1_060));
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
        first.update_ping(AppPresenceState::Active);
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
        surviving.update_ping(AppPresenceState::Active);

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
    fn presence_is_offline_for_a_fresh_background_connection() {
        let registry = registry();
        let (entry, _rx) = registry.register(7, "client-a".to_string());
        entry.update_app_state(AppPresenceState::Inactive);

        assert!(!registry.is_online(7));
    }

    #[test]
    fn presence_is_online_when_any_device_is_fresh() {
        let registry = registry();
        let (stale, _stale_rx) = registry.register(7, "client-a".to_string());
        stale.update_app_state_at(AppPresenceState::Active, now_secs().saturating_sub(61));
        let (fresh, _fresh_rx) = registry.register(7, "client-b".to_string());
        fresh.update_ping(AppPresenceState::Active);
        assert!(registry.is_online(7));
        fresh.update_ping(AppPresenceState::Inactive);
        assert!(!registry.is_online(7));
    }

    #[test]
    fn group_online_count_counts_users_not_devices_and_excludes_dead_connections() {
        let registry = registry();
        let (first, _first_rx) = registry.register(7, "first".into());
        first.update_ping(AppPresenceState::Active);
        let (second, second_rx) = registry.register(7, "second".into());
        second.update_app_state(AppPresenceState::Inactive);
        second.update_ping(AppPresenceState::Active);
        let (stale, _stale_rx) = registry.register(8, "stale".into());
        stale.update_app_state_at(AppPresenceState::Active, now_secs().saturating_sub(61));
        let (_closed, closed_rx) = registry.register(9, "closed".into());
        _closed.update_ping(AppPresenceState::Active);
        drop(closed_rx);

        assert_eq!(registry.count_online(&[7, 8, 9, 10]), 1);

        registry.remove_connection(7, first.conn_id);
        assert_eq!(registry.count_online(&[7, 8, 9, 10]), 1);

        drop(second_rx);
        assert_eq!(registry.count_online(&[7, 8, 9, 10]), 0);
    }
}
