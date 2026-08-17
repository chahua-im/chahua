//! Shared application state.
//!
//! [`AppState`] is a newtype over `Arc<AppInner>` that `Deref`s to the inner
//! struct, which is the shape axum documents for state that needs `FromRef`
//! substates (see `axum_extra::extract::cookie::PrivateCookieJar`). axum clones
//! the router state on every request, so keeping the payload behind one `Arc`
//! makes that clone a single refcount bump no matter how many fields accumulate.

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
use crate::services::media::MediaStore;
use crate::services::message_search::MessageSearchService;
use crate::services::push::PushService;
use crate::services::unread::UnreadService;
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::ids::IdGen;

pub type DbPool = Pool<ConnectionManager<PgConnection>>;

pub struct AppInner {
    pub db: DbPool,
    pub id_gen: Arc<IdGen>,
    pub metrics: Arc<Metrics>,
    pub config: Arc<AppConfig>,
    /// Object storage for attachments, avatars and stickers.
    pub media: MediaStore,
    /// Discuz user-avatar resolution.
    pub avatars: Arc<AvatarService>,
    pub authz_service: Arc<AuthorizationService>,
    pub ws_registry: Arc<ConnectionRegistry>,
    pub push_service: Arc<PushService>,
    pub unread_service: Arc<UnreadService>,
    pub client_tracking: Arc<ClientTrackingService>,
    pub background_service: Arc<BackgroundService>,
    pub message_search: Option<Arc<MessageSearchService>>,
    pub auth_token_service: Arc<AuthTokenService>,
}

#[derive(Clone)]
pub struct AppState(Arc<AppInner>);

impl AppState {
    pub fn new(inner: AppInner) -> Self {
        Self(Arc::new(inner))
    }
}

/// Lets every existing `state.db` / `state.metrics` access keep working while
/// the payload sits behind a single `Arc`.
impl Deref for AppState {
    type Target = AppInner;

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
