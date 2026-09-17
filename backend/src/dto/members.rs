use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::{dto::users::UserGroupTagInfo, models::GroupRole};

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberResponse {
    pub uid: i32,
    pub role: GroupRole,
    pub joined_at: DateTime<Utc>,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub gender: i16,
    pub user_group: Option<UserGroupTagInfo>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub online: bool,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListMembersResponse {
    pub members: Vec<MemberResponse>,
    pub next_cursor: Option<i32>,
    pub can_manage_members: bool,
}
