use axum::{
    extract::{Json, State},
    http::HeaderMap,
};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::dto::auth::{AuthTokenResponse, DevSessionRequest};
use crate::errors::AppError;
use crate::utils::auth::{is_valid_client_id, BearerSession, X_CLIENT_ID};
use crate::AppState;
use uuid::Uuid;

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
        (status = 400, description = "Invalid UID or missing client ID"),
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

    let client_id = dev_session_client_id(&headers)?;
    let token = state
        .auth_token_service
        .issue_session(request.uid, &client_id)?;

    Ok(Json(AuthTokenResponse { token }))
}

fn dev_session_client_id(headers: &HeaderMap) -> Result<String, AppError> {
    let value = headers
        .get(X_CLIENT_ID)
        .ok_or(AppError::BadRequest("Missing X-Client-Id header"))?
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| is_valid_client_id(value));

    Ok(value
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string()))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(post_refresh))
        .routes(routes!(post_dev_session))
}

#[cfg(test)]
mod tests {
    use super::{dev_session_client_id, router};
    use crate::utils::auth::{is_valid_client_id, X_CLIENT_ID};
    use axum::http::{HeaderMap, HeaderValue};
    #[test]
    fn development_session_is_in_openapi() {
        assert!(router()
            .get_openapi()
            .paths
            .paths
            .contains_key("/dev-session"));
    }

    #[test]
    fn development_session_generates_client_id_when_header_is_invalid() {
        let mut headers = HeaderMap::new();
        headers.insert(X_CLIENT_ID, HeaderValue::from_static("invalid client id"));

        let client_id = dev_session_client_id(&headers).expect("invalid IDs are replaced");

        assert!(is_valid_client_id(&client_id));
    }
}
