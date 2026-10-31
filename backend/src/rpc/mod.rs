pub mod error;
pub mod events;
pub mod methods;
pub mod protocol;
pub mod schema;
pub mod session;

#[cfg(test)]
pub(crate) mod test_support;

use std::ops::Deref;
use std::sync::Arc;

use crate::config::AppConfig;
use crate::errors::AppError;
use crate::metrics::Metrics;
use crate::services::{
    auth_token::{AuthTokenService, VerifiedSession},
    authentication::Principal,
    authz::AuthorizationService,
    avatars::AvatarService,
    background::BackgroundService,
    client_tracking::ClientTrackingService,
    media::MediaStore,
    message_search::MessageSearchService,
    presence::PresenceSnapshotService,
    push::PushService,
    token_generation::TokenGenerationService,
    unread::UnreadService,
    ws_registry::ConnectionRegistry,
};
use crate::state::DbPool;
use crate::utils::ids::IdGen;

/// Owned composition root shared by RPC dispatch workers, not an operation dependency.
pub struct RpcServiceHandles {
    pub db: DbPool,
    pub id_gen: Arc<IdGen>,
    pub metrics: Arc<Metrics>,
    pub config: Arc<AppConfig>,
    pub media: MediaStore,
    pub avatars: Arc<AvatarService>,
    pub authz_service: Arc<AuthorizationService>,
    pub ws_registry: Arc<ConnectionRegistry>,
    pub presence_service: Arc<PresenceSnapshotService>,
    pub push_service: Arc<PushService>,
    pub unread_service: Arc<UnreadService>,
    pub client_tracking: Arc<ClientTrackingService>,
    pub background_service: Arc<BackgroundService>,
    pub message_search: Option<Arc<MessageSearchService>>,
    pub auth_token_service: Arc<AuthTokenService>,
    pub token_generation: Arc<TokenGenerationService>,
}

#[derive(Clone)]
pub struct RpcServices(Arc<RpcServiceHandles>);

impl RpcServices {
    pub fn new(handles: RpcServiceHandles) -> Self {
        Self(Arc::new(handles))
    }
}

impl Deref for RpcServices {
    type Target = RpcServiceHandles;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[derive(Clone)]
pub struct RpcCallContext {
    /// Retained identity is set only after the session control lane has
    /// completed a successful bind. It is never reconstructed from a request.
    pub session: Option<Arc<VerifiedSession>>,
    pub connection_id: u64,
    pub rpc_id: Option<protocol::RpcId>,
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
