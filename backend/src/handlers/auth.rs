use axum::{
    extract::{Json, State},
    http::HeaderMap,
};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::dto::auth::{AuthTokenResponse, DevSessionRequest};
use crate::errors::AppError;
use crate::utils::auth::{required_client_id, BearerSession};
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
    let token = state
        .auth_token_service
        .issue_session(session.uid, &session.client_id)?;

    Ok(Json(AuthTokenResponse { token }))
}

#[utoipa::path(
    post,
    path = "/dev-session",
    tag = "auth",
    request_body = DevSessionRequest,
    responses(
        (status = 200, description = "Development v2 session token", body = AuthTokenResponse),
        (status = 400, description = "Invalid UID or client ID"),
        (status = 404, description = "Not found")
    )
)]
async fn post_dev_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DevSessionRequest>,
) -> Result<Json<AuthTokenResponse>, AppError> {
    if !state.config.auth.debug_auth_enabled {
        return Err(AppError::NotFound("Not found"));
    }
    if request.uid <= 0 {
        return Err(AppError::BadRequest("UID must be a positive i32"));
    }

    let client_id = required_client_id(&headers)?;
    let token = state
        .auth_token_service
        .issue_session(request.uid, &client_id)?;

    Ok(Json(AuthTokenResponse { token }))
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
