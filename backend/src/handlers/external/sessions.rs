use axum::extract::{Path, State};
use axum::Json;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::external::sessions::SessionGenerationResponse;
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::authz::Action as AuthzAction;
use crate::utils::auth::Principal;
use crate::AppState;

#[utoipa::path(
    get,
    path = "/{uid}",
    tag = "external-sessions",
    params(("uid" = i32, Path, description = "User ID")),
    responses((status = 200, description = "Current session generation", body = SessionGenerationResponse)),
    security(("service_token_bearer" = []))
)]
async fn get_session_generation(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(uid): Path<i32>,
) -> Result<Json<SessionGenerationResponse>, AppError> {
    let conn = &mut *conn;
    principal.require_service_action(conn, &state, AuthzAction::SessionRead)?;
    validate_uid(uid)?;
    let token_gen = state.token_generation.stored(conn, uid)?;

    Ok(Json(SessionGenerationResponse { uid, token_gen }))
}

#[utoipa::path(
    post,
    path = "/{uid}/revoke",
    tag = "external-sessions",
    params(("uid" = i32, Path, description = "User ID")),
    responses((status = 200, description = "New session generation", body = SessionGenerationResponse)),
    security(("service_token_bearer" = []))
)]
async fn post_revoke_sessions(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(uid): Path<i32>,
) -> Result<Json<SessionGenerationResponse>, AppError> {
    let conn = &mut *conn;
    principal.require_service_action(conn, &state, AuthzAction::SessionRevoke)?;
    validate_uid(uid)?;
    let token_gen = state.token_generation.bump(conn, uid)?;

    Ok(Json(SessionGenerationResponse { uid, token_gen }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_session_generation))
        .routes(routes!(post_revoke_sessions))
}

fn validate_uid(uid: i32) -> Result<(), AppError> {
    if uid <= 0 {
        return Err(AppError::BadRequest("uid must be positive"));
    }
    Ok(())
}
