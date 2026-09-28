use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    dto::{messages::MentionInfo, users::UserGroupTagInfo},
    models::MessageType,
};

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedAttachmentSnapshot {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub external_reference: String,
    pub url: String,
    pub kind: String,
    pub size: i64,
    pub file_name: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub order: i16,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedStickerSnapshot {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub emoji: String,
    pub name: Option<String>,
    pub media_url: String,
    pub media_content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedSenderSnapshot {
    pub uid: i32,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub gender: i16,
    #[serde(default)]
    pub user_group: Option<UserGroupTagInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatSnapshot {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedMessageResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_chat_id: i64,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub original_thread_root_id: Option<i64>,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub original_message_id: i64,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub original_reply_to_message_id: Option<i64>,
    pub original_sender_uid: i32,
    pub original_created_at: DateTime<Utc>,
    pub saved_at: DateTime<Utc>,
    pub message: Option<String>,
    pub message_type: MessageType,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub forwarded_bundle_id: Option<i64>,
    pub attachments: Vec<SavedAttachmentSnapshot>,
    pub sticker: Option<SavedStickerSnapshot>,
    pub mentions: Vec<MentionInfo>,
    pub sender: SavedSenderSnapshot,
    pub chat: SavedChatSnapshot,
    pub can_locate_context: bool,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListSavedMessagesResponse {
    pub saved_messages: Vec<SavedMessageResponse>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub next_cursor: Option<i64>,
}
