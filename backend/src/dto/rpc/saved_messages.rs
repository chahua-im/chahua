use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::saved_messages::ListSavedMessagesQuery;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedMessagesListForChatParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub query: ListSavedMessagesQuery,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedMessagesListParams {
    #[serde(flatten)]
    pub query: ListSavedMessagesQuery,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedMessagesSaveParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub message_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedMessagesDeleteByMessageParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub message_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedMessagesDeleteParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub saved_message_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedMessagesListForwardedMessagesParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub saved_message_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedMessagesListForwardedBundleMessagesParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub saved_message_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub bundle_id: i64,
}
