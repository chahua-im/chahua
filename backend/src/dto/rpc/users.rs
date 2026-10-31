use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::{
    notification_preferences::{ClearExceptionsQuery, ExceptionsQuery},
    users::{
        SearchUsersQuery, UpdateChatSettings, UpdateNotificationSettingsRequest,
        UpdateStickerPackOrderRequest,
    },
};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersGetMeParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersUpdateStickerPackOrderParams {
    #[serde(flatten)]
    pub body: UpdateStickerPackOrderRequest,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersUpdateChatSettingsParams {
    #[serde(flatten)]
    pub body: UpdateChatSettings,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersSearchParams {
    #[serde(flatten)]
    pub query: SearchUsersQuery,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersGetNotificationSettingsParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersUpdateNotificationSettingsParams {
    #[serde(flatten)]
    pub body: UpdateNotificationSettingsRequest,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersListNotificationExceptionsParams {
    #[serde(flatten)]
    pub query: ExceptionsQuery,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersClearNotificationExceptionsParams {
    #[serde(flatten)]
    pub query: ClearExceptionsQuery,
}
