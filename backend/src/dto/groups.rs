use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::BTreeMap;

use crate::dto::users::MemberSummary;
use crate::models::{GroupKind, GroupRole, GroupVisibility, SpeakingMode};

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
    pub membership_message_policy: MembershipMessagePolicy,
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
    pub archived: bool,
    pub muted_until: Option<DateTime<Utc>>,
    pub mute_override: Option<bool>,
    pub is_muted: bool,
    pub my_role: Option<GroupRole>,
    pub speaking_mode: SpeakingMode,
    pub my_speaking_mode: Option<SpeakingMode>,
    pub effective_speaking_mode: Option<SpeakingMode>,
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

#[derive(Debug, Clone, Copy, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum NotificationSettingMode {
    Inherit,
    AlwaysMuted,
    AlwaysUnmuted,
    TemporarilyMuted,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotificationSettingRequest {
    pub mode: NotificationSettingMode,
    pub duration_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatNotificationSettingResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub kind: GroupKind,
    pub archived: bool,
    pub muted_until: Option<DateTime<Utc>>,
    pub mute_override: Option<bool>,
    pub is_muted: bool,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationException {
    #[serde(flatten)]
    pub setting: ChatNotificationSettingResponse,
    pub name: String,
    pub avatar: Option<String>,
    pub peer: Option<MemberSummary>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationExceptionsResponse {
    pub exceptions: Vec<NotificationException>,
    pub total_count: i64,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub next_cursor: Option<i64>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationExceptionsCleared {
    pub kind: GroupKind,
    pub chat_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MembershipMessagePolicy {
    pub visibility: crate::models::MembershipMessageVisibility,
    pub can_view: bool,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MembershipMessagePolicyChanged {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
}
