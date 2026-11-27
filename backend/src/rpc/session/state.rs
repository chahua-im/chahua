use std::sync::Arc;

use tokio::{
    sync::{mpsc, watch, Mutex},
    time::Instant,
};

use crate::{
    dto::ws::ServerWsMessage,
    services::{
        auth_token::VerifiedSession,
        message_sync::{ReplayService, SyncDriver},
        presence::PresenceWatch,
        unread,
        ws_registry::ConnectionEntry,
    },
};

use super::super::{
    error::{RpcError, RpcErrorCode, RpcLifecycleFailure},
    protocol::RpcId,
    AppState, RpcCallContext,
};
use super::{
    controls::RpcControlCommand,
    io::{RpcOutputSink, RpcSessionCloser, TransportState},
    ANONYMOUS_SESSION_TIMEOUT,
};

#[derive(Clone)]
pub(super) struct VersionedPresenceWatch {
    pub(super) generation: u64,
    pub(super) watch: PresenceWatch,
}

pub(super) struct BoundSession {
    pub(super) session: Arc<VerifiedSession>,
    pub(super) entry: Arc<ConnectionEntry>,
    pub(super) registry_events: Option<mpsc::Receiver<Arc<ServerWsMessage>>>,
    pub(super) presence_subscription: watch::Sender<Option<VersionedPresenceWatch>>,
    pub(super) presence_receiver: Option<watch::Receiver<Option<VersionedPresenceWatch>>>,
    pub(super) unread_subscription: watch::Sender<Option<unread::watch::UnreadWatch>>,
    pub(super) unread_receiver: Option<watch::Receiver<Option<unread::watch::UnreadWatch>>>,
    pub(super) states_subscription: watch::Sender<Option<unread::states::StateWatch>>,
    pub(super) states_receiver: Option<watch::Receiver<Option<unread::states::StateWatch>>>,
    pub(super) sync_driver: Option<Arc<Mutex<SyncDriver>>>,
}

pub(super) struct SessionState {
    pub(super) opened: bool,
    pub(super) accepting: bool,
    pub(super) lifecycle_notified: bool,
    pub(super) anonymous_until: Option<Instant>,
    pub(super) anonymous_app_version: Option<String>,
    pub(super) bound: Option<BoundSession>,
    pub(super) activated: bool,
    next_watch_generation: u64,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            opened: false,
            accepting: true,
            lifecycle_notified: false,
            anonymous_until: None,
            anonymous_app_version: None,
            bound: None,
            activated: false,
            next_watch_generation: 0,
        }
    }
}

pub(super) struct SessionShared {
    pub(super) state: Mutex<SessionState>,
    pub(super) event_gate: Mutex<()>,
    pub(super) transport: Arc<TransportState>,
}

impl SessionShared {
    pub(super) fn new(transport: Arc<TransportState>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SessionState::default()),
            event_gate: Mutex::new(()),
            transport,
        })
    }

    pub(super) async fn call_context(
        &self,
        controls: mpsc::Sender<RpcControlCommand>,
        rpc_id: Option<RpcId>,
        guard_failures: mpsc::UnboundedSender<RpcLifecycleFailure>,
    ) -> Option<RpcCallContext> {
        if self.transport.is_closed() {
            return None;
        }
        let state = self.state.lock().await;
        (state.accepting && !self.transport.is_closed()).then(|| RpcCallContext {
            // Do not admit authenticated operations until the successful
            // handshake reply has been queued ahead of registry events.
            session: state
                .activated
                .then(|| state.bound.as_ref().map(|bound| bound.session.clone()))
                .flatten(),
            connection_id: state.bound.as_ref().map_or(0, |bound| bound.entry.conn_id),
            rpc_id,
            controls,
            message_sync_enabled: state.activated
                && state
                    .bound
                    .as_ref()
                    .is_some_and(|bound| bound.sync_driver.is_some()),
            sync_control: None,
            guard_failures: Some(guard_failures),
            close_session: Some(RpcSessionCloser {
                state: self.transport.clone(),
            }),
        })
    }

    pub(super) async fn opened(&self) -> bool {
        self.state.lock().await.opened
    }

    pub(super) async fn anonymous_expired(&self) -> bool {
        self.state
            .lock()
            .await
            .anonymous_until
            .is_some_and(|deadline| Instant::now() >= deadline)
    }

    pub(super) async fn bound_identity(
        &self,
    ) -> Option<(Arc<VerifiedSession>, Arc<ConnectionEntry>)> {
        self.state
            .lock()
            .await
            .bound
            .as_ref()
            .map(|bound| (bound.session.clone(), bound.entry.clone()))
    }

    pub(super) async fn binding_app_version(&self, app_version: Option<String>) -> Option<String> {
        match app_version {
            Some(app_version) => Some(app_version),
            None => self.state.lock().await.anonymous_app_version.clone(),
        }
    }

    pub(super) async fn mark_anonymous(&self, app_version: Option<String>) -> Result<(), RpcError> {
        let mut state = self.state.lock().await;
        if state.opened {
            return Err(RpcError::with_message(
                RpcErrorCode::Conflict,
                "Session already opened",
            ));
        }
        state.opened = true;
        state.anonymous_until = Some(Instant::now() + ANONYMOUS_SESSION_TIMEOUT);
        state.anonymous_app_version = app_version;
        Ok(())
    }

    pub(super) async fn bind(
        &self,
        services: &AppState,
        session: VerifiedSession,
        sync_enabled: bool,
    ) -> Result<(), RpcError> {
        if self.transport.is_closed() {
            return Err(RpcError::with_message(
                RpcErrorCode::Unavailable,
                "Session unavailable",
            ));
        }
        let (entry, registry_events) = if sync_enabled {
            services
                .ws_registry
                .register_sync(session.uid, session.client_id.clone())
        } else {
            services
                .ws_registry
                .register(session.uid, session.client_id.clone())
        };
        let sync_driver = entry.message_sync.as_ref().map(|subscription| {
            Arc::new(Mutex::new(SyncDriver::new(
                session.uid,
                ReplayService::new(
                    services.db.clone(),
                    services.media.clone(),
                    services.avatars.clone(),
                    &services.config.auth.jwt_signing_key,
                ),
                subscription.clone(),
            )))
        });
        let (presence_subscription, presence_receiver) =
            watch::channel::<Option<VersionedPresenceWatch>>(None);
        let (unread_subscription, unread_receiver) =
            watch::channel::<Option<unread::watch::UnreadWatch>>(None);
        let (states_subscription, states_receiver) =
            watch::channel::<Option<unread::states::StateWatch>>(None);
        let mut state = self.state.lock().await;
        if !state.accepting || state.bound.is_some() {
            services
                .ws_registry
                .remove_connection(session.uid, entry.conn_id);
            return Err(RpcError::with_message(
                RpcErrorCode::Conflict,
                "Session already authenticated",
            ));
        }
        state.anonymous_app_version = None;
        state.opened = true;
        state.anonymous_until = None;
        state.bound = Some(BoundSession {
            session: Arc::new(session),
            entry,
            registry_events: Some(registry_events),
            presence_subscription,
            presence_receiver: Some(presence_receiver),
            unread_subscription,
            unread_receiver: Some(unread_receiver),
            states_subscription,
            states_receiver: Some(states_receiver),
            sync_driver,
        });
        Ok(())
    }

    fn next_watch_generation(state: &mut SessionState) -> u64 {
        state.next_watch_generation = state.next_watch_generation.wrapping_add(1);
        if state.next_watch_generation == 0 {
            state.next_watch_generation = 1;
        }
        state.next_watch_generation
    }

    pub(super) async fn replace_presence_watch(
        &self,
        watch: Option<PresenceWatch>,
    ) -> Result<(), RpcError> {
        let _gate = self.event_gate.lock().await;
        let mut state = self.state.lock().await;
        if !state.accepting {
            return Err(RpcError::with_message(
                RpcErrorCode::Unauthorized,
                "Authentication required",
            ));
        }
        let generation = Self::next_watch_generation(&mut state);
        let bound = state.bound.as_ref().ok_or_else(|| {
            RpcError::with_message(RpcErrorCode::Unauthorized, "Authentication required")
        })?;
        bound
            .presence_subscription
            .send_replace(watch.map(|watch| VersionedPresenceWatch { generation, watch }));
        Ok(())
    }

    pub(super) async fn replace_unread_watch(
        &self,
        watch: Option<unread::watch::UnreadWatch>,
    ) -> Result<(), RpcError> {
        let _gate = self.event_gate.lock().await;
        let mut state = self.state.lock().await;
        if !state.accepting {
            return Err(RpcError::with_message(
                RpcErrorCode::Unauthorized,
                "Authentication required",
            ));
        }
        let generation = Self::next_watch_generation(&mut state);
        let bound = state.bound.as_ref().ok_or_else(|| {
            RpcError::with_message(RpcErrorCode::Unauthorized, "Authentication required")
        })?;
        bound
            .unread_subscription
            .send_replace(watch.map(|mut watch| {
                watch.generation = generation;
                watch
            }));
        Ok(())
    }

    pub(super) async fn replace_states_watch(
        &self,
        watch: Option<unread::states::StateWatch>,
    ) -> Result<(), RpcError> {
        let _gate = self.event_gate.lock().await;
        let mut state = self.state.lock().await;
        if !state.accepting {
            return Err(RpcError::with_message(
                RpcErrorCode::Unauthorized,
                "Authentication required",
            ));
        }
        let generation = Self::next_watch_generation(&mut state);
        let bound = state.bound.as_ref().ok_or_else(|| {
            RpcError::with_message(RpcErrorCode::Unauthorized, "Authentication required")
        })?;
        bound
            .states_subscription
            .send_replace(watch.map(|mut watch| {
                watch.generation = generation;
                watch
            }));
        Ok(())
    }
    // The successful handshake reply must be enqueued before activating publishers.
    pub(super) async fn activate(self: &Arc<Self>, services: &AppState, sink: &RpcOutputSink) {
        if let Some(activation) = self.take_activation().await {
            activation.start_publishers(self, services, sink);
        }
    }

    async fn take_activation(&self) -> Option<Activation> {
        let mut state = self.state.lock().await;
        if !state.accepting || state.activated {
            return None;
        }
        let bound = state.bound.as_mut()?;
        let activation = Activation {
            uid: bound.session.uid,
            entry: bound.entry.clone(),
            registry_events: bound.registry_events.take(),
            presence_receiver: bound.presence_receiver.take(),
            unread_receiver: bound.unread_receiver.take(),
            states_receiver: bound.states_receiver.take(),
            sync_driver: bound.sync_driver.clone(),
        };
        state.activated = true;
        Some(activation)
    }

    /// Stops new authenticated calls and publisher snapshots as soon as a
    /// typed generation failure is observed, while allowing a correlated batch
    /// response to finish assembling before the close notification is queued.
    pub(super) async fn suspend_authorized_work(&self) {
        let _gate = self.event_gate.lock().await;
        self.state.lock().await.accepting = false;
    }

    pub(super) async fn remove_registration(&self, services: &AppState) {
        let bound = self.state.lock().await.bound.take();
        if let Some(bound) = bound {
            services
                .ws_registry
                .remove_connection(bound.session.uid, bound.entry.conn_id);
        }
    }
}

/// The pieces moved out of `SessionShared` while activating authenticated
/// event/watch delivery after the handshake response has been enqueued.
pub(super) struct Activation {
    pub(super) uid: i32,
    pub(super) entry: Arc<ConnectionEntry>,
    pub(super) registry_events: Option<mpsc::Receiver<Arc<ServerWsMessage>>>,
    pub(super) presence_receiver: Option<watch::Receiver<Option<VersionedPresenceWatch>>>,
    pub(super) unread_receiver: Option<watch::Receiver<Option<unread::watch::UnreadWatch>>>,
    pub(super) states_receiver: Option<watch::Receiver<Option<unread::states::StateWatch>>>,
    pub(super) sync_driver: Option<Arc<Mutex<SyncDriver>>>,
}
