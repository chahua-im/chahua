use crate::dto::push::{SubscriptionStatusResponse, VapidPublicKeyResponse};
use crate::dto::rpc::push::{
    PushGetSubscriptionStatusParams, PushGetVapidPublicKeyParams, PushSubscribeParams,
    PushUnsubscribeParams,
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::push;

pub async fn get_vapid_public_key(
    _context: &RpcCallContext,
    services: &RpcServices,
    _params: PushGetVapidPublicKeyParams,
) -> Result<VapidPublicKeyResponse, AppError> {
    Ok(push::get_vapid_public_key(services.push_service.as_ref()))
}

pub async fn get_subscription_status(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PushGetSubscriptionStatusParams,
) -> Result<SubscriptionStatusResponse, AppError> {
    let session = context.verified_session()?;
    let mut conn = services.db.get()?;
    push::get_subscription_status(
        session.uid,
        session.client_id.clone(),
        params.query,
        &mut conn,
    )
}

pub async fn subscribe(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PushSubscribeParams,
) -> Result<(), AppError> {
    let session = context.verified_session()?;
    let mut conn = services.db.get()?;
    push::post_subscribe(
        session.uid,
        session.client_id.clone(),
        params.body,
        &mut conn,
        services.push_service.as_ref(),
        services.id_gen.as_ref(),
    )
    .await
}

pub async fn unsubscribe(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PushUnsubscribeParams,
) -> Result<(), AppError> {
    let session = context.verified_session()?;
    let mut conn = services.db.get()?;
    push::post_unsubscribe(
        session.uid,
        session.client_id.clone(),
        params.body,
        &mut conn,
    )
}
