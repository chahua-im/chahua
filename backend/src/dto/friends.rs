use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    dto::users::MemberSummary,
    models::{FriendAddVerificationMode, FriendRequestStatus},
};

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendResponse {
    pub user: MemberSummary,
    pub since: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListFriendsResponse {
    pub friends: Vec<FriendResponse>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub from: MemberSummary,
    pub to: MemberSummary,
    pub status: FriendRequestStatus,
    pub created_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
    /// Verification message (mode 1) or the requester's answer (mode 3); absent for direct.
    pub message: Option<String>,
    /// Snapshot of the target's question (mode 3 only); absent otherwise.
    pub question: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListFriendRequestsResponse {
    pub requests: Vec<FriendRequestResponse>,
}

/// A user's own friend-acceptance settings (GET /me/friend-settings).
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendSettingsResponse {
    pub mode: FriendAddVerificationMode,
    pub question: Option<String>,
}

/// Body for PUT /me/friend-settings.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFriendSettingsBody {
    pub mode: FriendAddVerificationMode,
    #[schema(max_length = 100)]
    pub question: Option<String>,
}

/// What a requester needs to know to render the add-friend UI for a target
/// (GET /users/:uid/friend-add-info).
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendAddInfoResponse {
    pub mode: FriendAddVerificationMode,
    /// Present only when mode is `question`.
    pub question: Option<String>,
}
