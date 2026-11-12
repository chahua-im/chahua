use crate::dto::rpc::threads::*;
use crate::dto::threads::{
    ListChatThreadsResponse, ListThreadsResponse, MarkThreadReadResponse, ThreadReadStateResponse,
    ThreadSubscriptionStatusResponse, UnreadThreadCountResponse,
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsListParams,
) -> Result<ListThreadsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::get_threads(
        uid,
        params.query,
        &mut conn,
        &services.media,
        services.avatars.as_ref(),
    )
}

pub async fn get_unread_count(
    context: &RpcCallContext,
    services: &RpcServices,
    _params: ThreadsGetUnreadCountParams,
) -> Result<UnreadThreadCountResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::get_unread_thread_count(uid, &mut conn)
}

pub async fn list_for_chat(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsListForChatParams,
) -> Result<ListChatThreadsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::get_chat_threads(
        uid,
        params.chat_id,
        params.query,
        &mut conn,
        &services.media,
        services.avatars.as_ref(),
    )
    .await
}

pub async fn list_participants(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsListParticipantsParams,
) -> Result<crate::dto::chats::ListParticipantsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::get_thread_participants(
        uid,
        params.chat_id,
        params.thread_root_id,
        params.query,
        &mut conn,
        services.avatars.as_ref(),
    )
}

pub async fn mark_as_read(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsMarkAsReadParams,
) -> Result<MarkThreadReadResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::mark_thread_read_in_chat(
        uid,
        params.chat_id,
        params.thread_root_id,
        params.body,
        &mut conn,
        services.unread_service.as_ref(),
        &services.ws_registry,
    )
}

pub async fn get_read_state(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsGetReadStateParams,
) -> Result<ThreadReadStateResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::get_thread_read_state_in_chat(
        uid,
        params.chat_id,
        params.thread_root_id,
        &mut conn,
        services.unread_service.as_ref(),
    )
}

pub async fn get_subscription_status(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsGetSubscriptionStatusParams,
) -> Result<ThreadSubscriptionStatusResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::get_subscription_status(
        uid,
        params.chat_id,
        params.thread_root_id,
        &mut conn,
    )
}

pub async fn subscribe(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsSubscribeParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::subscribe_thread(
        uid,
        params.chat_id,
        params.thread_root_id,
        &mut conn,
        &services.ws_registry,
    )
}

pub async fn unsubscribe(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsUnsubscribeParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::unsubscribe_thread(
        uid,
        params.chat_id,
        params.thread_root_id,
        &mut conn,
        &services.ws_registry,
    )
}

pub async fn archive(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsArchiveParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::archive_thread(
        uid,
        params.chat_id,
        params.thread_root_id,
        &mut conn,
        &services.ws_registry,
    )
}

pub async fn unarchive(
    context: &RpcCallContext,
    services: &RpcServices,
    params: ThreadsUnarchiveParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::threads::unarchive_thread(
        uid,
        params.chat_id,
        params.thread_root_id,
        &mut conn,
        &services.ws_registry,
    )
}
