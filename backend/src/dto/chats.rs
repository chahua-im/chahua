use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::dto::messages::MessagePreview;
use crate::dto::users::MemberSummary;
use crate::models::GroupKind;

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatsQuery {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub chat_id: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub after: Option<i64>,
    #[serde(default)]
    pub archived: Option<bool>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkAsReadBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub message_id: i64,
}

#[derive(Deserialize, utoipa::ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct ReadReceiptQuery {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub thread_id: Option<i64>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkAsUnreadBody {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub message_id: Option<i64>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadMentionsQuery {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub thread_id: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatListItem {
    pub membership_message_policy: crate::dto::groups::MembershipMessagePolicy,
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
    /// The DM peer's authorized read receipt for this chat scope.
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub peer_last_read_message_id: Option<i64>,
    pub last_message: Option<MessagePreview>,
    pub muted_until: Option<DateTime<Utc>>,
    pub mute_override: Option<bool>,
    pub is_muted: bool,
    pub archived: bool,
    pub kind: GroupKind,
    /// The other participant, for DM chats; `None` for regular groups.
    pub peer: Option<MemberSummary>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatsResponse {
    pub chat_settings: crate::dto::users::ChatSettings,
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
