use crate::dto::chats::{
    ListChatsResponse, MarkChatReadStateResponse, UnreadCountResponse, UnreadMentionIdsResponse,
    UnreadReactionIdsResponse, UnreadReactionsAckResponse,
};
use crate::dto::read_receipts::ReadReceiptResponse;
use crate::dto::rpc::chats::*;
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsListParams,
) -> Result<ListChatsResponse, AppError> {
    let uid = context.uid()?;
    let stages = services.metrics.api.stages("rpc", "chats.list");
    let pool = stages.start("pool_acquire");
    let mut conn = services.db.get()?;
    drop(pool);
    crate::services::api::chats::get_chats(
        uid,
        params.query,
        &mut conn,
        services.unread_service.as_ref(),
        &services.media,
        services.avatars.as_ref(),
        stages,
    )
    .await
}

pub async fn get_total_unread_count(
    context: &RpcCallContext,
    services: &RpcServices,
    _params: ChatsGetTotalUnreadCountParams,
) -> Result<UnreadCountResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::get_unread_count(
        principal,
        &mut conn,
        services.authz_service.as_ref(),
        services.unread_service.as_ref(),
    )
}

pub async fn archive(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsArchiveParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::archive_chat(
        uid,
        params.chat_id,
        &mut conn,
        services.ws_registry.as_ref(),
    )
}

pub async fn unarchive(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsUnarchiveParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::unarchive_chat(
        uid,
        params.chat_id,
        &mut conn,
        services.ws_registry.as_ref(),
    )
}

pub async fn mark_as_read(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsMarkAsReadParams,
) -> Result<MarkChatReadStateResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::mark_as_read(
        uid,
        params.chat_id,
        params.body,
        &mut conn,
        services.unread_service.as_ref(),
        &services.ws_registry,
    )
}

pub async fn mark_as_unread(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsMarkAsUnreadParams,
) -> Result<MarkChatReadStateResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::mark_as_unread(
        uid,
        params.chat_id,
        Some(params.body),
        &mut conn,
        services.unread_service.as_ref(),
        services.ws_registry.as_ref(),
    )
}

pub async fn get_unread_count(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsGetUnreadCountParams,
) -> Result<MarkChatReadStateResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::get_chat_unread_count(
        uid,
        params.chat_id,
        &mut conn,
        services.unread_service.as_ref(),
    )
}

pub async fn get_read_receipt(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsGetReadReceiptParams,
) -> Result<ReadReceiptResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::get_chat_read_receipt(uid, params.chat_id, params.query, &mut conn)
}

pub async fn list_mentions(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsListMentionsParams,
) -> Result<UnreadMentionIdsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::get_chat_mentions(
        uid,
        params.chat_id,
        params.query,
        &mut conn,
        services.unread_service.as_ref(),
    )
}

pub async fn list_unread_reactions(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsListUnreadReactionsParams,
) -> Result<UnreadReactionIdsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::get_chat_reactions(
        uid,
        params.chat_id,
        params.query,
        &mut conn,
        services.unread_service.as_ref(),
    )
}

pub async fn acknowledge_reactions(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ChatsAcknowledgeReactionsParams,
) -> Result<UnreadReactionsAckResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::acknowledge_chat_reactions(
        uid,
        params.chat_id,
        params.body,
        &mut conn,
        services.unread_service.as_ref(),
        services.ws_registry.as_ref(),
    )
}
