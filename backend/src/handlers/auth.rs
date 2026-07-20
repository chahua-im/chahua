use axum::{
    extract::State,
    http::{header::CACHE_CONTROL, HeaderValue},
    Json,
};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::dto::auth::AuthTokenResponse;
use crate::errors::AppError;
use crate::utils::auth::BearerSession;
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
) -> Result<
    (
        [(axum::http::HeaderName, HeaderValue); 1],
        Json<AuthTokenResponse>,
    ),
    AppError,
> {
    let token = state
        .auth_token_service
        .issue_session(session.uid, &session.client_id)?;

    Ok((
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(AuthTokenResponse { token }),
    ))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(post_refresh))
}
