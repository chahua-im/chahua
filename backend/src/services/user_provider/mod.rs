//! Provider-owned user data: identity, profile and avatar.
//!
//! Everything behind this trait is owned by the identity provider and read-only
//! for wetty-chat. Methods are batch and async so the implementation can move
//! out of process without changing callers.

mod discuz;

pub(crate) use discuz::DiscuzProvider;

use std::collections::HashMap;

use async_trait::async_trait;

use crate::dto::users::UserGroupTagInfo;
use crate::errors::AppError;

#[derive(Debug, Clone)]
pub(crate) struct UserProfile {
    pub username: Option<String>,
    pub gender: i16,
    pub user_group: Option<UserGroupTagInfo>,
}

/// A provider read failed. Batch lookups report missing users by omitting their
/// key, so there is no `NotFound`: every variant is an infrastructure failure.
#[derive(Debug)]
pub(crate) enum ProviderError {
    Transient(String),
}

impl From<ProviderError> for AppError {
    fn from(value: ProviderError) -> Self {
        let ProviderError::Transient(detail) = value;
        tracing::error!(detail = %detail, "user provider read failed");
        AppError::ServiceUnavailable("User provider unavailable")
    }
}

#[async_trait]
pub(crate) trait UserProvider: Send + Sync {
    /// Profiles for the requested uids. Unknown uids are absent from the map.
    async fn lookup_profiles(
        &self,
        uids: &[i32],
    ) -> Result<HashMap<i32, UserProfile>, ProviderError>;

    /// Avatar URL per uid. `None` value means the provider has no avatar for a
    /// known user; an absent key means avatar resolution is not configured.
    async fn lookup_avatar_urls(
        &self,
        uids: &[i32],
    ) -> Result<HashMap<i32, Option<String>>, ProviderError>;

    /// Uids whose username starts with `prefix`, ascending, capped at `limit`.
    async fn search_uids_by_username_prefix(
        &self,
        prefix: &str,
        limit: i64,
    ) -> Result<Vec<i32>, ProviderError>;
}
