use crate::dto::{
    messages::ReactionDetailResponse,
    rpc::reactions::{ReactionsAddParams, ReactionsListParams, ReactionsRemoveParams},
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::chats::reactions as api;

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ReactionsListParams,
) -> Result<ReactionDetailResponse, AppError> {
    let ReactionsListParams {
        chat_id,
        message_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::get_reaction_details(uid, chat_id, message_id, &mut conn, &services.avatars)
}

pub async fn add(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ReactionsAddParams,
) -> Result<(), AppError> {
    let ReactionsAddParams {
        chat_id,
        message_id,
        emoji,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::put_reaction(
        uid,
        chat_id,
        message_id,
        emoji,
        &mut conn,
        &services.avatars,
        &services.ws_registry,
    )
}

pub async fn remove(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ReactionsRemoveParams,
) -> Result<(), AppError> {
    let ReactionsRemoveParams {
        chat_id,
        message_id,
        emoji,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::delete_reaction(
        uid,
        chat_id,
        message_id,
        emoji,
        &mut conn,
        &services.avatars,
        &services.ws_registry,
    )
}
