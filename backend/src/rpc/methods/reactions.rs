use crate::dto::{
    messages::ReactionDetailResponse,
    rpc::reactions::{ReactionsAddParams, ReactionsListParams, ReactionsRemoveParams},
};
use crate::errors::AppError;
use crate::rpc::{AppState, RpcCallContext};

pub async fn list(
    context: &RpcCallContext,
    services: &AppState,
    params: ReactionsListParams,
) -> Result<ReactionDetailResponse, AppError> {
    let ReactionsListParams {
        chat_id,
        message_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .reactions
        .get_reaction_details(uid, chat_id, message_id, &mut conn)
}

pub async fn add(
    context: &RpcCallContext,
    services: &AppState,
    params: ReactionsAddParams,
) -> Result<(), AppError> {
    let ReactionsAddParams {
        chat_id,
        message_id,
        emoji,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .reactions
        .put_reaction(uid, chat_id, message_id, emoji, &mut conn)
}

pub async fn remove(
    context: &RpcCallContext,
    services: &AppState,
    params: ReactionsRemoveParams,
) -> Result<(), AppError> {
    let ReactionsRemoveParams {
        chat_id,
        message_id,
        emoji,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .reactions
        .delete_reaction(uid, chat_id, message_id, emoji, &mut conn)
}
