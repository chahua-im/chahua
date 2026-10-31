use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    dto::users::UserGroupTagInfo,
    models::{GroupRole, SpeakingMode},
    services::user::UserSearchMode,
};

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddMemberBody {
    pub uid: i32,
    #[serde(default)]
    pub role: Option<GroupRole>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemberBody {
    pub role: GroupRole,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListMembersQuery {
    pub limit: Option<i64>,
    pub after: Option<i32>,
    pub q: Option<String>,
    pub mode: Option<UserSearchMode>,
}

/// Query parameters for the remove-member endpoint.
#[derive(Deserialize, utoipa::IntoParams, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoveMemberQuery {
    /// Optional: "last24h" to delete messages from last 24 hours, "all" to delete all messages.
    pub delete_messages: Option<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberResponse {
    pub uid: i32,
    pub role: GroupRole,
    pub speaking_mode: SpeakingMode,
    pub joined_at: DateTime<Utc>,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub gender: i16,
    pub user_group: Option<UserGroupTagInfo>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListMembersResponse {
    pub members: Vec<MemberResponse>,
    pub next_cursor: Option<i32>,
    pub can_manage_members: bool,
}
