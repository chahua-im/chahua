use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::dto::messages::MessagePreview;
use crate::dto::users::MemberSummary;
use crate::models::GroupKind;

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatListItem {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub unread_count: i64,
    pub unread_mentions: i64,
    /// Unread-reaction message count. Never folded into `unread_count`.
    pub unread_reactions: i64,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub last_read_message_id: Option<i64>,
    pub last_message: Option<MessagePreview>,
    pub muted_until: Option<DateTime<Utc>>,
    pub archived: bool,
    pub kind: GroupKind,
    /// The other participant, for DM chats; `None` for regular groups.
    pub peer: Option<MemberSummary>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatsResponse {
    pub chats: Vec<ChatListItem>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub next_cursor: Option<i64>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkChatReadStateResponse {
    #[serde(serialize_with = "crate::serde_i64_string::opt::serialize")]
    #[schema(value_type = Option<String>)]
    pub last_read_message_id: Option<i64>,
    pub unread_count: i64,
    pub unread_mentions: i64,
    pub unread_reactions: i64,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCountResponse {
    pub unread_count: i64,
    pub archived_unread_count: i64,
    pub unread_chat_count: i64,
    pub archived_unread_chat_count: i64,
    pub unread_mentions: i64,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadMentionIdsResponse {
    /// Unread mention message ids, newest-first. Serialized as strings (JS-safe).
    pub message_ids: Vec<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadReactionIdsResponse {
    /// Message ids with unread reactions, oldest-unread-first. Serialized as
    /// strings (JS-safe).
    pub message_ids: Vec<String>,
    /// Total unread-reaction message count (may exceed the id list length
    /// when truncated at the limit).
    pub unread_reactions: i64,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeReactionsBody {
    /// Message ids explicitly viewed by the caller — top-level or thread
    /// replies both count. Strings because message ids exceed JS safe
    /// integers.
    pub message_ids: Vec<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadReactionsAckResponse {
    /// Fresh main-scope unread-reaction count after recording the views.
    /// Thread badge state is not included — refresh it separately.
    pub unread_reactions: i64,
    /// Fresh main-scope unread-reaction message ids, oldest-unread-first.
    pub message_ids: Vec<String>,
}
