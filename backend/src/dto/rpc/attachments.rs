use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::attachments::{ListChatAttachmentsQuery, UploadUrlRequest};

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentsListForChatParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub query: ListChatAttachmentsQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentsCreateUploadUrlParams {
    #[serde(flatten)]
    pub body: UploadUrlRequest,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentsGetConfigParams {}
