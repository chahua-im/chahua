use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::pins::CreatePinBody;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinsListParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinsCreateParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub body: CreatePinBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinsDeleteParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub pin_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinsListForThreadParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub thread_root_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinsCreateForThreadParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub thread_root_id: i64,
    #[serde(flatten)]
    pub body: CreatePinBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinsDeleteForThreadParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub thread_root_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub pin_id: i64,
}
