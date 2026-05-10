use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::dto::invites::InviteResponse;
use crate::models::{GroupRole, GroupVisibility};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCreateInviteRequest {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub target_uid: i32,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExternalInviteStatus {
    Created,
    Existing,
    AlreadyMember,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalInviteChatResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub avatar_image_id: Option<i64>,
    pub visibility: GroupVisibility,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalInviteMembershipResponse {
    pub role: GroupRole,
    pub joined_at: DateTime<Utc>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCreateInviteResponse {
    pub status: ExternalInviteStatus,
    pub invite: Option<InviteResponse>,
    pub chat: ExternalInviteChatResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub membership: Option<ExternalInviteMembershipResponse>,
}

#[cfg(test)]
mod tests {
    use super::ExternalInviteStatus;

    #[test]
    fn status_serializes_as_camel_case() {
        let json = serde_json::to_string(&ExternalInviteStatus::AlreadyMember).unwrap();
        assert_eq!(json, "\"alreadyMember\"");
    }
}
