use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::dto::{messages::MessagePreview, users::User};
use crate::models::GroupKind;

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListItem {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub chat_kind: GroupKind,
    pub chat_name: String,
    pub chat_avatar: Option<String>,
    pub thread_root_message: MessagePreview,
    pub participants: Vec<User>,
    pub last_reply: Option<MessagePreview>,
    pub reply_count: i64,
    pub last_reply_at: DateTime<Utc>,
    pub unread_count: i64,
    #[schema(required = false)]
    pub unread_mentions: i64,
    #[schema(required = false)]
    pub unread_reactions: i64,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub last_read_message_id: Option<i64>,
    /// The DM peer's authorized read receipt for this thread scope.
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub peer_last_read_message_id: Option<i64>,
    pub subscribed_at: DateTime<Utc>,
    pub archived: bool,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsResponse {
    pub threads: Vec<ThreadListItem>,
    pub next_cursor: Option<String>,
}

#[derive(Default, Clone, Copy, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadOrder {
    Oldest,
    #[default]
    Newest,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatThreadsResponse {
    pub threads: Vec<crate::dto::messages::MessageResponse>,
    /// Last returned root ID; pass as `cursor` with the same ordering.
    pub next_cursor: Option<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadParticipantsResponse {
    pub participants: Vec<User>,
    /// Last returned UID; pass as `cursor` to continue in ascending UID order.
    pub next_cursor: Option<i32>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkThreadReadResponse {
    #[serde(serialize_with = "crate::serde_i64_string::opt::serialize")]
    #[schema(value_type = Option<String>)]
    pub last_read_message_id: Option<i64>,
    pub unread_count: i64,
    #[schema(required = false)]
    pub unread_mentions: i64,
    #[schema(required = false)]
    pub unread_reactions: i64,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadThreadCountResponse {
    pub unread_thread_count: i64,
    pub archived_unread_thread_count: i64,
    pub unread_message_count: i64,
    pub archived_unread_message_count: i64,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubscriptionStatusResponse {
    pub subscribed: bool,
    pub archived: bool,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadStateResponse {
    #[serde(serialize_with = "crate::serde_i64_string::opt::serialize")]
    #[schema(value_type = Option<String>)]
    pub last_read_message_id: Option<i64>,
    pub unread_count: i64,
    pub unread_mentions: i64,
    pub unread_reactions: i64,
}
