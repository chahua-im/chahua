//! Shared application state.
//!
//! [`AppState`] shares one `Arc<AppServices>` between HTTP handlers and RPC
//! sessions. Axum clones state for each request; this keeps each clone to one
//! reference-count increment. Domain services hold only their own dependencies.

use axum::extract::FromRef;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use std::ops::Deref;
use std::sync::Arc;

use crate::config::AppConfig;
use crate::metrics::Metrics;
use crate::services::auth_token::AuthTokenService;
use crate::services::authz::AuthorizationService;
use crate::services::avatars::AvatarService;
use crate::services::background::BackgroundService;
use crate::services::client_tracking::ClientTrackingService;
use crate::services::link_previews::LinkPreviewService;
use crate::services::media::MediaStore;
use crate::services::message_search::MessageSearchService;
use crate::services::presence::PresenceSnapshotService;
use crate::services::push::PushService;
use crate::services::token_generation::TokenGenerationService;
use crate::services::unread::UnreadService;
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::ids::IdGen;

pub type DbPool = Pool<ConnectionManager<PgConnection>>;

pub struct AppServices {
    pub db: DbPool,
    pub id_gen: Arc<IdGen>,
    pub metrics: Arc<Metrics>,
    pub config: Arc<AppConfig>,
    /// Object storage for attachments, avatars and stickers.
    pub media: MediaStore,
    /// Discuz user-avatar resolution.
    pub avatars: Arc<AvatarService>,
    pub link_previews: Arc<LinkPreviewService>,
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
    pub messages: Arc<crate::services::api::chats::messages::MessagesService>,
    pub friends: Arc<crate::services::api::friends::FriendsService>,
    pub invites: Arc<crate::services::api::invites::InvitesService>,
    pub members: Arc<crate::services::api::members::MembersService>,
    pub pins: Arc<crate::services::api::pins::PinsService>,
    pub reactions: Arc<crate::services::api::chats::reactions::ReactionsService>,
    pub dev_sessions: Arc<crate::services::api::auth::DevSessionsService>,
}

#[derive(Clone)]
pub struct AppState(Arc<AppServices>);

impl AppState {
    pub fn new(inner: AppServices) -> Self {
        Self(Arc::new(inner))
    }
}

/// Exposes the startup-built services without copying their handles.
impl Deref for AppState {
    type Target = AppServices;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl FromRef<AppState> for DbPool {
    fn from_ref(state: &AppState) -> Self {
        state.db.clone()
    }
}

impl FromRef<AppState> for Arc<AvatarService> {
    fn from_ref(state: &AppState) -> Self {
        state.avatars.clone()
    }
}

impl FromRef<AppState> for MediaStore {
    fn from_ref(state: &AppState) -> Self {
        state.media.clone()
    }
}

impl FromRef<AppState> for Arc<Metrics> {
    fn from_ref(state: &AppState) -> Self {
        state.metrics.clone()
    }
}
