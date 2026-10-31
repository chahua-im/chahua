use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateServiceTokenRequest {
    pub name: String,
    #[serde(default)]
    pub policy_ids: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTokenResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub id: i64,
    pub token: String,
    pub name: String,
    pub created_by_uid: i32,
    pub revoked_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub policy_ids: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateServiceTokenResponse {
    pub service_token: ServiceTokenResponse,
    pub credential: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListServiceTokensResponse {
    pub service_tokens: Vec<ServiceTokenResponse>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RotateServiceTokenResponse {
    pub service_token: ServiceTokenResponse,
    pub credential: String,
}
