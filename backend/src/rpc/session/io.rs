use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tokio::{
    sync::{mpsc, watch},
    time::timeout,
};

use super::{MAX_FRAME_BYTES, SEND_TIMEOUT};

/// Errors exposed by the transport-neutral input side.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RpcIoError {
    Closed,
    FrameTooLarge,
}

pub(super) struct TransportState {
    closed: AtomicBool,
    close_tx: watch::Sender<bool>,
}

impl TransportState {
    pub(super) fn new() -> Arc<Self> {
        let (close_tx, _) = watch::channel(false);
        Arc::new(Self {
            closed: AtomicBool::new(false),
            close_tx,
        })
    }

    pub(super) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(super) fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.close_tx.send_replace(true);
        }
    }

    pub(super) fn close_subscription(&self) -> watch::Receiver<bool> {
        self.close_tx.subscribe()
    }

    /// Waits for shutdown as a level-triggered condition. A watcher created
    /// after `close` must not wait for another state transition that will
    /// never occur.
    pub(super) async fn wait_closed(&self, close: &mut watch::Receiver<bool>) {
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
    pub(super) state: Arc<TransportState>,
}

impl RpcSessionCloser {
    pub(crate) fn close(&self) {
        self.state.close();
    }
}

/// Receiver owned by a transport writer.
pub struct RpcSessionOutput {
    pub(super) rx: mpsc::Receiver<String>,
}

impl RpcSessionOutput {
    pub async fn recv(&mut self) -> Option<String> {
        self.rx.recv().await
    }
}

#[derive(Clone)]
pub(super) struct RpcOutputSink {
    pub(super) tx: mpsc::Sender<String>,
    pub(super) state: Arc<TransportState>,
}

impl RpcOutputSink {
    pub(super) async fn send_text(&self, text: String) -> Result<(), super::RpcIoError> {
        if text.len() > MAX_FRAME_BYTES {
            self.state.close();
            return Err(RpcIoError::FrameTooLarge);
        }
        let sent = timeout(SEND_TIMEOUT, async {
            if self.state.is_closed() {
                return Err(RpcIoError::Closed);
            }
            let mut close = self.state.close_subscription();
            let slot = tokio::select! {
                slot = self.tx.reserve() => slot.map_err(|_| RpcIoError::Closed)?,
                () = self.state.wait_closed(&mut close) => return Err(RpcIoError::Closed),
            };
            if self.state.is_closed() {
                return Err(RpcIoError::Closed);
            }
            slot.send(text);
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
