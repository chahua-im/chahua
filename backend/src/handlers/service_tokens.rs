use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::service_tokens::{
    CreateServiceTokenRequest, CreateServiceTokenResponse, ListServiceTokensResponse,
    RotateServiceTokenResponse,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::utils::auth::CurrentUid;
use crate::AppState;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
struct ServiceTokenPath {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[param(value_type = String)]
    id: i64,
}

#[utoipa::path(
    post,
    path = "/",
    tag = "service-tokens",
    request_body = CreateServiceTokenRequest,
    responses(
        (status = 201, description = "Service token created", body = CreateServiceTokenResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn post_service_token(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateServiceTokenRequest>,
) -> Result<(StatusCode, Json<CreateServiceTokenResponse>), AppError> {
    let response = crate::services::api::service_tokens::post_service_token(
        uid,
        body,
        &mut conn,
        &state.authz_service,
        &state.id_gen,
        &state.config.auth.service_token_hash_key,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(response)))
}

#[utoipa::path(
    get,
    path = "/",
    tag = "service-tokens",
    responses(
        (status = 200, description = "Service tokens", body = ListServiceTokensResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_service_tokens(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<ListServiceTokensResponse>, AppError> {
    crate::services::api::service_tokens::get_service_tokens(uid, &mut conn, &state.authz_service)
        .map(Json)
}

#[utoipa::path(
    delete,
    path = "/{id}",
    tag = "service-tokens",
    params(ServiceTokenPath),
    responses(
        (status = 204, description = "Service token revoked")
    ),
    security(("bearer_jwt" = []))
)]
async fn delete_service_token(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ServiceTokenPath { id }): Path<ServiceTokenPath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    crate::services::api::service_tokens::delete_service_token(
        uid,
        id,
        &mut conn,
        &state.authz_service,
    )?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/{id}/rotate",
    tag = "service-tokens",
    params(ServiceTokenPath),
    responses(
        (status = 200, description = "Service token rotated", body = RotateServiceTokenResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn post_rotate_service_token(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ServiceTokenPath { id }): Path<ServiceTokenPath>,
    mut conn: DbConn,
) -> Result<Json<RotateServiceTokenResponse>, AppError> {
    crate::services::api::service_tokens::post_rotate_service_token(
        uid,
        id,
        &mut conn,
        &state.authz_service,
        &state.config.auth.service_token_hash_key,
    )
    .map(Json)
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(routes!(post_service_token, get_service_tokens))
        .routes(routes!(delete_service_token, post_rotate_service_token))
}
