use axum::{
    extract::{Json, State},
    http::HeaderMap,
};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::dto::auth::{AuthTokenResponse, DevSessionRequest};
use crate::errors::AppError;
use crate::utils::auth::{BearerSession, X_CLIENT_ID};
use crate::AppState;

#[utoipa::path(
    post,
    path = "/refresh",
    tag = "auth",
    responses(
        (status = 200, description = "Refreshed v2 session token", body = AuthTokenResponse),
        (status = 401, description = "Missing or invalid bearer token")
    ),
    security(("bearer_jwt" = []))
)]
async fn post_refresh(
    BearerSession(session): BearerSession,
    State(state): State<AppState>,
) -> Result<Json<AuthTokenResponse>, AppError> {
    crate::services::api::auth::post_refresh(&session, &state.auth_token_service).map(Json)
}

#[utoipa::path(
    post,
    path = "/dev-session",
    tag = "auth",
    request_body = DevSessionRequest,
    responses(
        (status = 200, description = "Development v2 session token", body = AuthTokenResponse),
        (status = 400, description = "Invalid UID or missing client ID"),
        (status = 404, description = "Not found")
    )
)]
async fn post_dev_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DevSessionRequest>,
) -> Result<Json<AuthTokenResponse>, AppError> {
    let client_id = headers
        .get(X_CLIENT_ID)
        .map(|value| value.to_str().unwrap_or("").to_owned());
    let issued = crate::services::api::auth::post_dev_session(
        request,
        client_id,
        crate::services::api::auth::PostDevSessionDeps {
            config: &state.config,
            auth_token_service: &state.auth_token_service,
            token_generation: &state.token_generation,
            db: &state.db,
        },
    )?;
    Ok(Json(issued.response))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(post_refresh))
        .routes(routes!(post_dev_session))
}

#[cfg(test)]
mod tests {
    use super::router;
    #[test]
    fn development_session_is_in_openapi() {
        assert!(router()
            .get_openapi()
            .paths
            .paths
            .contains_key("/dev-session"));
    }
}
