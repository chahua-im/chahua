use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::dto::messages::MessageResponse;

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    #[serde(
        with = "crate::serde_i64_string::opt",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>)]
    pub thread_root_id: Option<i64>,
    pub message: MessageResponse,
    pub pinned_by: i32,
    pub pinned_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListPinsResponse {
    pub pins: Vec<PinResponse>,
}
