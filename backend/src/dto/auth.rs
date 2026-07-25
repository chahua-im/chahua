use serde::Deserialize;
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Deserialize, ToSchema)]
pub struct DevSessionRequest {
    pub uid: i32,
}

#[derive(Serialize, ToSchema)]
pub struct AuthTokenResponse {
    /// Newly issued v2 session JWT.
    pub token: String,
}
