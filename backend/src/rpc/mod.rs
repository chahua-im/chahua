pub mod error;
pub mod events;
pub mod methods;
pub mod protocol;
pub mod schema;
pub mod session;

#[cfg(test)]
pub(crate) mod test_support;

use std::sync::Arc;

use crate::errors::AppError;
use crate::services::{auth_token::VerifiedSession, authentication::Principal};
use crate::AppState;

#[derive(Clone)]
pub struct RpcCallContext {
    /// Retained identity is set only after the session control lane has
    /// completed a successful bind. It is never reconstructed from a request.
    pub session: Option<Arc<VerifiedSession>>,
    pub connection_id: u64,
    pub rpc_id: Option<protocol::RpcId>,
    pub(crate) message_sync_enabled: bool,
    pub(crate) sync_control: Option<Arc<session::SyncControlSlot>>,
    pub controls: tokio::sync::mpsc::Sender<session::RpcControlCommand>,
    /// Notification calls have no response through which a typed generation
    /// guard failure can reach the engine, so they report it out-of-band.
    pub(crate) guard_failures:
        Option<tokio::sync::mpsc::UnboundedSender<error::RpcLifecycleFailure>>,
    /// Only the bounded control bridge uses this: overflowing that serial
    /// lane is connection abuse, so it closes rather than accumulating waiters.
    pub(crate) close_session: Option<session::RpcSessionCloser>,
}

impl RpcCallContext {
    pub fn verified_session(&self) -> Result<&VerifiedSession, AppError> {
        self.session
            .as_deref()
            .ok_or(AppError::Unauthorized("Authentication required"))
    }

    pub fn uid(&self) -> Result<i32, AppError> {
        Ok(self.verified_session()?.uid)
    }

    pub fn principal(&self) -> Result<Principal, AppError> {
        Ok(Principal::User { uid: self.uid()? })
    }
}
