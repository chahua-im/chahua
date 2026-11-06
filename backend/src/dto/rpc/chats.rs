use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::chats::{
    AcknowledgeReactionsBody, ListChatsQuery, MarkAsReadBody, MarkAsUnreadBody, ReadReceiptQuery,
    UnreadMentionsQuery, UnreadReactionsQuery,
};

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsListParams {
    #[serde(flatten)]
    pub query: ListChatsQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsGetTotalUnreadCountParams {}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsArchiveParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsUnarchiveParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsMarkAsReadParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub body: MarkAsReadBody,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsMarkAsUnreadParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub body: MarkAsUnreadBody,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsGetUnreadCountParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsGetReadReceiptParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub query: ReadReceiptQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsListMentionsParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub query: UnreadMentionsQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsListUnreadReactionsParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub query: UnreadReactionsQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatsAcknowledgeReactionsParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub body: AcknowledgeReactionsBody,
}
