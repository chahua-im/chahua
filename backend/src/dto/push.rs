use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VapidPublicKeyResponse {
    pub public_key: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatusResponse {
    pub has_active_subscription: bool,
    pub has_matching_subscription: Option<bool>,
    pub has_matching_endpoint: Option<bool>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApiPushProvider {
    #[default]
    WebPush,
    Apns,
}

impl From<ApiPushProvider> for crate::models::PushProvider {
    fn from(value: ApiPushProvider) -> Self {
        match value {
            ApiPushProvider::WebPush => Self::WebPush,
            ApiPushProvider::Apns => Self::Apns,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeBody {
    #[serde(default)]
    pub provider: ApiPushProvider,
    pub endpoint: Option<String>,
    pub keys: Option<SubscribeKeys>,
    pub device_token: Option<String>,
    pub environment: Option<crate::models::PushEnvironment>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct SubscribeKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeBody {
    #[serde(default)]
    pub provider: ApiPushProvider,
    pub endpoint: Option<String>,
    pub device_token: Option<String>,
    pub environment: Option<crate::models::PushEnvironment>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatusQuery {
    #[serde(default)]
    pub provider: ApiPushProvider,
    pub endpoint: Option<String>,
    pub device_token: Option<String>,
    pub environment: Option<crate::models::PushEnvironment>,
}
