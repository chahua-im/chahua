use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

use crate::dto::users::User;

#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChatAttachmentKindFilter {
    Image,
    Video,
    Other,
    All,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentUploadPurpose {
    Media,
    Voice,
    File,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UploadUrlRequest {
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub purpose: Option<AttachmentUploadPurpose>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub order: Option<i16>,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatAttachmentsQuery {
    pub kind: ChatAttachmentKindFilter,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub before: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub after: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub url: String,
    pub kind: String,
    pub size: i64,
    pub file_name: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSnapshot {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub external_reference: String,
    pub kind: String,
    pub size: i64,
    pub file_name: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachmentResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub message_id: i64,
    pub message_created_at: DateTime<Utc>,
    pub sender: User,
    pub url: String,
    pub kind: String,
    pub size: i64,
    pub file_name: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub order: i16,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatAttachmentsResponse {
    pub attachments: Vec<ChatAttachmentResponse>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub older_cursor: Option<i64>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub newer_cursor: Option<i64>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentConfigResponse {
    pub max_file_size_bytes: i64,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UploadUrlResponse {
    pub attachment_id: String,
    pub upload_url: String,
    pub upload_headers: BTreeMap<String, String>,
}
