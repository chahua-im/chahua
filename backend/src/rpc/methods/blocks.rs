use crate::dto::blocks::ListBlocksResponse;
use crate::dto::rpc::blocks::{BlocksCreateParams, BlocksDeleteParams, BlocksListParams};
use crate::errors::AppError;
use crate::rpc::{AppState, RpcCallContext};
use crate::services::api::blocks;

pub async fn list(
    context: &RpcCallContext,
    services: &AppState,
    _: BlocksListParams,
) -> Result<ListBlocksResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    blocks::get_blocks(
        principal,
        &mut conn,
        services.authz_service.as_ref(),
        services.avatars.as_ref(),
    )
}

pub async fn create(
    context: &RpcCallContext,
    services: &AppState,
    params: BlocksCreateParams,
) -> Result<(), AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    blocks::block_user(
        principal,
        params.body,
        &mut conn,
        services.authz_service.as_ref(),
        services.presence_service.as_ref(),
        &services.ws_registry,
    )
}

pub async fn delete(
    context: &RpcCallContext,
    services: &AppState,
    params: BlocksDeleteParams,
) -> Result<(), AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    blocks::unblock_user(
        principal,
        params.uid,
        &mut conn,
        services.authz_service.as_ref(),
        services.presence_service.as_ref(),
        &services.ws_registry,
    )
}
