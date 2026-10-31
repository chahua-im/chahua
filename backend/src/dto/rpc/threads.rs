use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::threads::{
    ListChatThreadsQuery, ListThreadParticipantsQuery, ListThreadsQuery, MarkThreadReadBody,
};

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsListParams {
    #[serde(flatten)]
    pub query: ListThreadsQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsGetUnreadCountParams {}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsListForChatParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(flatten)]
    pub query: ListChatThreadsQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsListParticipantsParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub thread_root_id: i64,
    #[serde(flatten)]
    pub query: ListThreadParticipantsQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsMarkAsReadParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub thread_root_id: i64,
    #[serde(flatten)]
    pub body: MarkThreadReadBody,
}

macro_rules! chat_thread_params {
    ($name:ident) => {
        #[derive(Deserialize, ToSchema)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
            #[schema(schema_with = crate::serde_i64_string::schema)]
            pub chat_id: i64,
            #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
            #[schema(schema_with = crate::serde_i64_string::schema)]
            pub thread_root_id: i64,
        }
    };
}

chat_thread_params!(ThreadsGetReadStateParams);
chat_thread_params!(ThreadsGetSubscriptionStatusParams);
chat_thread_params!(ThreadsSubscribeParams);
chat_thread_params!(ThreadsUnsubscribeParams);
chat_thread_params!(ThreadsArchiveParams);
chat_thread_params!(ThreadsUnarchiveParams);
