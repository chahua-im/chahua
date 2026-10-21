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
    #[schema(required = false)]
    pub unread_mentions: i64,
    /// Unread-reaction message count (reactions on my messages newer than my
    /// reaction cursor). Never folded into `unread_count`.
    #[schema(required = false)]
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
    #[schema(required = false)]
    pub unread_mentions: i64,
    #[schema(required = false)]
    pub unread_reactions: i64,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCountResponse {
    /// Complete mention/reply presence for each active list category.
    #[schema(required = false)]
    pub mention_badges: MentionBadges,
    #[schema(required = false)]
    pub archived_mention_badges: MentionBadges,
    pub unread_count: i64,
    pub archived_unread_count: i64,
    pub unread_chat_count: i64,
    pub archived_unread_chat_count: i64,
    #[schema(required = false)]
    pub unread_mentions: i64,
}

#[derive(Default, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MentionBadges {
    pub groups: bool,
    pub friends: bool,
    pub threads: bool,
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
    /// Snapshot boundary to pass back when acknowledging these reactions.
    pub read_through: DateTime<Utc>,
    /// Message ids with unread reactions, newest-first, one entry per message
    /// regardless of how many new reactions it carries. Serialized as strings.
    pub message_ids: Vec<String>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeReactionsBody {
    /// Acknowledge only through this snapshot; omit when leaving the conversation.
    pub read_through: Option<DateTime<Utc>>,
    /// Thread scope to acknowledge; omit/null for the main chat scope.
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub thread_id: Option<i64>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadReactionsAckResponse {
    /// Fresh unread-reaction message count after the cursor advance.
    pub unread_reactions: i64,
}
