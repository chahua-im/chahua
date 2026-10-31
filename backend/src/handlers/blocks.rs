use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::blocks::{BlockRequestBody, ListBlocksResponse};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::blocks;
use crate::services::authentication::Principal;
use crate::AppState;

#[derive(Deserialize)]
struct BlockPath {
    uid: i32,
}

#[utoipa::path(
    get,
    path = "/",
    tag = "blocks",
    responses((status = 200, description = "Users blocked by the current user", body = ListBlocksResponse)),
    security(("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn get_blocks(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<ListBlocksResponse>, AppError> {
    let blocks = blocks::get_blocks(
        principal,
        &mut conn,
        &state.authz_service,
        state.avatars.as_ref(),
    )?;
    Ok(Json(blocks))
}

#[utoipa::path(
    post,
    path = "/",
    tag = "blocks",
    request_body = BlockRequestBody,
    responses((status = 204, description = "User blocked")),
    security(("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn block_user(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<BlockRequestBody>,
) -> Result<StatusCode, AppError> {
    blocks::block_user(
        principal,
        body,
        &mut conn,
        &state.authz_service,
        state.presence_service.as_ref(),
        &state.ws_registry,
    )?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/{uid}",
    tag = "blocks",
    params(
        ("uid" = i32, Path, description = "UID to unblock"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses((status = 204, description = "User unblocked"), (status = 404, description = "Not blocked")),
    security(("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn unblock_user(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(BlockPath { uid: other }): Path<BlockPath>,
) -> Result<StatusCode, AppError> {
    blocks::unblock_user(
        principal,
        other,
        &mut conn,
        &state.authz_service,
        state.presence_service.as_ref(),
        &state.ws_registry,
    )?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_blocks))
        .routes(routes!(block_user))
        .routes(routes!(unblock_user))
}
