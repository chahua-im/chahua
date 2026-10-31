//! Transport-independent JSON-RPC session runtime.
//!
//! The WebSocket adapter owns framing, upgrade negotiation and protocol
//! ping/pong. This module receives and emits complete JSON strings so the same
//! engine can be used by an in-memory or future stream transport.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    panic::AssertUnwindSafe,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock,
    },
    time::Duration,
};

use futures::FutureExt;
use serde_json::Value;
use tokio::{
    sync::{mpsc, oneshot, watch, Mutex, OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
    time::{self, timeout, Instant},
};

use crate::{
    dto::{
        auth::{AuthTokenResponse, DevSessionRequest},
        rpc::{
            auth::AuthCreateDevSessionParams,
            conversations::{ConversationsWatchStatesParams, ConversationsWatchUnreadParams},
            notifications::{
                SessionInvalidatedReason, SessionNotification, SessionUnavailableReason,
            },
            presence::PresenceWatchParams,
            session::{
                SessionOpenParams, SessionOpenResult, SessionPingParams, SessionSetAppStateParams,
            },
        },
        ws::{OnlineClientStatus, ServerWsMessage},
    },
    services::{
        api::auth::{self, PostDevSessionDeps},
        auth_token::VerifiedSession,
        authentication,
        presence::{snapshot_after_pending_changes, validate_presence_watch, PresenceWatch},
        unread,
        ws_registry::{AppPresenceState, ConnectionEntry},
    },
};

use super::{
    error::{RpcError, RpcErrorCode, RpcLifecycleFailure},
    events::{encode_event, encode_session_notification},
    methods::{self, ExecutionClass},
    protocol::{parse_message, RpcCall, RpcId, RpcItem, RpcMessage, RpcResponse},
    RpcCallContext, RpcServices,
};

pub const MAX_FRAME_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_BATCH_ITEMS: usize = 32;
pub const MAX_IN_FLIGHT: usize = 16;
pub const MAX_GLOBAL_IN_FLIGHT: usize = 128;
pub const MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024;
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);

const INPUT_QUEUE: usize = 16;
const RESULT_QUEUE: usize = 16;
const OUTPUT_QUEUE: usize = 16;
const CONTROL_QUEUE: usize = 8;
const ANONYMOUS_SESSION_TIMEOUT: Duration = Duration::from_secs(30);
const REVOCATION_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const PRESENCE_REFRESH_INTERVAL: Duration = Duration::from_secs(15);

static GLOBAL_ADMISSION: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(MAX_GLOBAL_IN_FLIGHT)));

fn global_admission() -> Arc<Semaphore> {
    GLOBAL_ADMISSION.clone()
}

// The executor outlives individual sessions and owns every admitted task.
// Reap completed handles on submission rather than tying a background reaper
// to one Tokio runtime (tests and embedders can create more than one runtime).
static ADMITTED_WORK: LazyLock<std::sync::Mutex<JoinSet<()>>> =
    LazyLock::new(|| std::sync::Mutex::new(JoinSet::new()));

fn supervise(work: impl Future<Output = ()> + Send + 'static, transport: Arc<TransportState>) {
    let mut jobs = ADMITTED_WORK.lock().expect("RPC executor lock");
    while let Some(result) = jobs.try_join_next() {
        if let Err(error) = result {
            tracing::error!(?error, "RPC supervised task failed");
        }
    }
    jobs.spawn(async move {
        if AssertUnwindSafe(work).catch_unwind().await.is_err() {
            // Do not log a panic payload: application input can appear in it.
            tracing::error!("RPC supervised operation panicked");
            transport.close();
        }
    });
}

pub type ControlReply<T> = oneshot::Sender<Result<T, RpcError>>;

/// Typed commands carried by the session's bounded, serial control lane.
pub enum RpcControlCommand {
    Open {
        params: SessionOpenParams,
        reply: ControlReply<SessionOpenResult>,
    },
    CreateDevSession {
        params: AuthCreateDevSessionParams,
        reply: ControlReply<AuthTokenResponse>,
    },
    Refresh {
        reply: ControlReply<AuthTokenResponse>,
    },
    Ping {
        params: SessionPingParams,
        reply: ControlReply<()>,
    },
    SetAppState {
        params: SessionSetAppStateParams,
        reply: ControlReply<()>,
    },
    WatchPresence {
        params: PresenceWatchParams,
        reply: ControlReply<()>,
    },
    WatchUnread {
        params: ConversationsWatchUnreadParams,
        reply: ControlReply<()>,
    },
    WatchStates {
        params: ConversationsWatchStatesParams,
        reply: ControlReply<()>,
    },
}

/// Errors exposed by the transport-neutral input side.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RpcIoError {
    Closed,
    FrameTooLarge,
    BudgetExhausted,
}

/// An opaque lease for serialized bytes. The transport writer must keep the
/// lease until its write completes; dropping the final internal reference
/// releases the session budget.
pub struct RpcFrameLease {
    _permit: Option<Arc<OwnedSemaphorePermit>>,
}

impl RpcFrameLease {
    fn empty() -> Self {
        Self { _permit: None }
    }

    fn retain_for_dispatch(&self) -> Self {
        Self {
            _permit: self._permit.clone(),
        }
    }
}

#[derive(Clone)]
struct RpcByteBudget {
    permits: Arc<Semaphore>,
}

impl RpcByteBudget {
    fn new() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
        }
    }

    fn reserve(&self, bytes: usize) -> Result<RpcFrameLease, RpcIoError> {
        if bytes > MAX_QUEUED_BYTES {
            return Err(RpcIoError::BudgetExhausted);
        }
        if bytes == 0 {
            return Ok(RpcFrameLease::empty());
        }
        self.permits
            .clone()
            .try_acquire_many_owned(bytes as u32)
            .map(|permit| RpcFrameLease {
                _permit: Some(Arc::new(permit)),
            })
            .map_err(|_| RpcIoError::BudgetExhausted)
    }
}

struct TransportState {
    closed: AtomicBool,
    close_tx: watch::Sender<bool>,
}

impl TransportState {
    fn new() -> Arc<Self> {
        let (close_tx, _) = watch::channel(false);
        Arc::new(Self {
            closed: AtomicBool::new(false),
            close_tx,
        })
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.close_tx.send_replace(true);
        }
    }

    fn close_subscription(&self) -> watch::Receiver<bool> {
        self.close_tx.subscribe()
    }

    /// Waits for shutdown as a level-triggered condition. A watcher created
    /// after `close` must not wait for another state transition that will
    /// never occur.
    async fn wait_closed(&self, close: &mut watch::Receiver<bool>) {
        if self.is_closed() || *close.borrow_and_update() {
            return;
        }
        while close.changed().await.is_ok() {
            if self.is_closed() || *close.borrow_and_update() {
                return;
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct RpcSessionCloser {
    state: Arc<TransportState>,
}

impl RpcSessionCloser {
    pub(crate) fn close(&self) {
        self.state.close();
    }
}

enum InputLease {
    Frame(RpcFrameLease),
    /// Oversized frames reserve the entire session budget until the core has
    /// extracted a correlatable ID and produced its final 1013 response.
    Oversized(RpcFrameLease),
}

/// Sender owned by a transport reader. It reserves byte budget before putting
/// a complete inbound frame in the bounded core queue.
pub struct RpcSessionInput {
    tx: mpsc::Sender<String>,
    permits: mpsc::Sender<InputLease>,
    pair_lock: Arc<Mutex<()>>,
    budget: RpcByteBudget,
    state: Arc<TransportState>,
}

impl RpcSessionInput {
    pub async fn send(&self, text: String) -> Result<(), RpcIoError> {
        if self.state.is_closed() {
            return Err(RpcIoError::Closed);
        }
        let lease = if text.len() > MAX_FRAME_BYTES {
            // An oversized request is terminal. Reserving the whole budget
            // prevents multiple huge frames from bypassing the byte bound
            // while the core emits its correlatable 1013 response.
            match self.budget.reserve(MAX_QUEUED_BYTES) {
                Ok(lease) => InputLease::Oversized(lease),
                Err(error) => {
                    self.state.close();
                    return Err(error);
                }
            }
        } else {
            match self.budget.reserve(text.len()) {
                Ok(lease) => InputLease::Frame(lease),
                Err(error) => {
                    self.state.close();
                    return Err(error);
                }
            }
        };
        let _pair = self.pair_lock.lock().await;
        if self.state.is_closed() {
            return Err(RpcIoError::Closed);
        }
        // Reserve both sidecar slots before publishing either half. If this
        // future is cancelled while waiting, the reservations and lease drop
        // together, so the core never observes an unpaired text frame.
        let text_slot = self.tx.reserve().await.map_err(|_| RpcIoError::Closed)?;
        let lease_slot = self
            .permits
            .reserve()
            .await
            .map_err(|_| RpcIoError::Closed)?;
        if self.state.is_closed() {
            return Err(RpcIoError::Closed);
        }
        text_slot.send(text);
        lease_slot.send(lease);
        Ok(())
    }

    /// Stops admission immediately. The core observes this independently of
    /// sender drop, so clones cannot accidentally keep a disconnected session
    /// accepting buffered mutations.
    pub fn close(&self) {
        self.state.close();
    }
}

/// Receiver owned by a transport writer. It transfers an outbound text frame
/// and its byte lease together in FIFO order.
pub struct RpcSessionOutput {
    rx: mpsc::Receiver<String>,
    permits: mpsc::Receiver<RpcFrameLease>,
    // `recv` is routinely polled inside transport `select!` loops. Once it
    // has consumed text, retain it here across cancellation while awaiting
    // its sidecar lease.
    pending_text: Option<String>,
    state: Arc<TransportState>,
}

impl RpcSessionOutput {
    pub async fn recv(&mut self) -> Option<RpcOutboundFrame> {
        if self.pending_text.is_none() {
            self.pending_text = Some(self.rx.recv().await?);
        }
        match self.permits.recv().await {
            Some(lease) => Some(RpcOutboundFrame {
                text: self.pending_text.take().expect("outbound text retained"),
                lease,
            }),
            None => {
                drop(self.pending_text.take());
                self.state.close();
                None
            }
        }
    }
}

pub struct RpcOutboundFrame {
    text: String,
    lease: RpcFrameLease,
}

impl RpcOutboundFrame {
    pub fn into_parts(self) -> (String, RpcFrameLease) {
        (self.text, self.lease)
    }
}

pub struct RpcSessionTransport {
    pub input: RpcSessionInput,
    pub output: RpcSessionOutput,
}

/// Per-session service handles and I/O budgets. No HTTP, Axum, or WebSocket
/// type leaks into the engine.
pub struct RpcSessionDeps {
    services: RpcServices,
    input_permits: mpsc::Receiver<InputLease>,
    output_permits: mpsc::Sender<RpcFrameLease>,
    output_pair_lock: Arc<Mutex<()>>,
    budget: RpcByteBudget,
    state: Arc<TransportState>,
}

/// Creates the raw core channels and the leased transport endpoints together.
/// The raw channels are only the engine boundary; adapters must use
/// `RpcSessionTransport` so bytes remain accounted until real I/O completes.
pub fn rpc_session_channels(
    services: RpcServices,
) -> (
    mpsc::Receiver<String>,
    mpsc::Sender<String>,
    RpcSessionDeps,
    RpcSessionTransport,
) {
    let budget = RpcByteBudget::new();
    let state = TransportState::new();
    let pair_lock = Arc::new(Mutex::new(()));
    let output_pair_lock = Arc::new(Mutex::new(()));
    let (input_tx, input_rx) = mpsc::channel(INPUT_QUEUE);
    let (input_permit_tx, input_permit_rx) = mpsc::channel(INPUT_QUEUE);
    let (output_tx, output_rx) = mpsc::channel(OUTPUT_QUEUE);
    let (output_permit_tx, output_permit_rx) = mpsc::channel(OUTPUT_QUEUE);
    let deps = RpcSessionDeps {
        services,
        input_permits: input_permit_rx,
        output_permits: output_permit_tx,
        output_pair_lock,
        budget: budget.clone(),
        state: state.clone(),
    };
    let transport = RpcSessionTransport {
        input: RpcSessionInput {
            tx: input_tx,
            permits: input_permit_tx,
            pair_lock,
            budget,
            state: state.clone(),
        },
        output: RpcSessionOutput {
            rx: output_rx,
            permits: output_permit_rx,
            pending_text: None,
            state,
        },
    };
    (input_rx, output_tx, deps, transport)
}

#[derive(Clone)]
struct RpcOutputSink {
    tx: mpsc::Sender<String>,
    permits: mpsc::Sender<RpcFrameLease>,
    pair_lock: Arc<Mutex<()>>,
    budget: RpcByteBudget,
    state: Arc<TransportState>,
}

impl RpcOutputSink {
    async fn send_text(&self, text: String) -> Result<(), RpcIoError> {
        if text.len() > MAX_FRAME_BYTES {
            self.state.close();
            return Err(RpcIoError::FrameTooLarge);
        }
        let lease = self.budget.reserve(text.len()).map_err(|error| {
            self.state.close();
            error
        })?;
        self.send_prepared(PreparedFrame { text, lease }).await
    }

    async fn send_prepared(&self, frame: PreparedFrame) -> Result<(), RpcIoError> {
        let sent = timeout(SEND_TIMEOUT, async {
            let _pair = self.pair_lock.lock().await;
            if self.state.is_closed() {
                return Err(RpcIoError::Closed);
            }
            // Reserve both halves before publishing. One deadline covers the
            // pair lock and both queues; partial progress does not restart it.
            let text_slot = self.tx.reserve().await.map_err(|_| RpcIoError::Closed)?;
            let lease_slot = self
                .permits
                .reserve()
                .await
                .map_err(|_| RpcIoError::Closed)?;
            if self.state.is_closed() {
                return Err(RpcIoError::Closed);
            }
            text_slot.send(frame.text);
            lease_slot.send(frame.lease);
            Ok(())
        })
        .await;
        match sent {
            Ok(Ok(())) => Ok(()),
            _ => {
                self.state.close();
                Err(RpcIoError::Closed)
            }
        }
    }
}

struct PreparedFrame {
    text: String,
    lease: RpcFrameLease,
}

struct PreparedResponse {
    frame: PreparedFrame,
    success: bool,
    lifecycle: Option<RpcLifecycleFailure>,
}

fn prepare_response(
    response: RpcResponse,
    budget: &RpcByteBudget,
) -> Result<PreparedResponse, RpcIoError> {
    let lifecycle = response.lifecycle_failure();
    let success = matches!(
        &response.outcome,
        super::protocol::RpcOutcome::Success { .. }
    );
    let text = serde_json::to_string(&response).map_err(|error| {
        tracing::error!(?error, "RPC response serialization failed");
        RpcIoError::Closed
    })?;
    let (text, success, lifecycle) = if text.len() > MAX_FRAME_BYTES {
        (
            serde_json::to_string(&RpcResponse::error(
                response.id,
                RpcError::new(RpcErrorCode::PayloadTooLarge),
            ))
            .map_err(|error| {
                tracing::error!(?error, "RPC oversized-result error serialization failed");
                RpcIoError::Closed
            })?,
            false,
            None,
        )
    } else {
        (text, success, lifecycle)
    };
    let lease = budget.reserve(text.len())?;
    Ok(PreparedResponse {
        frame: PreparedFrame { text, lease },
        success,
        lifecycle,
    })
}

#[derive(Clone)]
struct VersionedPresenceWatch {
    generation: u64,
    watch: PresenceWatch,
}

enum WatchIdentity {
    Presence {
        generation: u64,
        request_id: Option<u64>,
    },
    Unread {
        generation: u64,
        request_id: u32,
    },
    States {
        generation: u64,
        request_id: u32,
    },
}

trait OwnedWatchEvent {
    fn into_identity_and_message(self) -> (WatchIdentity, ServerWsMessage);
}

impl OwnedWatchEvent for unread::watch::UnreadWatchEvent {
    fn into_identity_and_message(self) -> (WatchIdentity, ServerWsMessage) {
        let request_id = match &self.message {
            ServerWsMessage::ConversationUnread(payload) => payload.request_id,
            ServerWsMessage::ConversationUnreadError(payload) => payload.request_id,
            _ => unreachable!("unread watch emitted a non-unread event"),
        };
        (
            WatchIdentity::Unread {
                generation: self.generation,
                request_id,
            },
            self.message,
        )
    }
}

impl OwnedWatchEvent for unread::states::StateWatchEvent {
    fn into_identity_and_message(self) -> (WatchIdentity, ServerWsMessage) {
        let request_id = match &self.message {
            ServerWsMessage::ConversationStates(payload) => payload.request_id,
            ServerWsMessage::ConversationStatesError(payload) => payload.request_id,
            _ => unreachable!("state watch emitted a non-state event"),
        };
        (
            WatchIdentity::States {
                generation: self.generation,
                request_id,
            },
            self.message,
        )
    }
}

struct BoundSession {
    session: Arc<VerifiedSession>,
    entry: Arc<ConnectionEntry>,
    registry_events: Option<mpsc::Receiver<Arc<ServerWsMessage>>>,
    presence_subscription: watch::Sender<Option<VersionedPresenceWatch>>,
    presence_receiver: Option<watch::Receiver<Option<VersionedPresenceWatch>>>,
    unread_subscription: watch::Sender<Option<unread::watch::UnreadWatch>>,
    unread_receiver: Option<watch::Receiver<Option<unread::watch::UnreadWatch>>>,
    states_subscription: watch::Sender<Option<unread::states::StateWatch>>,
    states_receiver: Option<watch::Receiver<Option<unread::states::StateWatch>>>,
}

struct SessionState {
    opened: bool,
    accepting: bool,
    lifecycle_notified: bool,
    anonymous_until: Option<Instant>,
    anonymous_app_version: Option<String>,
    bound: Option<BoundSession>,
    activated: bool,
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

struct SessionShared {
    state: Mutex<SessionState>,
    event_gate: Mutex<()>,
    transport: Arc<TransportState>,
}

impl SessionShared {
    fn new(transport: Arc<TransportState>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SessionState::default()),
            event_gate: Mutex::new(()),
            transport,
        })
    }

    async fn call_context(
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
            guard_failures: Some(guard_failures),
            close_session: Some(RpcSessionCloser {
                state: self.transport.clone(),
            }),
        })
    }

    async fn opened(&self) -> bool {
        self.state.lock().await.opened
    }

    async fn anonymous_expired(&self) -> bool {
        self.state
            .lock()
            .await
            .anonymous_until
            .is_some_and(|deadline| Instant::now() >= deadline)
    }

    async fn bound_identity(&self) -> Option<(Arc<VerifiedSession>, Arc<ConnectionEntry>)> {
        self.state
            .lock()
            .await
            .bound
            .as_ref()
            .map(|bound| (bound.session.clone(), bound.entry.clone()))
    }

    async fn binding_app_version(&self, app_version: Option<String>) -> Option<String> {
        match app_version {
            Some(app_version) => Some(app_version),
            None => self.state.lock().await.anonymous_app_version.clone(),
        }
    }

    async fn mark_anonymous(&self, app_version: Option<String>) -> Result<(), RpcError> {
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

    async fn bind(&self, services: &RpcServices, session: VerifiedSession) -> Result<(), RpcError> {
        if self.transport.is_closed() {
            return Err(RpcError::with_message(
                RpcErrorCode::Unavailable,
                "Session unavailable",
            ));
        }
        let (entry, registry_events) = services
            .ws_registry
            .register(session.uid, session.client_id.clone());
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

    async fn replace_presence_watch(&self, watch: Option<PresenceWatch>) -> Result<(), RpcError> {
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

    async fn replace_unread_watch(
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

    async fn replace_states_watch(
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
    async fn activate(self: &Arc<Self>, services: &RpcServices, sink: &RpcOutputSink) {
        let activation = {
            let mut state = self.state.lock().await;
            if !state.accepting || state.activated {
                return;
            }
            let Some(bound) = state.bound.as_mut() else {
                return;
            };
            let activation = Activation {
                uid: bound.session.uid,
                entry: bound.entry.clone(),
                registry_events: bound.registry_events.take(),
                presence_receiver: bound.presence_receiver.take(),
                unread_receiver: bound.unread_receiver.take(),
                states_receiver: bound.states_receiver.take(),
            };
            state.activated = true;
            activation
        };
        let Activation {
            uid,
            entry,
            registry_events,
            presence_receiver,
            unread_receiver,
            states_receiver,
        } = activation;
        if let Some(events) = registry_events {
            tokio::spawn(forward_registry_events(
                events,
                entry.clone(),
                self.clone(),
                sink.clone(),
            ));
        }
        if let Some(receiver) = presence_receiver {
            let shared = self.clone();
            let sink = sink.clone();
            let service = services.presence_service.clone();
            tokio::spawn(async move {
                let mut close = shared.transport.close_subscription();
                if shared.transport.is_closed() {
                    return;
                }
                tokio::select! {
                    _ = shared.transport.wait_closed(&mut close) => {}
                    _ = run_presence_watch(service, uid, receiver, &shared, sink) => {}
                }
            });
        }
        if let Some(receiver) = unread_receiver {
            let (watch_output, watch_events) = mpsc::channel(1);
            let shared = self.clone();
            let sink = sink.clone();
            let db = services.db.clone();
            let unread_service = services.unread_service.clone();
            let changed = entry.unread_changed.clone();
            tokio::spawn(async move {
                let mut close = shared.transport.close_subscription();
                if shared.transport.is_closed() {
                    return;
                }
                tokio::select! {
                    _ = shared.transport.wait_closed(&mut close) => {}
                    _ = unread::watch::run_tagged(
                        db,
                        unread_service,
                        uid,
                        changed,
                        receiver,
                        watch_output,
                    ) => {}
                }
            });
            tokio::spawn(forward_owned_events(
                watch_events,
                self.clone(),
                sink.clone(),
            ));
        }
        if let Some(receiver) = states_receiver {
            let (watch_output, watch_events) = mpsc::channel(1);
            let shared = self.clone();
            let sink = sink.clone();
            let db = services.db.clone();
            let unread_service = services.unread_service.clone();
            let changed = entry.states_changed.clone();
            tokio::spawn(async move {
                let mut close = shared.transport.close_subscription();
                if shared.transport.is_closed() {
                    return;
                }
                tokio::select! {
                    _ = shared.transport.wait_closed(&mut close) => {}
                    _ = unread::states::run_tagged(
                        db,
                        unread_service,
                        uid,
                        changed,
                        receiver,
                        watch_output,
                    ) => {}
                }
            });
            tokio::spawn(forward_owned_events(
                watch_events,
                self.clone(),
                sink.clone(),
            ));
        }
    }

    /// Stops new authenticated calls and publisher snapshots as soon as a
    /// typed generation failure is observed, while allowing a correlated batch
    /// response to finish assembling before the close notification is queued.
    async fn suspend_authorized_work(&self) {
        let _gate = self.event_gate.lock().await;
        self.state.lock().await.accepting = false;
    }

    async fn remove_registration(&self, services: &RpcServices) {
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
struct Activation {
    uid: i32,
    entry: Arc<ConnectionEntry>,
    registry_events: Option<mpsc::Receiver<Arc<ServerWsMessage>>>,
    presence_receiver: Option<watch::Receiver<Option<VersionedPresenceWatch>>>,
    unread_receiver: Option<watch::Receiver<Option<unread::watch::UnreadWatch>>>,
    states_receiver: Option<watch::Receiver<Option<unread::states::StateWatch>>>,
}

async fn send_authorized_event(
    shared: &Arc<SessionShared>,
    sink: &RpcOutputSink,
    message: &ServerWsMessage,
) -> Result<(), RpcIoError> {
    let _gate = shared.event_gate.lock().await;
    if shared.transport.is_closed() || !shared.state.lock().await.accepting {
        return Ok(());
    }
    let text = encode_event(message).map_err(|error| {
        tracing::error!(?error, "RPC event serialization failed");
        RpcIoError::Closed
    })?;
    sink.send_text(text).await
}

fn current_watch_matches(bound: &BoundSession, identity: &WatchIdentity) -> bool {
    match identity {
        WatchIdentity::Presence {
            generation,
            request_id,
        } => bound
            .presence_subscription
            .borrow()
            .as_ref()
            .is_some_and(|watch| {
                watch.generation == *generation && watch.watch.request_id == *request_id
            }),
        WatchIdentity::Unread {
            generation,
            request_id,
        } => bound
            .unread_subscription
            .borrow()
            .as_ref()
            .is_some_and(|watch| {
                watch.generation == *generation && watch.request_id == *request_id
            }),
        WatchIdentity::States {
            generation,
            request_id,
        } => bound
            .states_subscription
            .borrow()
            .as_ref()
            .is_some_and(|watch| {
                watch.generation == *generation && watch.request_id == *request_id
            }),
    }
}

async fn send_current_watch_event(
    shared: &Arc<SessionShared>,
    sink: &RpcOutputSink,
    identity: WatchIdentity,
    message: ServerWsMessage,
) -> Result<(), RpcIoError> {
    // Replacement takes this same gate before updating its watch sender. Keep
    // it through enqueue so a control acknowledgement cannot overtake an old
    // event whose current-subscription check has become stale.
    let _gate = shared.event_gate.lock().await;
    let state = shared.state.lock().await;
    if shared.transport.is_closed()
        || !state.accepting
        || !state.activated
        || !state
            .bound
            .as_ref()
            .is_some_and(|bound| current_watch_matches(bound, &identity))
    {
        return Ok(());
    }
    let text = encode_event(&message).map_err(|error| {
        tracing::error!(?error, "RPC event serialization failed");
        RpcIoError::Closed
    })?;
    sink.send_text(text).await
}
async fn forward_registry_events(
    mut events: mpsc::Receiver<Arc<ServerWsMessage>>,
    entry: Arc<ConnectionEntry>,
    shared: Arc<SessionShared>,
    sink: RpcOutputSink,
) {
    let mut close = shared.transport.close_subscription();
    loop {
        if shared.transport.is_closed() {
            break;
        }
        tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => break,
            _ = entry.lagged.notified() => {
                shared.transport.close();
                break;
            }
            event = events.recv() => match event {
                Some(event) => {
                    if send_authorized_event(&shared, &sink, &event).await.is_err() {
                        shared.transport.close();
                        break;
                    }
                }
                None => break,
            }
        }
    }
}

async fn forward_owned_events<E>(
    mut events: mpsc::Receiver<E>,
    shared: Arc<SessionShared>,
    sink: RpcOutputSink,
) where
    E: OwnedWatchEvent,
{
    let mut close = shared.transport.close_subscription();
    loop {
        if shared.transport.is_closed() {
            break;
        }
        tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => break,
            event = events.recv() => match event {
                Some(event) => {
                    let (identity, message) = event.into_identity_and_message();
                    if send_current_watch_event(&shared, &sink, identity, message).await.is_err() {
                        shared.transport.close();
                        break;
                    }
                }
                None => break,
            }
        }
    }
}

async fn run_presence_watch(
    service: Arc<crate::services::presence::PresenceSnapshotService>,
    uid: i32,
    mut subscription: watch::Receiver<Option<VersionedPresenceWatch>>,
    shared: &Arc<SessionShared>,
    sink: RpcOutputSink,
) {
    let mut changes = service.subscribe_changes();
    let mut current = None;
    let mut refresh = time::interval_at(
        Instant::now() + PRESENCE_REFRESH_INTERVAL,
        PRESENCE_REFRESH_INTERVAL,
    );
    loop {
        tokio::select! {
            changed = subscription.changed() => {
                if changed.is_err() { break; }
                current = subscription.borrow_and_update().clone();
                if let Some(watch) = current.as_ref() {
                    if publish_presence_snapshot(&service, &mut changes, uid, watch, shared, &sink).await.is_err() {
                        shared.transport.close();
                        break;
                    }
                }
            }
            change = changes.recv(), if current.is_some() => {
                let refresh_needed = match change {
                    Ok(change) => {
                        let watch = &current.as_ref().expect("guarded above").watch;
                        change.affects(uid, &watch.user_ids)
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        !current
                            .as_ref()
                            .expect("guarded above")
                            .watch
                            .user_ids
                            .is_empty()
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => false,
                };
                if refresh_needed {
                    let watch = current.as_ref().expect("guarded above");
                    if publish_presence_snapshot(&service, &mut changes, uid, watch, shared, &sink).await.is_err() {
                        shared.transport.close();
                        break;
                    }
                }
            }
            _ = refresh.tick(), if current.is_some() => {
                let watch = current.as_ref().expect("guarded above");
                if publish_presence_snapshot(&service, &mut changes, uid, watch, shared, &sink).await.is_err() {
                    shared.transport.close();
                    break;
                }
            }
        }
    }
}

async fn publish_presence_snapshot(
    service: &crate::services::presence::PresenceSnapshotService,
    changes: &mut crate::services::presence::PresenceChanges,
    uid: i32,
    watch: &VersionedPresenceWatch,
    shared: &Arc<SessionShared>,
    sink: &RpcOutputSink,
) -> Result<(), RpcIoError> {
    match snapshot_after_pending_changes(service, changes, uid, &watch.watch).await {
        Ok(snapshot) => {
            send_current_watch_event(
                shared,
                sink,
                WatchIdentity::Presence {
                    generation: watch.generation,
                    request_id: watch.watch.request_id,
                },
                ServerWsMessage::PresenceSnapshot(snapshot),
            )
            .await
        }
        Err(error) => {
            tracing::warn!(?error, uid, "RPC presence snapshot failed");
            Ok(())
        }
    }
}

async fn record_bind_activity(
    services: &RpcServices,
    session: &VerifiedSession,
    app_version: Option<String>,
) -> Result<(), RpcError> {
    let tracking = services.client_tracking.clone();
    let client_id = session.client_id.clone();
    let uid = session.uid;
    tokio::task::spawn_blocking(move || {
        tracking
            .record_activity(uid, &client_id, app_version.as_deref())
            .map_err(RpcError::from)
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, uid, "RPC bind activity worker failed");
        RpcError::new(RpcErrorCode::DispatcherInternal)
    })?
}

fn record_active_rpc_activity(
    activity_tasks: &mut JoinSet<()>,
    services: &RpcServices,
    session: &VerifiedSession,
) {
    let uid = session.uid;
    services
        .client_tracking
        .last_seen
        .record(uid, chrono::Utc::now().naive_utc());
    if activity_tasks.is_empty() {
        let tracking = services.client_tracking.clone();
        let client_id = session.client_id.clone();
        activity_tasks.spawn_blocking(move || {
            if let Err(error) = tracking.record_client_activity(uid, &client_id, None) {
                tracing::warn!(?error, uid, "RPC client activity recording failed");
            }
        });
    }
}

async fn verify_open(services: &RpcServices, token: String) -> Result<VerifiedSession, RpcError> {
    let services = services.clone();
    tokio::task::spawn_blocking(move || {
        authentication::verify_session(
            &token,
            &services.auth_token_service,
            &services.token_generation,
            &services.db,
        )
        .map_err(RpcError::from)
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "RPC session-open verifier worker failed");
        RpcError::new(RpcErrorCode::DispatcherInternal)
    })?
}

async fn guard_bound(
    shared: &Arc<SessionShared>,
    services: &RpcServices,
) -> Result<(Arc<VerifiedSession>, Arc<ConnectionEntry>), RpcError> {
    let identity = shared.bound_identity().await.ok_or_else(|| {
        RpcError::with_message(RpcErrorCode::Unauthorized, "Authentication required")
    })?;
    let services = services.clone();
    let session = identity.0.clone();
    tokio::task::spawn_blocking(move || {
        authentication::check_session_generation_cause(
            &session,
            &services.token_generation,
            &services.db,
        )
        .map_err(|failure| RpcError::from(RpcLifecycleFailure::from(failure)))
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "RPC generation-guard worker failed");
        RpcError::new(RpcErrorCode::DispatcherInternal)
    })??;
    Ok(identity)
}

fn app_presence_state(
    status: Option<OnlineClientStatus>,
    default: AppPresenceState,
) -> AppPresenceState {
    status.map(AppPresenceState::from).unwrap_or(default)
}

async fn bind_authenticated(
    shared: &Arc<SessionShared>,
    services: &RpcServices,
    session: VerifiedSession,
    app_version: Option<String>,
) -> Result<SessionOpenResult, RpcError> {
    let response = SessionOpenResult::authenticated(&session);
    let app_version = shared.binding_app_version(app_version).await;
    record_bind_activity(services, &session, app_version).await?;
    shared.bind(services, session).await?;
    Ok(response)
}

async fn run_controls(
    mut controls: mpsc::Receiver<RpcControlCommand>,
    shared: Arc<SessionShared>,
    services: RpcServices,
) {
    let mut close = shared.transport.close_subscription();
    let mut activity_tasks = JoinSet::new();
    loop {
        if shared.transport.is_closed() {
            break;
        }
        tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => break,
            result = activity_tasks.join_next(), if !activity_tasks.is_empty() => {
                if let Some(Err(error)) = result {
                    tracing::warn!(?error, "RPC client activity worker failed");
                }
            }
            command = controls.recv() => match command {
                Some(command) => handle_control(command, &shared, &services, &mut activity_tasks).await,
                None => break,
            }
        }
    }
}

async fn handle_control(
    command: RpcControlCommand,
    shared: &Arc<SessionShared>,
    services: &RpcServices,
    activity_tasks: &mut JoinSet<()>,
) {
    match command {
        RpcControlCommand::Open { params, reply } => {
            let result = async {
                if params.protocol_version != 1 {
                    return Err(RpcError::new(RpcErrorCode::InvalidParams));
                }
                if shared.opened().await {
                    if shared.bound_identity().await.is_some() {
                        let _ = guard_bound(shared, services).await?;
                    }
                    return Err(RpcError::with_message(
                        RpcErrorCode::Conflict,
                        "Session already opened",
                    ));
                }
                match params.token {
                    Some(token) => {
                        let session = verify_open(services, token).await?;
                        bind_authenticated(shared, services, session, params.app_version).await
                    }
                    None => {
                        shared.mark_anonymous(params.app_version).await?;
                        Ok(SessionOpenResult::anonymous())
                    }
                }
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::CreateDevSession { params, reply } => {
            let result = async {
                let already_authenticated = {
                    let state = shared.state.lock().await;
                    if !state.opened {
                        return Err(RpcError::with_message(
                            RpcErrorCode::Unauthorized,
                            "Authentication required",
                        ));
                    }
                    state.bound.is_some()
                };
                if already_authenticated {
                    let _ = guard_bound(shared, services).await?;
                    return Err(RpcError::with_message(
                        RpcErrorCode::Conflict,
                        "Session already authenticated",
                    ));
                }
                let services_for_issue = services.clone();
                let uid = params.uid;
                let client_id = params.client_id;
                let issued = tokio::task::spawn_blocking(move || {
                    auth::post_dev_session(
                        DevSessionRequest { uid },
                        client_id,
                        PostDevSessionDeps {
                            config: &services_for_issue.config,
                            auth_token_service: &services_for_issue.auth_token_service,
                            token_generation: &services_for_issue.token_generation,
                            db: &services_for_issue.db,
                        },
                    )
                    .map_err(RpcError::from)
                })
                .await
                .map_err(|error| {
                    tracing::error!(?error, "RPC development-session worker failed");
                    RpcError::new(RpcErrorCode::DispatcherInternal)
                })??;
                let response = issued.response;
                bind_authenticated(shared, services, issued.session, None).await?;
                Ok(response)
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::Refresh { reply } => {
            let result = async {
                let (session, _) = guard_bound(shared, services).await?;
                record_bind_activity(services, &session, None).await?;
                auth::post_refresh(&session, &services.auth_token_service).map_err(RpcError::from)
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::Ping { params, reply } => {
            let result = async {
                let (session, entry) = guard_bound(shared, services).await?;
                let state = app_presence_state(params.state, AppPresenceState::Active);
                entry.update_ping(state);
                services.ws_registry.refresh_metrics();
                if state == AppPresenceState::Active {
                    record_active_rpc_activity(activity_tasks, services, &session);
                }
                Ok(())
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::SetAppState { params, reply } => {
            let result = async {
                let (session, entry) = guard_bound(shared, services).await?;
                let state = app_presence_state(params.state, AppPresenceState::Inactive);
                entry.update_app_state(state);
                services.ws_registry.refresh_metrics();
                if state == AppPresenceState::Active {
                    record_active_rpc_activity(activity_tasks, services, &session);
                }
                Ok(())
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::WatchPresence { params, reply } => {
            let result = async {
                let _ = guard_bound(shared, services).await?;
                if params
                    .user_ids
                    .as_ref()
                    .is_some_and(|user_ids| user_ids.iter().any(|uid| *uid <= 0))
                {
                    return Err(RpcError::new(RpcErrorCode::InvalidParams));
                }
                let watch =
                    validate_presence_watch(params.request_id, params.user_ids, params.chat_ids)
                        .map_err(|_| RpcError::new(RpcErrorCode::InvalidParams))?;
                shared.replace_presence_watch(watch).await
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::WatchUnread { params, reply } => {
            let result = async {
                let _ = guard_bound(shared, services).await?;
                unread::validate_conversation_views(&params.views)
                    .map_err(|_| RpcError::new(RpcErrorCode::InvalidParams))?;
                shared
                    .replace_unread_watch((!params.views.is_empty() || params.app_badge).then_some(
                        unread::watch::UnreadWatch {
                            request_id: params.request_id,
                            generation: 0,
                            views: params.views,
                            app_badge: params.app_badge,
                        },
                    ))
                    .await
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::WatchStates { params, reply } => {
            let result = async {
                let _ = guard_bound(shared, services).await?;
                if !unread::states::valid_scopes(&params.conversations) {
                    return Err(RpcError::new(RpcErrorCode::InvalidParams));
                }
                shared
                    .replace_states_watch((!params.conversations.is_empty()).then_some(
                        unread::states::StateWatch {
                            request_id: params.request_id,
                            generation: 0,
                            conversations: params.conversations,
                        },
                    ))
                    .await
            }
            .await;
            let _ = reply.send(result);
        }
    }
}

async fn generation_checks(
    shared: Arc<SessionShared>,
    services: RpcServices,
    session: Arc<VerifiedSession>,
    guard_failures: mpsc::UnboundedSender<RpcLifecycleFailure>,
) {
    let mut close = shared.transport.close_subscription();
    let mut interval = time::interval_at(
        Instant::now() + REVOCATION_CHECK_INTERVAL,
        REVOCATION_CHECK_INTERVAL,
    );
    loop {
        if shared.transport.is_closed() {
            break;
        }
        tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => break,
            _ = interval.tick() => {
                let services = services.clone();
                let checked = session.clone();
                let result = tokio::task::spawn_blocking(move || {
                    authentication::check_session_generation_cause(
                        &checked,
                        &services.token_generation,
                        &services.db,
                    )
                }).await;
                let failure = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(failure)) => Some(RpcLifecycleFailure::from(failure)),
                    Err(error) => {
                        tracing::error!(?error, "RPC periodic generation-guard worker failed");
                        Some(RpcLifecycleFailure::AuthLookupUnavailable)
                    }
                };
                if let Some(failure) = failure {
                    let _ = guard_failures.send(failure);
                    break;
                }
            }
        }
    }
}

struct SessionAdmission {
    ordinary: Arc<Semaphore>,
    controls: Arc<Semaphore>,
}

struct AdmissionPermits {
    _connection: OwnedSemaphorePermit,
    _global: Option<OwnedSemaphorePermit>,
}

fn admit(connection: &Arc<Semaphore>) -> Option<AdmissionPermits> {
    let connection_permit = connection.clone().try_acquire_owned().ok()?;
    let global_permit = global_admission().try_acquire_owned().ok()?;
    Some(AdmissionPermits {
        _connection: connection_permit,
        _global: Some(global_permit),
    })
}

#[derive(Clone, Copy)]
enum ResultDestination {
    Single,
    Batch(u64),
}

struct WorkResult {
    id: Option<RpcId>,
    destination: ResultDestination,
    response: Option<PreparedResponse>,
    close_after_error: bool,
    activate_after_success: bool,
    counts_toward_batch: bool,
}

enum ScheduledCall {
    Pending,
    Immediate(Option<PreparedResponse>),
    Duplicate,
}

fn record_rejection(services: &RpcServices, method: &str, code: RpcErrorCode) {
    services
        .metrics
        .rpc
        .record(methods::registered_name(method), code.name(), 0.0);
}

async fn schedule_call(
    call: RpcCall,
    destination: ResultDestination,
    close_after_error: bool,
    shared: Arc<SessionShared>,
    services: RpcServices,
    controls: mpsc::Sender<RpcControlCommand>,
    guard_failures: mpsc::UnboundedSender<RpcLifecycleFailure>,
    results: mpsc::Sender<WorkResult>,
    outstanding: &mut HashSet<RpcId>,
    admission: &SessionAdmission,
    budget: RpcByteBudget,
    input_lease: Option<RpcFrameLease>,
) -> ScheduledCall {
    let id = call.id.clone();
    if let Some(id) = &id {
        if !outstanding.insert(id.clone()) {
            return ScheduledCall::Duplicate;
        }
    }
    let class = methods::method_class(&call.method);
    let permits = match class {
        Some(ExecutionClass::Read | ExecutionClass::Mutation) => match admit(&admission.ordinary) {
            Some(permits) => Some(permits),
            None => {
                if let Some(id) = id {
                    if matches!(destination, ResultDestination::Single) {
                        outstanding.remove(&id);
                    }
                    record_rejection(&services, &call.method, RpcErrorCode::Overloaded);
                    return match prepare_response(
                        RpcResponse::error(id, RpcError::new(RpcErrorCode::Overloaded)),
                        &budget,
                    ) {
                        Ok(response) => ScheduledCall::Immediate(Some(response)),
                        Err(_) => {
                            shared.transport.close();
                            ScheduledCall::Immediate(None)
                        }
                    };
                }
                record_rejection(&services, &call.method, RpcErrorCode::Overloaded);
                return ScheduledCall::Immediate(None);
            }
        },
        Some(ExecutionClass::Session | ExecutionClass::Control) => {
            match admission.controls.clone().try_acquire_owned() {
                Ok(permit) => Some(AdmissionPermits {
                    _connection: permit,
                    _global: None,
                }),
                Err(_) => {
                    shared.transport.close();
                    return ScheduledCall::Immediate(None);
                }
            }
        }
        None => None,
    };
    let Some(context) = shared
        .call_context(controls, id.clone(), guard_failures)
        .await
    else {
        if let Some(id) = id {
            outstanding.remove(&id);
        }
        return ScheduledCall::Immediate(None);
    };
    if class.is_none() {
        let error = if context.session.is_some() {
            RpcError::new(RpcErrorCode::MethodNotFound)
        } else {
            RpcError::with_message(RpcErrorCode::Unauthorized, "Authentication required")
        };
        record_rejection(&services, &call.method, error.code);
        return match id {
            Some(id) => {
                if matches!(destination, ResultDestination::Single) {
                    outstanding.remove(&id);
                }
                match prepare_response(RpcResponse::error(id, error), &budget) {
                    Ok(response) => ScheduledCall::Immediate(Some(response)),
                    Err(_) => {
                        shared.transport.close();
                        ScheduledCall::Immediate(None)
                    }
                }
            }
            None => ScheduledCall::Immediate(None),
        };
    }
    let method = call.method.clone();
    let activate_after_success =
        matches!(method.as_str(), "session.open" | "auth.createDevSession");
    let counts_toward_batch = id.is_some() || activate_after_success;
    let failure_transport = shared.transport.clone();
    supervise(
        async move {
            let _input_lease = input_lease;
            let _permits = permits;
            let response = methods::dispatch_call(&context, call, &services).await;
            let response = match response {
                Some(response) => match prepare_response(response, &budget) {
                    Ok(response) => Some(response),
                    Err(_) => {
                        shared.transport.close();
                        return;
                    }
                },
                None => None,
            };
            let result = WorkResult {
                id,
                destination,
                close_after_error,
                response,
                activate_after_success,
                counts_toward_batch,
            };
            let _ = results.send(result).await;
        },
        failure_transport,
    );
    ScheduledCall::Pending
}

struct BatchAssembly {
    pending: usize,
    responses: Vec<PreparedResponse>,
    request_ids: Vec<RpcId>,
    lifecycle: Option<RpcLifecycleFailure>,
    close_after_error: bool,
    activate_after_success: bool,
}

impl BatchAssembly {
    fn new() -> Self {
        Self {
            pending: 0,
            responses: Vec::new(),
            request_ids: Vec::new(),
            lifecycle: None,
            close_after_error: false,
            activate_after_success: false,
        }
    }

    fn push(&mut self, response: PreparedResponse, close_after_error: bool) {
        self.lifecycle = self.lifecycle.or(response.lifecycle);
        self.close_after_error |= close_after_error && !response.success;
        self.responses.push(response);
    }
}

async fn flush_batch(
    batch: BatchAssembly,
    sink: &RpcOutputSink,
    budget: &RpcByteBudget,
) -> Result<Option<RpcLifecycleFailure>, RpcIoError> {
    if batch.responses.is_empty() {
        return Ok(batch.lifecycle);
    }
    let bytes = 2
        + batch
            .responses
            .iter()
            .map(|response| response.frame.text.len())
            .sum::<usize>()
        + batch.responses.len().saturating_sub(1);
    if bytes > MAX_FRAME_BYTES {
        return Err(RpcIoError::FrameTooLarge);
    }
    let lease = budget.reserve(bytes)?;
    let mut text = String::with_capacity(bytes);
    text.push('[');
    for (index, response) in batch.responses.iter().enumerate() {
        if index != 0 {
            text.push(',');
        }
        text.push_str(&response.frame.text);
    }
    text.push(']');
    let lifecycle = batch.lifecycle;
    drop(batch);
    sink.send_prepared(PreparedFrame { text, lease }).await?;
    Ok(lifecycle)
}

async fn handle_lifecycle_failure(
    failure: RpcLifecycleFailure,
    shared: &Arc<SessionShared>,
    sink: &RpcOutputSink,
) {
    let _gate = shared.event_gate.lock().await;
    {
        let mut state = shared.state.lock().await;
        if state.lifecycle_notified {
            return;
        }
        state.accepting = false;
        state.lifecycle_notified = true;
    }
    let notification = match failure {
        RpcLifecycleFailure::Revoked => SessionNotification::Invalidated {
            reason: SessionInvalidatedReason::Revoked,
        },
        RpcLifecycleFailure::AuthLookupUnavailable => SessionNotification::Unavailable {
            reason: SessionUnavailableReason::AuthLookupUnavailable,
        },
    };
    match encode_session_notification(&notification) {
        Ok(text) => {
            let _ = sink.send_text(text).await;
        }
        Err(error) => tracing::error!(?error, "RPC session lifecycle serialization failed"),
    }
    shared.transport.close();
}

fn oversized_request_id(text: &str) -> Option<RpcId> {
    let Value::Object(mut object) = serde_json::from_str::<Value>(text).ok()? else {
        return None;
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    RpcId::from_value(object.remove("id")?)
}

/// Runs one complete RPC session using complete JSON messages. It owns
/// authentication, session transitions, registry registration, watchers and
/// revocation checks; the caller owns transport framing and writer I/O.
pub async fn serve_rpc_session(
    mut input: mpsc::Receiver<String>,
    output: mpsc::Sender<String>,
    dependencies: RpcSessionDeps,
) {
    let services = dependencies.services.clone();
    let sink = RpcOutputSink {
        tx: output,
        permits: dependencies.output_permits.clone(),
        pair_lock: dependencies.output_pair_lock.clone(),
        budget: dependencies.budget.clone(),
        state: dependencies.state.clone(),
    };
    let shared = SessionShared::new(dependencies.state.clone());
    let (controls_tx, controls_rx) = mpsc::channel(CONTROL_QUEUE);
    let (results_tx, mut results_rx) = mpsc::channel::<WorkResult>(RESULT_QUEUE);
    let (guard_tx, mut guard_rx) = mpsc::unbounded_channel();
    tokio::spawn(run_controls(controls_rx, shared.clone(), services.clone()));
    let admission = SessionAdmission {
        ordinary: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
        // One executing control and the existing bounded queue.
        controls: Arc::new(Semaphore::new(CONTROL_QUEUE + 1)),
    };
    let mut input_permits = dependencies.input_permits;
    let mut close = dependencies.state.close_subscription();
    let mut anonymous_tick = time::interval(Duration::from_secs(1));
    let mut first_message = true;
    let mut handshake_pending = false;
    let mut next_batch = 0_u64;
    let mut batches = HashMap::<u64, BatchAssembly>::new();
    let mut outstanding = HashSet::<RpcId>::new();

    'session: loop {
        if dependencies.state.is_closed() {
            break;
        }
        tokio::select! {
            _ = dependencies.state.wait_closed(&mut close) => break,
            Some(failure) = guard_rx.recv() => {
                handle_lifecycle_failure(failure, &shared, &sink).await;
                break;
            }
            _ = anonymous_tick.tick() => {
                if shared.anonymous_expired().await {
                    dependencies.state.close();
                    break;
                }
            }
            Some(result) = results_rx.recv() => {
                if matches!(result.destination, ResultDestination::Single) {
                    if let Some(id) = result.id {
                        outstanding.remove(&id);
                    }
                }
                match result.destination {
                    ResultDestination::Single => {
                        if let Some(response) = result.response {
                            let lifecycle = response.lifecycle;
                            let success = response.success;
                            if lifecycle.is_some() {
                                shared.suspend_authorized_work().await;
                            }
                            if sink.send_prepared(response.frame).await.is_err() {
                                dependencies.state.close();
                                break;
                            }
                            if result.activate_after_success && success {
                                shared.activate(&services, &sink).await;
                                if let Some((session, _)) = shared.bound_identity().await {
                                    tokio::spawn(generation_checks(
                                        shared.clone(),
                                        services.clone(),
                                        session,
                                        guard_tx.clone(),
                                    ));
                                }
                            }
                            if let Some(failure) = lifecycle {
                                handle_lifecycle_failure(failure, &shared, &sink).await;
                                break;
                            }
                            if result.close_after_error && !success {
                                dependencies.state.close();
                                break;
                            }
                        } else if result.activate_after_success {
                            shared.activate(&services, &sink).await;
                            if let Some((session, _)) = shared.bound_identity().await {
                                tokio::spawn(generation_checks(
                                    shared.clone(),
                                    services.clone(),
                                    session,
                                    guard_tx.clone(),
                                ));
                            }
                        }
                    }
                    ResultDestination::Batch(batch_id) => {
                        let response_lifecycle =
                            result.response.as_ref().and_then(|response| response.lifecycle);
                        if response_lifecycle.is_some() {
                            shared.suspend_authorized_work().await;
                        }
                        let mut ready = None;
                        if let Some(batch) = batches.get_mut(&batch_id) {
                            let activate_after_success = result.activate_after_success
                                && match &result.response {
                                    Some(response) => response.success,
                                    None => true,
                                };
                            batch.activate_after_success |= activate_after_success;
                            if result.counts_toward_batch {
                                batch.pending = batch.pending.saturating_sub(1);
                            }
                            if let Some(response) = result.response {
                                batch.push(response, result.close_after_error);
                            }
                            if batch.pending == 0 {
                                ready = batches.remove(&batch_id);
                            }
                        }
                        if let Some(mut batch) = ready {
                            let close_after_error = batch.close_after_error;
                            let activate_after_success = batch.activate_after_success;
                            let request_ids = std::mem::take(&mut batch.request_ids);
                            match flush_batch(batch, &sink, &dependencies.budget).await {
                                Ok(lifecycle) => {
                                    for id in request_ids {
                                        outstanding.remove(&id);
                                    }
                                    if let Some(failure) = lifecycle {
                                        handle_lifecycle_failure(failure, &shared, &sink).await;
                                        break;
                                    }
                                    if activate_after_success {
                                        shared.activate(&services, &sink).await;
                                        if let Some((session, _)) = shared.bound_identity().await {
                                            tokio::spawn(generation_checks(
                                                shared.clone(),
                                                services.clone(),
                                                session,
                                                guard_tx.clone(),
                                            ));
                                        }
                                    }
                                    if close_after_error {
                                        dependencies.state.close();
                                        break;
                                    }
                                }
                                Err(_) => {
                                    dependencies.state.close();
                                    break;
                                }
                            }
                        }
                    }
                }
                handshake_pending = false;
            }
            input_text = input.recv(), if !handshake_pending => {
                let Some(text) = input_text else { break; };
                let Some(lease) = input_permits.recv().await else {
                    dependencies.state.close();
                    break;
                };
                if matches!(&lease, InputLease::Oversized(_)) {
                    let InputLease::Oversized(lease) = lease else {
                        unreachable!("matched oversized input above");
                    };
                    // The terminal oversized input has consumed the full
                    // budget; release it before reserving the small 1013 frame.
                    drop(lease);
                    let id = oversized_request_id(&text);
                    drop(text);
                    if let Some(id) = id {
                        let response = RpcResponse::error(
                            id,
                            RpcError::new(RpcErrorCode::PayloadTooLarge),
                        );
                        match prepare_response(response, &dependencies.budget) {
                            Ok(response) => {
                                let _ = sink.send_prepared(response.frame).await;
                            }
                            Err(_) => {}
                        }
                    }
                    dependencies.state.close();
                    break;
                }
                let InputLease::Frame(input_lease) = lease else {
                    unreachable!("oversized frames return above");
                };
                let message = match parse_message(&text, MAX_BATCH_ITEMS) {
                    Ok(message) => message,
                    Err(response) => {
                        record_rejection(&services, "unknown", match &response.outcome {
                            super::protocol::RpcOutcome::Failure { error } => error.code,
                            super::protocol::RpcOutcome::Success { .. } => RpcErrorCode::InvalidRequest,
                        });
                        match prepare_response(response, &dependencies.budget) {
                            Ok(response) => {
                                if sink.send_prepared(response.frame).await.is_err() {
                                    dependencies.state.close();
                                    break;
                                }
                            }
                            Err(_) => {
                                dependencies.state.close();
                                break;
                            }
                        }
                        continue;
                    }
                };

                let opening_handshake = first_message;
                if first_message {
                    first_message = false;
                    let valid_open = matches!(
                        &message,
                        RpcMessage::Single(RpcItem::Call(RpcCall {
                            id: Some(RpcId::String(_) | RpcId::Number(_)),
                            method,
                            ..
                        })) if method == "session.open"
                    );
                    if !valid_open {
                        record_rejection(&services, "unknown", RpcErrorCode::InvalidRequest);
                        match prepare_response(RpcResponse::invalid_request(), &dependencies.budget) {
                            Ok(response) => {
                                let _ = sink.send_prepared(response.frame).await;
                            }
                            Err(_) => {}
                        }
                        dependencies.state.close();
                        break;
                    }
                    // Do not admit another frame until the first identity and
                    // its response are settled, even if work tasks poll out of order.
                    handshake_pending = true;
                }

                match message {
                    RpcMessage::Single(RpcItem::Response) => {}
                    RpcMessage::Single(RpcItem::Invalid(response)) => {
                        record_rejection(&services, "unknown", RpcErrorCode::InvalidRequest);
                        match prepare_response(response, &dependencies.budget) {
                            Ok(response) => {
                                if sink.send_prepared(response.frame).await.is_err() {
                                    dependencies.state.close();
                                    break;
                                }
                            }
                            Err(_) => {
                                dependencies.state.close();
                                break;
                            }
                        }
                    }
                    RpcMessage::Single(RpcItem::Call(call)) => {
                        let close_after_error = opening_handshake;
                        match schedule_call(
                            call,
                            ResultDestination::Single,
                            close_after_error,
                            shared.clone(),
                            services.clone(),
                            controls_tx.clone(),
                            guard_tx.clone(),
                            results_tx.clone(),
                            &mut outstanding,
                            &admission,
                            dependencies.budget.clone(),
                            Some(input_lease),
                        ).await {
                            ScheduledCall::Pending => {}
                            ScheduledCall::Immediate(Some(response)) => {
                                if sink.send_prepared(response.frame).await.is_err() {
                                    dependencies.state.close();
                                    break;
                                }
                            }
                            ScheduledCall::Immediate(None) => {}
                            ScheduledCall::Duplicate => {
                                record_rejection(&services, "unknown", RpcErrorCode::InvalidRequest);
                                if let Ok(response) = prepare_response(
                                    RpcResponse::invalid_request(),
                                    &dependencies.budget,
                                ) {
                                    let _ = sink.send_prepared(response.frame).await;
                                }
                                dependencies.state.close();
                                break;
                            }
                        }
                    }
                    RpcMessage::Batch(items) => {
                        let batch_id = next_batch;
                        next_batch = next_batch.wrapping_add(1);
                        let mut batch = BatchAssembly::new();
                        for item in items {
                            match item {
                                RpcItem::Response => {}
                                RpcItem::Invalid(response) => {
                                    record_rejection(&services, "unknown", RpcErrorCode::InvalidRequest);
                                    match prepare_response(response, &dependencies.budget) {
                                        Ok(response) => batch.push(response, false),
                                        Err(_) => {
                                            dependencies.state.close();
                                            break 'session;
                                        }
                                    }
                                }
                                RpcItem::Call(call) => {
                                    if let Some(id) = &call.id {
                                        batch.request_ids.push(id.clone());
                                    }
                                    let counts_toward_batch = call.id.is_some()
                                        || matches!(
                                            call.method.as_str(),
                                            "session.open" | "auth.createDevSession"
                                        );
                                    if counts_toward_batch {
                                        batch.pending += 1;
                                    }
                                    match schedule_call(
                                        call,
                                        ResultDestination::Batch(batch_id),
                                        false,
                                        shared.clone(),
                                        services.clone(),
                                        controls_tx.clone(),
                                        guard_tx.clone(),
                                        results_tx.clone(),
                                        &mut outstanding,
                                        &admission,
                                        dependencies.budget.clone(),
                                        Some(input_lease.retain_for_dispatch()),
                                    ).await {
                                        ScheduledCall::Pending => {}
                                        ScheduledCall::Immediate(response) => {
                                            if counts_toward_batch {
                                                batch.pending = batch.pending.saturating_sub(1);
                                                if let Some(response) = response {
                                                    batch.push(response, false);
                                                }
                                            }
                                        }
                                        ScheduledCall::Duplicate => {
                                            record_rejection(&services, "unknown", RpcErrorCode::InvalidRequest);
                                            if let Ok(response) = prepare_response(
                                                RpcResponse::invalid_request(),
                                                &dependencies.budget,
                                            ) {
                                                let _ = sink.send_prepared(response.frame).await;
                                            }
                                            dependencies.state.close();
                                            break 'session;
                                        }
                                    }
                                }
                            }
                        }
                        if batch.pending == 0 {
                            let request_ids = std::mem::take(&mut batch.request_ids);
                            match flush_batch(batch, &sink, &dependencies.budget).await {
                                Ok(lifecycle) => {
                                    for id in request_ids {
                                        outstanding.remove(&id);
                                    }
                                    if let Some(failure) = lifecycle {
                                        handle_lifecycle_failure(failure, &shared, &sink).await;
                                        break;
                                    }
                                }
                                Err(_) => {
                                    dependencies.state.close();
                                    break;
                                }
                            }
                        } else {
                            batches.insert(batch_id, batch);
                        }
                    }
                }
            }
        }
    }

    dependencies.state.close();
    shared.remove_registration(&services).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn budget(bytes: usize) -> RpcByteBudget {
        RpcByteBudget {
            permits: Arc::new(Semaphore::new(bytes)),
        }
    }

    async fn receive_json(output: &mut RpcSessionOutput) -> Value {
        timeout(Duration::from_secs(5), async {
            loop {
                let frame = output.recv().await.expect("RPC output remains open");
                let (text, _lease) = frame.into_parts();
                let message: Value = serde_json::from_str(&text).expect("valid JSON-RPC message");
                if message["method"]
                    .as_str()
                    .is_some_and(|method| method.starts_with("events."))
                {
                    continue;
                }
                return message;
            }
        })
        .await
        .expect("RPC protocol response deadline")
    }

    async fn open_authenticated(
        services: RpcServices,
        token: String,
    ) -> (
        RpcSessionInput,
        RpcSessionOutput,
        tokio::task::JoinHandle<()>,
    ) {
        let (input_rx, output_tx, dependencies, transport) = rpc_session_channels(services);
        let task = tokio::spawn(serve_rpc_session(input_rx, output_tx, dependencies));
        let RpcSessionTransport { input, mut output } = transport;
        input
            .send(
                json!({
                    "jsonrpc": "2.0",
                    "id": "open",
                    "method": "session.open",
                    "params": {
                        "protocolVersion": 1,
                        "token": token,
                        "appVersion": "rpc-session-test",
                    },
                })
                .to_string(),
            )
            .await
            .expect("session input accepts handshake");
        let response = receive_json(&mut output).await;
        assert_eq!(response["id"], "open");
        assert_eq!(response["result"]["authenticated"], true);
        (input, output, task)
    }

    async fn close_session(
        input: RpcSessionInput,
        output: RpcSessionOutput,
        task: tokio::task::JoinHandle<()>,
    ) {
        input.close();
        drop(input);
        drop(output);
        timeout(Duration::from_secs(5), task)
            .await
            .expect("RPC session cleanup deadline")
            .expect("RPC session completes successfully");
    }

    #[tokio::test]
    async fn authenticated_session_verifies_once_across_operations_and_refresh() {
        let Some(services) = crate::rpc::test_support::services().await else {
            return;
        };
        let token = services
            .auth_token_service
            .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
            .unwrap();
        let (input, mut output, task) = open_authenticated(services.clone(), token.clone()).await;
        assert_eq!(services.auth_token_service.verifier_invocations(), 1);

        for id in 0..10 {
            input
                .send(
                    json!({
                        "jsonrpc": "2.0",
                        "id": format!("ping-{id}"),
                        "method": "session.ping",
                        "params": {},
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            let response = receive_json(&mut output).await;
            assert_eq!(response["id"], format!("ping-{id}"));
            assert_eq!(response["result"], Value::Null);
        }
        for id in 0..10 {
            input
                .send(
                    json!({
                        "jsonrpc": "2.0",
                        "id": format!("me-{id}"),
                        "method": "users.getMe",
                        "params": {},
                    })
                    .to_string(),
                )
                .await
                .unwrap();
            let response = receive_json(&mut output).await;
            assert_eq!(response["id"], format!("me-{id}"));
            assert_eq!(response["result"]["uid"], 1);
        }
        input
            .send(
                json!({
                    "jsonrpc": "2.0",
                    "id": "refresh",
                    "method": "auth.refresh",
                    "params": {},
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(receive_json(&mut output).await["result"]["token"].is_string());
        assert_eq!(services.auth_token_service.verifier_invocations(), 1);
        close_session(input, output, task).await;

        let (input, output, task) = open_authenticated(services.clone(), token).await;
        assert_eq!(services.auth_token_service.verifier_invocations(), 2);
        close_session(input, output, task).await;
    }

    #[tokio::test]
    async fn in_memory_session_keeps_protocol_errors_and_duplicate_ids_transport_neutral() {
        let Some(services) = crate::rpc::test_support::services().await else {
            return;
        };
        let token = services
            .auth_token_service
            .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
            .unwrap();
        let (input, mut output, task) = open_authenticated(services, token).await;

        input.send("{".into()).await.unwrap();
        assert_eq!(receive_json(&mut output).await["error"]["code"], -32700);

        input
            .send(
                json!([
                    {
                        "jsonrpc": "2.0",
                        "id": "ping",
                        "method": "session.ping",
                        "params": {},
                    },
                    {
                        "jsonrpc": "2.0",
                        "id": "missing",
                        "method": "unknown.operation",
                        "params": {},
                    },
                    {
                        "jsonrpc": "2.0",
                        "method": "session.setAppState",
                        "params": {},
                    },
                ])
                .to_string(),
            )
            .await
            .unwrap();
        let batch = receive_json(&mut output).await;
        let responses = batch.as_array().expect("batch response");
        assert_eq!(responses.len(), 2);
        assert!(responses
            .iter()
            .any(|response| response["id"] == "ping" && response.get("result").is_some()));
        assert!(responses
            .iter()
            .any(|response| response["id"] == "missing" && response["error"]["code"] == -32601));

        input
            .send(
                json!([
                    {
                        "jsonrpc": "2.0",
                        "id": "duplicate",
                        "method": "session.ping",
                        "params": {},
                    },
                    {
                        "jsonrpc": "2.0",
                        "id": "duplicate",
                        "method": "session.ping",
                        "params": {},
                    },
                ])
                .to_string(),
            )
            .await
            .unwrap();
        let duplicate = receive_json(&mut output).await;
        assert_eq!(duplicate["id"], Value::Null);
        assert_eq!(duplicate["error"]["code"], -32600);
        close_session(input, output, task).await;
    }

    #[tokio::test]
    async fn revocation_rejects_the_correlated_call_before_session_invalidation() {
        let Some(services) = crate::rpc::test_support::services().await else {
            return;
        };
        let token = services
            .auth_token_service
            .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
            .unwrap();
        let (input, mut output, task) = open_authenticated(services.clone(), token).await;
        {
            let mut connection = services.db.get().unwrap();
            services.token_generation.bump(&mut connection, 1).unwrap();
        }

        input
            .send(
                json!({
                    "jsonrpc": "2.0",
                    "id": "after-revocation",
                    "method": "session.ping",
                    "params": {},
                })
                .to_string(),
            )
            .await
            .unwrap();
        let rejected = receive_json(&mut output).await;
        assert_eq!(rejected["id"], "after-revocation");
        assert_eq!(rejected["error"]["code"], 1001);
        let invalidated = receive_json(&mut output).await;
        assert_eq!(invalidated["method"], "session.invalidated");
        assert_eq!(invalidated["params"]["reason"], "revoked");
        close_session(input, output, task).await;
    }

    #[test]
    fn byte_leases_cover_active_outbound_frames_until_the_writer_drops_them() {
        let budget = budget(3);
        let lease = budget.reserve(3).unwrap();
        assert!(matches!(
            budget.reserve(1),
            Err(RpcIoError::BudgetExhausted)
        ));
        drop(lease);
        assert!(budget.reserve(3).is_ok());
    }

    #[tokio::test]
    async fn outbound_pair_keeps_bytes_reserved_through_transport_consumption() {
        let budget = budget(3);
        let state = TransportState::new();
        let (tx, mut rx) = mpsc::channel(1);
        let (permit_tx, mut permit_rx) = mpsc::channel(1);
        let sink = RpcOutputSink {
            tx,
            permits: permit_tx,
            pair_lock: Arc::new(Mutex::new(())),
            budget: budget.clone(),
            state,
        };

        sink.send_text("rpc".into()).await.unwrap();
        assert_eq!(rx.recv().await.as_deref(), Some("rpc"));
        assert!(matches!(
            budget.reserve(1),
            Err(RpcIoError::BudgetExhausted)
        ));
        let lease = permit_rx.recv().await.unwrap();
        drop(lease);
        assert!(budget.reserve(3).is_ok());
    }

    #[test]
    fn oversized_correlatable_request_preserves_numeric_id_without_precision_loss() {
        let id = oversized_request_id(
            r#"{"jsonrpc":"2.0","id":9007199254740993,"method":"messages.list"}"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(id).unwrap(),
            json!(9007199254740993_u64)
        );
    }

    #[tokio::test]
    async fn batch_assembly_reserves_the_complete_array_before_enqueueing() {
        let response = RpcResponse::success(RpcId::String("a".into()), json!(1));
        let member_bytes = serde_json::to_string(&response).unwrap().len();
        let budget = budget(member_bytes + 1);
        let response = prepare_response(response, &budget).unwrap();
        let mut batch = BatchAssembly::new();
        batch.push(response, false);
        let sink = RpcOutputSink {
            tx: mpsc::channel(1).0,
            permits: mpsc::channel(1).0,
            pair_lock: Arc::new(Mutex::new(())),
            budget: budget.clone(),
            state: TransportState::new(),
        };
        assert!(matches!(
            flush_batch(batch, &sink, &budget).await,
            Err(RpcIoError::BudgetExhausted)
        ));
    }

    #[tokio::test]
    async fn inbound_pair_holds_its_byte_lease_until_core_dispatch_takes_it() {
        let budget = budget(3);
        let state = TransportState::new();
        let (tx, mut rx) = mpsc::channel(1);
        let (permit_tx, mut permit_rx) = mpsc::channel(1);
        let input = RpcSessionInput {
            tx,
            permits: permit_tx,
            pair_lock: Arc::new(Mutex::new(())),
            budget: budget.clone(),
            state: state.clone(),
        };

        input.send("rpc".into()).await.unwrap();
        assert_eq!(rx.recv().await.as_deref(), Some("rpc"));
        assert!(matches!(
            budget.reserve(1),
            Err(RpcIoError::BudgetExhausted)
        ));
        let InputLease::Frame(lease) = permit_rx.recv().await.unwrap() else {
            panic!("normal frame must carry a byte lease");
        };
        drop(lease);
        assert!(budget.reserve(3).is_ok());

        input.close();
        assert_eq!(input.send("x".into()).await, Err(RpcIoError::Closed));
    }

    mod activity_tests;

    mod lease_safety_tests;

    mod watch_publication_tests;

    mod protocol_tests;

    mod batch_id_tests;
}

#[cfg(test)]
mod publication_tests;
