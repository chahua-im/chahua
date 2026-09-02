use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::blocks::{BlockResponse, ListBlocksResponse};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::handlers::users::build_member_summary_map;
use crate::services::authz::Action as AuthzAction;
use crate::services::social;
use crate::utils::auth::Principal;
use crate::AppState;

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BlockRequestBody {
    uid: i32,
}

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
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialRead)?;
    let blocks = social::list_blocks_with_since(conn, uid)?;
    let uids: Vec<i32> = blocks.iter().map(|(uid, _)| *uid).collect();
    let summaries = build_member_summary_map(conn, &state, &uids)?;
    let blocks = blocks
        .into_iter()
        .filter_map(|(uid, since)| {
            summaries.get(&uid).map(|user| BlockResponse {
                user: user.clone(),
                since,
            })
        })
        .collect();
    Ok(Json(ListBlocksResponse { blocks }))
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
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialWrite)?;
    social::block_user(conn, uid, body.uid)?;
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
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialWrite)?;
    let removed = social::unblock_user(conn, uid, other)?;
    if !removed {
        return Err(AppError::NotFound("Block not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_blocks))
        .routes(routes!(block_user))
        .routes(routes!(unblock_user))
}
