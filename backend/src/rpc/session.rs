//! Transport-independent JSON-RPC session runtime.
//!
//! The WebSocket adapter owns framing, upgrade negotiation and protocol
//! ping/pong. This module receives and emits complete JSON strings so the same
//! engine can be used by an in-memory or future stream transport.
//!
//! Reads and mutations share process-wide admission, with at most 16 running
//! calls per connection and per account, and 128 per process. Waiting calls
//! are served round-robin by account, with at most 256 waiting per process,
//! 64 per account, and a five-second wait. Full or expired queues return
//! Overloaded without dispatch. Closing a connection cancels its waiting calls,
//! but already running operations retain their slots until they finish.
//! Session and control calls use their separate bounded, serial lane.
//! Unauthenticated reads and mutations are rejected before admission or task creation.
//! Incoming and outgoing messages are limited to 1 MiB. Bounded message queues
//! provide backpressure without per-message byte leases.
//! The WebSocket decoder rejects oversized input with close code 1009 before
//! JSON parsing. Oversized RPC results become PayloadTooLarge responses;
//! oversized aggregate batches or pushed events close the session.
//!
//! Private submodules own transport accounting, response preparation, session
//! state, publishers, controls, execution, and batch assembly. This module keeps
//! the directly driven public session API.

mod admission;
mod batches;
mod controls;
mod execution;
mod io;
mod publishers;
mod response;
mod runtime;
mod state;

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{mpsc, Semaphore},
    time::{self, Instant},
};

use controls::{handle_lifecycle_failure, run_controls};
use execution::{SessionAdmission, SessionExecution, WorkResult};
use io::RpcOutputSink;
use runtime::SessionLoop;
use state::SessionShared;

// The public session API is independent of its private implementation modules.
pub(crate) use controls::SyncControlSlot;
pub use controls::{ControlReply, RpcControlCommand};
pub(crate) use io::RpcSessionCloser;
pub use io::{RpcIoError, RpcSessionOutput};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_BATCH_ITEMS: usize = 32;
pub const MAX_IN_FLIGHT: usize = 16;
pub const MAX_GLOBAL_IN_FLIGHT: usize = 128;
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);

const RESULT_QUEUE: usize = 16;
const OUTPUT_QUEUE: usize = 16;
const CONTROL_QUEUE: usize = 8;
const ANONYMOUS_SESSION_TIMEOUT: Duration = Duration::from_secs(30);
const REVOCATION_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const PRESENCE_REFRESH_INTERVAL: Duration = Duration::from_secs(15);

/// A transport-independent engine driven directly by the connection task.
pub struct RpcSession {
    session: SessionLoop,
    results: mpsc::Receiver<WorkResult>,
    guard_failures: mpsc::UnboundedReceiver<super::error::RpcLifecycleFailure>,
    anonymous_tick: time::Interval,
}

/// An engine event. Receiving it has no side effects; handling it must run to completion.
pub struct RpcSessionEvent(SessionEventKind);

enum SessionEventKind {
    Closed,
    Guard(super::error::RpcLifecycleFailure),
    Result(WorkResult),
    Tick,
}

impl RpcSession {
    pub fn new(services: super::AppState) -> (Self, RpcSessionOutput) {
        let (tx, rx) = mpsc::channel(OUTPUT_QUEUE);
        let session = Self::with_channels(
            services,
            execution::GLOBAL_ADMISSION.clone(),
            io::TransportState::new(),
            tx,
        );
        (session, RpcSessionOutput { rx })
    }

    fn with_channels(
        services: super::AppState,
        ordinary_admission: Arc<admission::Admission>,
        state: Arc<io::TransportState>,
        output: mpsc::Sender<String>,
    ) -> Self {
        let sink = RpcOutputSink {
            tx: output,
            state: state.clone(),
        };
        let shared = SessionShared::new(state);
        let (controls_tx, controls_rx) = mpsc::channel(CONTROL_QUEUE);
        let (results_tx, results) = mpsc::channel(RESULT_QUEUE);
        let (guard_tx, guard_failures) = mpsc::unbounded_channel();
        tokio::spawn(run_controls(
            controls_rx,
            shared.clone(),
            services.clone(),
            sink.clone(),
        ));
        let execution = SessionExecution {
            shared,
            services,
            controls: controls_tx,
            guard_failures: guard_tx,
            results: results_tx,
            admission: SessionAdmission {
                ordinary: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
                controls: Arc::new(Semaphore::new(CONTROL_QUEUE + 1)),
            },
            ordinary_admission,
            next_sync_seq: 0,
        };
        Self {
            session: SessionLoop {
                execution,
                sink,
                first_message: true,
                handshake_pending: false,
                next_batch: 0,
                batches: HashMap::new(),
                outstanding: HashSet::new(),
            },
            results,
            guard_failures,
            anonymous_tick: time::interval(Duration::from_secs(1)),
        }
    }

    pub fn accepts_input(&self) -> bool {
        !self.session.handshake_pending && !self.session.execution.shared.transport.is_closed()
    }

    /// Cancellation-safe: only receives an event, never starts handling it.
    pub async fn next_event(&mut self) -> RpcSessionEvent {
        let shared = &self.session.execution.shared;
        let mut close = shared.transport.close_subscription();
        let event = tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => SessionEventKind::Closed,
            Some(failure) = self.guard_failures.recv() => SessionEventKind::Guard(failure),
            Some(result) = self.results.recv() => SessionEventKind::Result(result),
            _ = self.anonymous_tick.tick() => SessionEventKind::Tick,
        };
        RpcSessionEvent(event)
    }

    pub async fn handle_event(&mut self, event: RpcSessionEvent) -> std::ops::ControlFlow<()> {
        match event.0 {
            SessionEventKind::Closed => std::ops::ControlFlow::Break(()),
            SessionEventKind::Guard(failure) => {
                handle_lifecycle_failure(
                    failure,
                    &self.session.execution.shared,
                    &self.session.sink,
                )
                .await;
                std::ops::ControlFlow::Break(())
            }
            SessionEventKind::Result(result) => self.session.handle_work_result(result).await,
            SessionEventKind::Tick => {
                if self.session.execution.shared.anonymous_expired().await {
                    self.close();
                    std::ops::ControlFlow::Break(())
                } else {
                    std::ops::ControlFlow::Continue(())
                }
            }
        }
    }

    pub async fn handle_text(&mut self, text: String) -> std::ops::ControlFlow<()> {
        let started = Instant::now();
        if self.session.execution.shared.transport.is_closed() {
            return std::ops::ControlFlow::Break(());
        }
        if text.len() > MAX_FRAME_BYTES {
            self.session.execution.services.metrics.api.record(
                "rpc",
                "unknown",
                super::error::RpcErrorCode::PayloadTooLarge.metric_status(),
                super::error::RpcErrorCode::PayloadTooLarge.metric_code(),
                started.elapsed().as_secs_f64(),
            );
            self.close();
            return std::ops::ControlFlow::Break(());
        }
        self.session.handle_input_frame(text, started).await
    }

    pub fn close(&self) {
        self.session.execution.shared.transport.close();
    }

    pub async fn shutdown(&self) {
        self.close();
        self.session
            .execution
            .shared
            .remove_registration(&self.session.execution.services)
            .await;
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod publication_tests;
