use serde::Deserialize;
use utoipa::ToSchema;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionsListParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub message_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionsAddParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub message_id: i64,
    pub emoji: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionsRemoveParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub message_id: i64,
    pub emoji: String,
}
