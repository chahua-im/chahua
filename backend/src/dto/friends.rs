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

/// The current user's relationship with one profile user.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendRelationshipResponse {
    pub peer_uid: i32,
    pub is_friend: bool,
    /// The canonical DM group ID, when one exists for this relationship.
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub dm_chat_id: Option<i64>,
    /// The current user has blocked `peerUid`.
    pub blocking: bool,
    /// `peerUid` has blocked the current user.
    pub blocked_by: bool,
    /// The server-authoritative decision for whether the current user can send this peer a DM.
    pub can_dm: bool,
    /// The current user has an unresolved request to `peerUid`.
    pub has_pending_outgoing_request: bool,
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

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum FriendRequestDirection {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestHistoryEntry {
    #[serde(flatten)]
    #[schema(inline)]
    pub request: FriendRequestResponse,
    /// Direction relative to the calling user.
    pub direction: FriendRequestDirection,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListFriendRequestHistoryResponse {
    pub requests: Vec<FriendRequestHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingFriendRequestCountResponse {
    pub pending_incoming_count: i64,
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
