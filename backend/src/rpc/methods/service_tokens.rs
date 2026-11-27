use crate::dto::rpc::service_tokens::*;
use crate::dto::service_tokens::{
    CreateServiceTokenResponse, ListServiceTokensResponse, RotateServiceTokenResponse,
};
use crate::errors::AppError;
use crate::rpc::{AppState, RpcCallContext};
use crate::services::api::service_tokens;

pub async fn create(
    context: &RpcCallContext,
    services: &AppState,
    params: ServiceTokensCreateParams,
) -> Result<CreateServiceTokenResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    service_tokens::post_service_token(
        uid,
        params.body,
        &mut conn,
        services.authz_service.as_ref(),
        services.id_gen.as_ref(),
        &services.config.auth.service_token_hash_key,
    )
    .await
}

pub async fn list(
    context: &RpcCallContext,
    services: &AppState,
    _: ServiceTokensListParams,
) -> Result<ListServiceTokensResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    service_tokens::get_service_tokens(uid, &mut conn, services.authz_service.as_ref())
}

pub async fn delete(
    context: &RpcCallContext,
    services: &AppState,
    params: ServiceTokensDeleteParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    service_tokens::delete_service_token(uid, params.id, &mut conn, services.authz_service.as_ref())
}

pub async fn rotate(
    context: &RpcCallContext,
    services: &AppState,
    params: ServiceTokensRotateParams,
) -> Result<RotateServiceTokenResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    service_tokens::post_rotate_service_token(
        uid,
        params.id,
        &mut conn,
        services.authz_service.as_ref(),
        &services.config.auth.service_token_hash_key,
    )
}
