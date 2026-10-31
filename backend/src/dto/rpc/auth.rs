use serde::Deserialize;
use utoipa::ToSchema;

#[derive(Deserialize, ToSchema)]
pub struct AuthRefreshParams {}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthCreateDevSessionParams {
    pub uid: i32,
    pub client_id: Option<String>,
}
