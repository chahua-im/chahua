use crate::services::message_search::MessageSearchSort;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    dto::{
        attachments::{AttachmentResponse, AttachmentSnapshot},
        link_previews::{MessageMetadataInput, MessageMetadataResponse, StoredMessageMetadata},
        users::User,
    },
    models::MessageType,
};

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageBody {
    pub message: Option<String>,
    pub message_type: MessageType,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub sticker_id: Option<i64>,
    pub client_generated_id: String,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub reply_to_id: Option<i64>,
    /// Uploaded attachment IDs in display order; allocation-time order is replaced.
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default)]
    pub metadata: Option<MessageMetadataInput>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMessageBody {
    pub message: String,
    /// Complete attachment selection in display order, including retained uploads.
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default)]
    pub metadata: Option<MessageMetadataInput>,
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MessageMetadataResponse>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<StoredMessageMetadata>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MessageMetadataResponse>,
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
    pub messages: Vec<SearchMessageResult>,
    pub next_cursor: Option<String>,
    /// Relevance search reached its result window; more matches may exist.
    pub truncated: bool,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum SearchResultKind {
    Message,
    Thread,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchMessageResult {
    pub kind: SearchResultKind,
    #[serde(flatten)]
    pub message: MessageResponse,
}

impl From<MessageResponse> for SearchMessageResult {
    fn from(message: MessageResponse) -> Self {
        Self {
            kind: SearchResultKind::Message,
            message,
        }
    }
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
    use super::{ForwardMessagesBody, ListMessagesResponse};
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

    #[test]
    fn forward_request_requires_the_client_generated_id() {
        let body = serde_json::from_value::<ForwardMessagesBody>(serde_json::json!({
            "sourceChatId": "42",
            "messageIds": ["10"],
            "clientGeneratedId": "forward-retry-42"
        }))
        .expect("forward request should retain the caller-generated id");

        assert_eq!(body.client_generated_id, "forward-retry-42");
        assert!(
            serde_json::from_value::<ForwardMessagesBody>(serde_json::json!({
                "sourceChatId": "42",
                "messageIds": ["10"]
            }))
            .is_err()
        );
    }

    #[test]
    fn merged_forward_request_accepts_an_optional_string_thread_id() {
        let mut json = serde_json::json!({
            "sourceChatId": "42",
            "messageIds": ["10", "20"],
            "clientGeneratedId": "forward-thread-42"
        });
        let body: ForwardMessagesBody = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(body.thread_id, None);
        json["threadId"] = serde_json::Value::Null;
        let body: ForwardMessagesBody = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(body.thread_id, None);
        json["threadId"] = i64::MAX.to_string().into();
        let body: ForwardMessagesBody = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(body.thread_id, Some(i64::MAX));
        json["threadId"] = "invalid".into();
        assert!(serde_json::from_value::<ForwardMessagesBody>(json).is_err());
    }
}
#[derive(Debug, serde::Deserialize, utoipa::IntoParams, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct ListMessagesQuery {
    /// Cursor: fetch messages before this ID
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub before: Option<i64>,
    /// Cursor: fetch messages around this ID
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub around: Option<i64>,
    /// Cursor: fetch messages after this ID
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub after: Option<i64>,
    /// Max number of messages to return
    #[serde(default)]
    pub max: Option<i64>,
    /// Thread root ID to filter by
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub thread_id: Option<i64>,
}

#[derive(Debug, serde::Deserialize, utoipa::IntoParams, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchMessagesQuery {
    /// Message author UID; cross-chat search still requires a query and current chat access.
    pub sender_uid: Option<i32>,
    /// Required for cross-chat search; optional for chat main/thread history filtering.
    pub q: Option<String>,
    /// Inclusive creation time, RFC 3339 with timezone; millisecond precision.
    pub created_from: Option<DateTime<Utc>>,
    /// Exclusive creation time, RFC 3339 with timezone; millisecond precision.
    pub created_before: Option<DateTime<Utc>>,
    #[serde(default)]
    pub sort: Option<MessageSearchSort>,
    pub limit: Option<i64>,
    /// Opaque continuation token; keep all search conditions unchanged.
    pub cursor: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatSearchScope {
    #[default]
    All,
    Main,
    Thread,
    /// Thread roots in which participantUid authored a root or surviving reply.
    Threads,
}

#[derive(Debug, serde::Deserialize, utoipa::IntoParams, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchMessagesQuery {
    /// Group chats only: historical participant in the selected scope. Reserved for scope=threads.
    pub sender_uid: Option<i32>,
    /// Required only for scope=threads; root/reply author, independent of membership or subscription.
    pub participant_uid: Option<i32>,
    /// Without text, a date boundary or senderUid is required; all requires senderUid. Threads requires participantUid and does not support text.
    pub q: Option<String>,
    /// Inclusive creation time, RFC 3339 with timezone; millisecond precision.
    pub created_from: Option<DateTime<Utc>>,
    /// Exclusive creation time, RFC 3339 with timezone; millisecond precision.
    pub created_before: Option<DateTime<Utc>>,
    pub sort: Option<MessageSearchSort>,
    pub limit: Option<i64>,
    /// Opaque continuation token; keep all search conditions unchanged.
    pub cursor: Option<String>,
    /// Defaults to all; without keywords, all returns sender messages and participating threads and requires senderUid.
    #[serde(default)]
    pub scope: ChatSearchScope,
    /// Required only for scope=thread; includes the root and its replies.
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub thread_id: Option<i64>,
}

impl ChatSearchMessagesQuery {
    pub fn search_range(
        &self,
    ) -> Result<crate::services::message_search::MessageSearchRange, crate::errors::AppError> {
        use crate::services::message_search::MessageSearchRange;
        if let ChatSearchScope::Threads = self.scope {
            if self.thread_id.is_some()
                || self.sender_uid.is_some()
                || self.q.as_deref().is_some_and(|q| !q.trim().is_empty())
            {
                return Err(crate::errors::AppError::BadRequest(
                    "scope=threads does not support threadId, senderUid or q",
                ));
            }
            return self
                .participant_uid
                .filter(|uid| *uid > 0)
                .map(MessageSearchRange::Threads)
                .ok_or(crate::errors::AppError::BadRequest(
                    "scope=threads requires a positive participantUid",
                ));
        }
        if self.participant_uid.is_some() {
            return Err(crate::errors::AppError::BadRequest(
                "participantUid is only supported for scope=threads",
            ));
        }
        match (self.scope, self.thread_id) {
            (ChatSearchScope::All, None) => Ok(MessageSearchRange::All),
            (ChatSearchScope::Main, None) => Ok(MessageSearchRange::Main),
            (ChatSearchScope::Thread, Some(id)) if id > 0 => Ok(MessageSearchRange::Thread(id)),
            _ => Err(crate::errors::AppError::BadRequest(
                "threadId must be a positive ID and is required only for scope=thread",
            )),
        }
    }

    pub fn into_query(self) -> SearchMessagesQuery {
        SearchMessagesQuery {
            sender_uid: self.sender_uid,
            q: self.q,
            created_from: self.created_from,
            created_before: self.created_before,
            sort: self.sort,
            limit: self.limit,
            cursor: self.cursor,
        }
    }
}

#[cfg(test)]
mod search_scope_tests {
    use super::*;
    use crate::services::message_search::MessageSearchRange;

    #[test]
    fn sender_filter_uses_uid_in_http_and_rpc_queries() {
        let cross_chat = axum::extract::Query::<SearchMessagesQuery>::try_from_uri(
            &"/?q=hello&senderUid=42".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(cross_chat.sender_uid, Some(42));
        let cross_chat: SearchMessagesQuery =
            serde_json::from_value(serde_json::json!({"q":"hello","senderUid":42})).unwrap();
        assert_eq!(cross_chat.sender_uid, Some(42));
        let query = axum::extract::Query::<ChatSearchMessagesQuery>::try_from_uri(
            &"/?q=hello&scope=thread&threadId=123&senderUid=42"
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(query.sender_uid, Some(42));
        let query: crate::dto::rpc::messages::MessagesSearchParams =
            serde_json::from_value(serde_json::json!({"chatId":"10","q":"hello","senderUid":42}))
                .unwrap();
        assert_eq!(query.query.sender_uid, Some(42));
    }
    #[test]
    fn threads_scope_requires_participant_and_reserves_sender() {
        for uri in [
            "/?scope=threads&participantUid=42",
            "/?scope=threads&participantUid=42&sort=newest",
        ] {
            let query = axum::extract::Query::<ChatSearchMessagesQuery>::try_from_uri(
                &uri.parse().unwrap(),
            )
            .unwrap();
            assert_eq!(
                query.search_range().unwrap(),
                MessageSearchRange::Threads(42)
            );
        }
        let rpc: crate::dto::rpc::messages::MessagesSearchParams = serde_json::from_value(
            serde_json::json!({"chatId":"9007199254740993","scope":"threads","participantUid":42}),
        )
        .unwrap();
        assert_eq!(
            rpc.query.search_range().unwrap(),
            MessageSearchRange::Threads(42)
        );
        for uri in [
            "/?scope=threads",
            "/?scope=threads&participantUid=0",
            "/?scope=threads&participantUid=-1",
            "/?scope=threads&participantUid=42&senderUid=43",
            "/?scope=threads&participantUid=42&threadId=1",
            "/?scope=threads&participantUid=42&q=test",
            "/?scope=all&participantUid=42",
            "/?scope=main&participantUid=42",
            "/?scope=thread&threadId=1&participantUid=42",
        ] {
            let query = axum::extract::Query::<ChatSearchMessagesQuery>::try_from_uri(
                &uri.parse().unwrap(),
            )
            .unwrap();
            assert!(query.search_range().is_err(), "{uri}");
        }
    }

    #[test]
    fn scope_validation_and_id_precision() {
        for (uri, expected) in [
            ("/?q=hello", MessageSearchRange::All),
            ("/?q=hello&scope=main", MessageSearchRange::Main),
            (
                "/?q=hello&scope=thread&threadId=9223372036854775807",
                MessageSearchRange::Thread(i64::MAX),
            ),
        ] {
            let query = axum::extract::Query::<ChatSearchMessagesQuery>::try_from_uri(
                &uri.parse().unwrap(),
            )
            .unwrap();
            assert_eq!(query.search_range().unwrap(), expected);
        }
        for uri in [
            "/?q=hello&scope=thread",
            "/?q=hello&threadId=1",
            "/?q=hello&scope=main&threadId=1",
            "/?q=hello&scope=thread&threadId=0",
        ] {
            let query = axum::extract::Query::<ChatSearchMessagesQuery>::try_from_uri(
                &uri.parse().unwrap(),
            )
            .unwrap();
            assert!(query.search_range().is_err());
        }
        assert!(serde_json::from_value::<ChatSearchMessagesQuery>(
            serde_json::json!({"q":"hello","scope":"invalid"})
        )
        .is_err());
    }
}
