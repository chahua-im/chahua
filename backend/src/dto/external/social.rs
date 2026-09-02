use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Body for POST /external/social/relationships.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipQueryRequest {
    pub uid: i32,
    pub peer_uids: Vec<i32>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipRequestDirection {
    Incoming,
    Outgoing,
}

/// The pending friend request between the pair, if any.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipPendingRequest {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    /// Relative to `uid`: `outgoing` means `uid` sent it.
    pub direction: RelationshipRequestDirection,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipStatus {
    pub peer_uid: i32,
    pub is_friend: bool,
    pub friends_since: Option<DateTime<Utc>>,
    /// The canonical DM group id, present whenever the DM group exists.
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub dm_chat_id: Option<i64>,
    /// `uid` has blocked `peerUid`.
    pub blocking: bool,
    /// `peerUid` has blocked `uid`.
    pub blocked_by: bool,
    /// Mirrors the server-side DM authorization rule.
    pub can_dm: bool,
    pub pending_request: Option<RelationshipPendingRequest>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipQueryResponse {
    pub uid: i32,
    pub relationships: Vec<RelationshipStatus>,
}
