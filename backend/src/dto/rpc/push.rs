use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::push::{SubscribeBody, SubscriptionStatusQuery, UnsubscribeBody};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushGetVapidPublicKeyParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushGetSubscriptionStatusParams {
    #[serde(flatten)]
    pub query: SubscriptionStatusQuery,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscribeParams {
    #[serde(flatten)]
    pub body: SubscribeBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushUnsubscribeParams {
    #[serde(flatten)]
    pub body: UnsubscribeBody,
}
