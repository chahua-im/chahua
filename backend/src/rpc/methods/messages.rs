use crate::dto::{
    messages::{
        ForwardedMessagesResponse, ListMessagesResponse, MessageResponse, SearchMessagesResponse,
    },
    rpc::messages::{
        MessagesDeleteManyParams, MessagesDeleteParams, MessagesEditParams,
        MessagesForwardOneParams, MessagesForwardParams, MessagesGetParams,
        MessagesListForwardedBundleMessagesParams, MessagesListForwardedMessagesParams,
        MessagesListParams, MessagesSearchParams, MessagesSendInThreadParams, MessagesSendParams,
    },
    ws::BulkDeletedPayload,
};
use crate::errors::AppError;
use crate::rpc::RpcCallContext;
use crate::AppState;

pub async fn list(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesListParams,
) -> Result<ListMessagesResponse, AppError> {
    let MessagesListParams { chat_id, query } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::messages::get_messages(
        uid,
        chat_id,
        query,
        &mut conn,
        &services.media,
        &services.avatars,
    )
    .await
}

pub async fn send(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesSendParams,
) -> Result<MessageResponse, AppError> {
    let MessagesSendParams { chat_id, body } = params;
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .post_message(principal, chat_id, body, &mut conn)
        .await
}

pub async fn search(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesSearchParams,
) -> Result<SearchMessagesResponse, AppError> {
    let MessagesSearchParams { chat_id, query } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .search_messages(uid, chat_id, query, &mut conn)
        .await
}

pub async fn get(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesGetParams,
) -> Result<MessageResponse, AppError> {
    let MessagesGetParams {
        chat_id,
        message_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .get_message(uid, chat_id, message_id, &mut conn)
        .await
}

pub async fn edit(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesEditParams,
) -> Result<MessageResponse, AppError> {
    let MessagesEditParams {
        chat_id,
        message_id,
        body,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .patch_message(uid, chat_id, message_id, body, &mut conn)
        .await
}

pub async fn delete(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesDeleteParams,
) -> Result<(), AppError> {
    let MessagesDeleteParams {
        chat_id,
        message_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .delete_message(uid, chat_id, message_id, &mut conn)
        .await
}

pub async fn delete_many(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesDeleteManyParams,
) -> Result<BulkDeletedPayload, AppError> {
    let MessagesDeleteManyParams { chat_id, body } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .bulk_delete_messages(uid, chat_id, body, &mut conn)
        .await
}

pub async fn forward(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesForwardParams,
) -> Result<MessageResponse, AppError> {
    let MessagesForwardParams { chat_id, body } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .forward_messages(uid, chat_id, body, &mut conn)
        .await
}

pub async fn forward_one(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesForwardOneParams,
) -> Result<MessageResponse, AppError> {
    let MessagesForwardOneParams {
        chat_id,
        message_id,
        body,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .forward_message(uid, chat_id, message_id, body, &mut conn)
        .await
}

pub async fn list_forwarded_messages(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesListForwardedMessagesParams,
) -> Result<ForwardedMessagesResponse, AppError> {
    let MessagesListForwardedMessagesParams {
        chat_id,
        message_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .get_forwarded_messages(uid, chat_id, message_id, &mut conn)
}

pub async fn list_forwarded_bundle_messages(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesListForwardedBundleMessagesParams,
) -> Result<ForwardedMessagesResponse, AppError> {
    let MessagesListForwardedBundleMessagesParams {
        chat_id,
        message_id,
        bundle_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .get_forwarded_bundle_messages(uid, chat_id, message_id, bundle_id, &mut conn)
}

pub async fn send_in_thread(
    context: &RpcCallContext,
    services: &AppState,
    params: MessagesSendInThreadParams,
) -> Result<MessageResponse, AppError> {
    let MessagesSendInThreadParams {
        chat_id,
        thread_id,
        body,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .messages
        .post_thread_message(uid, chat_id, thread_id, body, &mut conn)
        .await
}

pub async fn preview_links(
    context: &RpcCallContext,
    services: &AppState,
    params: crate::dto::rpc::messages::MessagesPreviewLinksParams,
) -> Result<Vec<crate::dto::link_previews::LinkPreviewResponse>, AppError> {
    let uid = context.uid()?;
    {
        let mut conn = services.db.get()?;
        crate::services::api::members::check_membership(&mut conn, params.chat_id, uid)?;
    }
    services.link_previews.drafts.fetch(uid, params.urls).await
}
