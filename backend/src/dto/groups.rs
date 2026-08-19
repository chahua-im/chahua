use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::BTreeMap;

use crate::dto::users::MemberSummary;
use crate::models::{GroupKind, GroupRole, GroupVisibility};

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub name: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfoResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub avatar_image_id: Option<i64>,
    pub avatar: Option<String>,
    pub visibility: GroupVisibility,
    pub created_at: DateTime<Utc>,
    pub muted_until: Option<DateTime<Utc>>,
    pub my_role: Option<GroupRole>,
    pub kind: GroupKind,
    /// The other participant, for DM chats; `None` for regular groups.
    pub peer: Option<MemberSummary>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupSelectorItem {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub avatar: Option<String>,
    pub visibility: GroupVisibility,
    pub role: Option<GroupRole>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListGroupsResponse {
    pub groups: Vec<GroupSelectorItem>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub next_cursor: Option<i64>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AvatarUploadUrlResponse {
    pub image_id: String,
    pub upload_url: String,
    pub upload_headers: BTreeMap<String, String>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MuteResponse {
    pub muted_until: DateTime<Utc>,
}
