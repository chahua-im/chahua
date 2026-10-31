use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::friends::{
    CreateFriendRequestBody, ListFriendRequestsQuery, UpdateFriendPresenceSettingsBody,
    UpdateFriendReadReceiptSettingsBody, UpdateFriendSettingsBody,
};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsListParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsGetRelationshipParams {
    pub uid: i32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsRemoveParams {
    pub uid: i32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsCreateRequestParams {
    #[serde(flatten)]
    pub body: CreateFriendRequestBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsListRequestsParams {
    #[serde(flatten)]
    pub query: ListFriendRequestsQuery,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsGetPendingRequestCountParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsAcceptRequestParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub request_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsRejectRequestParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub request_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsArchiveRequestParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub request_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsGetSettingsParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsUpdateSettingsParams {
    #[serde(flatten)]
    pub body: UpdateFriendSettingsBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsGetAddInfoParams {
    pub uid: i32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsGetPresenceSettingsParams {
    pub uid: i32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsUpdatePresenceSettingsParams {
    pub uid: i32,
    #[serde(flatten)]
    pub body: UpdateFriendPresenceSettingsBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsGetReadReceiptSettingsParams {
    pub uid: i32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendsUpdateReadReceiptSettingsParams {
    pub uid: i32,
    #[serde(flatten)]
    pub body: UpdateFriendReadReceiptSettingsBody,
}
