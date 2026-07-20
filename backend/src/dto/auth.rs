use serde::Serialize;
use utoipa::ToSchema;

#[derive(Serialize, ToSchema)]
pub struct AuthTokenResponse {
    /// Newly issued v2 session JWT.
    pub token: String,
}
