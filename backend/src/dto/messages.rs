use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    dto::{
        attachments::{AttachmentResponse, AttachmentSnapshot},
        users::User,
    },
    models::MessageType,
};

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BulkDeleteMessagesBody {
    #[serde(deserialize_with = "crate::serde_i64_string::vec::deserialize")]
    #[schema(value_type = Vec<String>, min_items = 1, max_items = 100)]
    pub message_ids: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MentionInfo {
    pub uid: i32,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub gender: i16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_group: Option<crate::dto::users::UserGroupTagInfo>,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub reply_count: i64,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedFromInfo {
    pub sender: User,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_chat_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_message_id: i64,
    /// Source reply context is display-only in the destination conversation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_reply_to: Option<Box<MessagePreview>>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardMessageBody {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub source_chat_id: i64,
    pub client_generated_id: String,
    #[serde(default, with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub thread_id: Option<i64>,
    /// User confirmed replacing pending audio or excessive nesting with immutable placeholders.
    #[serde(default)]
    pub allow_placeholders: bool,
}

/// Stable destinations for the target named in a system message.
#[derive(Debug, Default, Serialize, Deserialize, Clone, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SystemMessageLinks {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<i32>,
    #[serde(
        default,
        with = "crate::serde_i64_string::opt",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>)]
    pub message_id: Option<i64>,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_kind: Option<crate::models::SystemMessageKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_links: Option<SystemMessageLinks>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarded_from: Option<ForwardedFromInfo>,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub message: Option<String>,
    pub message_type: MessageType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<MessageStickerResponse>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub reply_root_id: Option<i64>,
    pub client_generated_id: String,
    pub sender: User,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub created_at: DateTime<Utc>,
    pub is_edited: bool,
    pub is_deleted: bool,
    pub has_attachments: bool,
    pub thread_info: Option<ThreadInfo>,
    pub reply_to_message: Option<Box<MessagePreview>>,
    pub attachments: Vec<AttachmentResponse>,
    pub reactions: Vec<ReactionSummary>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<MentionInfo>,
    #[serde(
        with = "crate::serde_i64_string::opt",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>)]
    pub forwarded_bundle_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarded_preview: Option<ForwardedMessagesPreviewResponse>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardMessagesBody {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub source_chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::vec::deserialize")]
    #[schema(value_type = Vec<String>, min_items = 2, max_items = 100)]
    pub message_ids: Vec<i64>,
    pub client_generated_id: String,
    /// Destination thread root; omit to send to the chat timeline.
    #[serde(default, with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub thread_id: Option<i64>,
    /// User confirmed replacing pending audio or excessive nesting with immutable placeholders.
    #[serde(default)]
    pub allow_placeholders: bool,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedMessagesPreviewResponse {
    pub total: usize,
    pub contains_forwarded_messages: bool,
    pub messages: Vec<ForwardedMessagePreviewResponse>,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedMessagePreviewResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_message_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_chat_id: i64,
    pub message: Option<String>,
    pub message_type: MessageType,
    pub sender: User,
    pub original_created_at: DateTime<Utc>,
    pub attachments: Vec<MessagePreviewAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<MessagePreviewSticker>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<MentionInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedMessagesPreviewSnapshot {
    pub total: usize,
    pub contains_forwarded_messages: bool,
    pub messages: Vec<ForwardedMessagePreviewSnapshot>,
}

/// Compact immutable data needed to render a forwarded-bundle preview.
///
/// The complete payload keeps durable attachment and sticker metadata. Previews
/// deliberately retain only display data so bundle summaries do not duplicate
/// storage keys, file details, favorite state, or reply relationships.
#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedMessagePreviewSnapshot {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_message_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_chat_id: i64,
    pub message: Option<String>,
    pub message_type: MessageType,
    pub sender_uid: i32,
    pub original_created_at: DateTime<Utc>,
    pub attachments: Vec<MessagePreviewAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sticker: Option<MessagePreviewSticker>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mention_uids: Vec<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForwardedBundlePayloadItem {
    MessageSnapshot {
        #[serde(flatten)]
        snapshot: ForwardedMessageSnapshot,
    },
    ForwardedBundleRef {
        #[serde(flatten)]
        bundle_ref: ForwardedBundleRefSnapshot,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedMessageSnapshot {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_message_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_chat_id: i64,
    pub message: Option<String>,
    pub message_type: MessageType,
    pub sender_uid: i32,
    pub original_created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sticker: Option<ForwardedStickerSnapshot>,
    pub reply: Option<ForwardedReplySnapshot>,
    pub attachments: Vec<AttachmentSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mention_uids: Vec<i32>,
}

/// Immutable sticker data kept in a forwarded bundle.
///
/// Public URLs and favorite state belong to the reader, so they are rebuilt
/// when the bundle is read rather than persisted here.
#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedStickerSnapshot {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub media_id: i64,
    pub media_storage_key: String,
    pub emoji: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub content_type: String,
    pub size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

/// A forwarded reply only references another member of its immediate bundle.
#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForwardedReplySnapshot {
    Redacted,
    Internal {
        #[serde(rename = "originalMessageId", with = "crate::serde_i64_string")]
        #[schema(value_type = String)]
        original_message_id: i64,
    },
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForwardedReplyResponse {
    Redacted,
    Internal {
        #[serde(rename = "originalMessageId", with = "crate::serde_i64_string")]
        #[schema(value_type = String)]
        original_message_id: i64,
        preview: Box<ForwardedMessagePreviewResponse>,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedBundleRefSnapshot {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_message_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_chat_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub forwarded_bundle_id: i64,
    pub message: Option<String>,
    pub message_type: MessageType,
    pub sender_uid: i32,
    pub original_created_at: DateTime<Utc>,
    pub reply: Option<ForwardedReplySnapshot>,
    pub preview: ForwardedMessagesPreviewSnapshot,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedMessagesResponse {
    pub total: usize,
    pub messages: Vec<ForwardedMessageResponse>,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedMessageResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_message_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_chat_id: i64,
    pub message: Option<String>,
    pub message_type: MessageType,
    pub sender: User,
    pub original_created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<MessageStickerResponse>,
    pub reply: Option<ForwardedReplyResponse>,
    pub attachments: Vec<AttachmentResponse>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<MentionInfo>,
    #[serde(
        with = "crate::serde_i64_string::opt",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>)]
    pub forwarded_bundle_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarded_preview: Option<ForwardedMessagesPreviewResponse>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListMessagesResponse {
    pub membership_message_policy: crate::dto::groups::MembershipMessagePolicy,
    pub chat_settings: crate::dto::users::ChatSettings,
    pub messages: Vec<MessageResponse>,
    /// Deprecated: use `older_cursor` / `olderCursor` instead.
    ///
    /// This is the cursor to fetch older messages with the `before` query
    /// parameter. It remains during the API transition for compatibility.
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub next_cursor: Option<i64>,
    /// Deprecated: use `newer_cursor` / `newerCursor` instead.
    ///
    /// This is the cursor to fetch newer messages with the `after` query
    /// parameter. It remains during the API transition for compatibility.
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub prev_cursor: Option<i64>,
    /// Cursor to fetch older messages with the `before` query parameter.
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub older_cursor: Option<i64>,
    /// Cursor to fetch newer messages with the `after` query parameter.
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub newer_cursor: Option<i64>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchMessagesResponse {
    pub messages: Vec<MessageResponse>,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionReactor {
    pub uid: i32,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_index: Option<i32>,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionSummary {
    pub emoji: String,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reacted_by_me: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactors: Option<Vec<ReactionReactor>>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionDetailGroup {
    pub emoji: String,
    pub reactors: Vec<ReactionReactor>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionDetailResponse {
    pub reactions: Vec<ReactionDetailGroup>,
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessagePreviewSticker {
    pub emoji: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessagePreviewAttachment {
    pub kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessagePreview {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_kind: Option<crate::models::SystemMessageKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_links: Option<SystemMessageLinks>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forwarded_from_name: Option<String>,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub client_generated_id: String,
    pub created_at: DateTime<Utc>,
    pub sender: User,
    pub message: Option<String>,
    pub message_type: MessageType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<MessagePreviewSticker>,
    pub attachments: Vec<MessagePreviewAttachment>,
    pub is_deleted: bool,
    pub mentions: Vec<MentionInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[schema(as = MessageStickerMediaResponse)]
#[serde(rename_all = "camelCase")]
pub struct StickerMediaResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub url: String,
    pub content_type: String,
    pub size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageStickerResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub emoji: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub is_favorited: bool,
    pub media: StickerMediaResponse,
}

#[cfg(test)]
mod tests {
    use super::ListMessagesResponse;
    use serde_json::json;

    #[test]
    fn list_messages_response_serializes_directional_cursor_aliases() {
        let response = ListMessagesResponse {
            membership_message_policy: crate::dto::groups::MembershipMessagePolicy {
                visibility: crate::models::MembershipMessageVisibility::Members,
                can_view: true,
            },
            chat_settings: crate::dto::users::ChatSettings {
                show_membership_messages: true,
            },
            messages: vec![],
            next_cursor: Some(10),
            prev_cursor: Some(20),
            older_cursor: Some(10),
            newer_cursor: Some(20),
        };

        let value = serde_json::to_value(response).expect("serialize response");

        assert_eq!(
            value,
            json!({
                "chatSettings": {"showMembershipMessages": true},
                "membershipMessagePolicy": {"visibility": "members", "canView": true},
                "messages": [],
                "nextCursor": "10",
                "prevCursor": "20",
                "olderCursor": "10",
                "newerCursor": "20"
            })
        );
    }
}
