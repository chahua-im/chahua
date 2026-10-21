use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConversationCategory {
    Group,
    Dm,
    GroupThread,
    DmThread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRef {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    /// Absent for the main chat; selecting it does not implicitly select its threads.
    #[serde(default, with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub thread_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationSelector {
    #[serde(default)]
    pub categories: Vec<ConversationCategory>,
    /// Union with category matches. Membership, subscription and archive filters still apply.
    #[serde(default)]
    pub include: Vec<ConversationRef>,
    /// Exclusion takes precedence over both categories and explicit inclusion.
    #[serde(default)]
    pub exclude: Vec<ConversationRef>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationView {
    pub key: String,
    pub selector: ConversationSelector,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationUnreadSummary {
    pub key: String,
    /// Unread messages, including muted conversations; capped at 1000.
    pub unread_message_count: i64,
    /// Unread messages in unmuted conversations, including DMs and threads; capped at 1000.
    pub unread_unmuted_message_count: i64,
    /// Number of distinct conversations with unread messages.
    pub unread_conversation_count: i64,
    /// Number of distinct unmuted conversations with unread messages; not capped.
    pub unread_unmuted_conversation_count: i64,
    /// Unread group mentions/replies, including muted conversations, once per message; DMs contribute zero. Capped at 1000.
    pub unread_attention_count: i64,
    /// Unread group mentions/replies in unmuted conversations, for tab/title badges. Capped at 1000.
    pub unread_unmuted_attention_count: i64,
}

/// Connection-scoped absolute counters. Partial publications replace only their listed keys.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationUnreadPayload {
    pub request_id: u32,
    pub full: bool,
    pub summaries: Vec<ConversationUnreadSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_badge_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationUnreadErrorPayload {
    pub request_id: u32,
}
