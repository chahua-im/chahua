use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::friends::{
    PrivacyExceptionsQuery, UpdatePresenceSettingsBody, UpdateReadReceiptSettingsBody,
};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyGetPresenceSettingsParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyUpdatePresenceSettingsParams {
    #[serde(flatten)]
    pub body: UpdatePresenceSettingsBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyGetReadReceiptSettingsParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyUpdateReadReceiptSettingsParams {
    #[serde(flatten)]
    pub body: UpdateReadReceiptSettingsBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyListExceptionsParams {
    #[serde(flatten)]
    pub query: PrivacyExceptionsQuery,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyClearExceptionsParams {
    #[serde(flatten)]
    pub query: PrivacyExceptionsQuery,
}
