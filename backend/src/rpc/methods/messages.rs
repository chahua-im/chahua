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
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::chats::messages as api;

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesListParams,
) -> Result<ListMessagesResponse, AppError> {
    let MessagesListParams { chat_id, query } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::get_messages(
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
    services: &RpcServices,
    params: MessagesSendParams,
) -> Result<MessageResponse, AppError> {
    let MessagesSendParams { chat_id, body } = params;
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    api::post_message(
        principal,
        chat_id,
        body,
        &mut conn,
        api::PostMessageDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            link_previews: &services.link_previews,
            metrics: &services.metrics,
            authz_service: &services.authz_service,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
            message_search: &services.message_search,
        },
    )
    .await
}

pub async fn search(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesSearchParams,
) -> Result<SearchMessagesResponse, AppError> {
    let MessagesSearchParams { chat_id, query } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::search_messages(
        uid,
        chat_id,
        query,
        &mut conn,
        api::SearchMessagesDeps {
            media: &services.media,
            avatars: &services.avatars,
            metrics: &services.metrics,
            message_search: &services.message_search,
        },
    )
    .await
}

pub async fn get(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesGetParams,
) -> Result<MessageResponse, AppError> {
    let MessagesGetParams {
        chat_id,
        message_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::get_message(
        uid,
        chat_id,
        message_id,
        &mut conn,
        &services.media,
        &services.avatars,
    )
    .await
}

pub async fn edit(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesEditParams,
) -> Result<MessageResponse, AppError> {
    let MessagesEditParams {
        chat_id,
        message_id,
        body,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::patch_message(
        uid,
        chat_id,
        message_id,
        body,
        &mut conn,
        api::PatchMessageDeps {
            media: &services.media,
            avatars: &services.avatars,
            link_previews: &services.link_previews,
            ws_registry: &services.ws_registry,
            message_search: &services.message_search,
        },
    )
    .await
}

pub async fn delete(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesDeleteParams,
) -> Result<(), AppError> {
    let MessagesDeleteParams {
        chat_id,
        message_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::delete_message(
        uid,
        chat_id,
        message_id,
        &mut conn,
        api::DeleteMessageDeps {
            media: &services.media,
            avatars: &services.avatars,
            ws_registry: &services.ws_registry,
            message_search: &services.message_search,
        },
    )
    .await
}

pub async fn delete_many(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesDeleteManyParams,
) -> Result<BulkDeletedPayload, AppError> {
    let MessagesDeleteManyParams { chat_id, body } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::bulk_delete_messages(
        uid,
        chat_id,
        body,
        &mut conn,
        api::BulkDeleteMessagesDeps {
            media: &services.media,
            avatars: &services.avatars,
            ws_registry: &services.ws_registry,
            message_search: &services.message_search,
        },
    )
    .await
}

pub async fn forward(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesForwardParams,
) -> Result<MessageResponse, AppError> {
    let MessagesForwardParams { chat_id, body } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::forward_messages(
        uid,
        chat_id,
        body,
        &mut conn,
        api::ForwardMessagesDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
        },
    )
    .await
}

pub async fn forward_one(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesForwardOneParams,
) -> Result<MessageResponse, AppError> {
    let MessagesForwardOneParams {
        chat_id,
        message_id,
        body,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::forward_message(
        uid,
        chat_id,
        message_id,
        body,
        &mut conn,
        api::ForwardMessageDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
            message_search: &services.message_search,
        },
    )
    .await
}

pub async fn list_forwarded_messages(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesListForwardedMessagesParams,
) -> Result<ForwardedMessagesResponse, AppError> {
    let MessagesListForwardedMessagesParams {
        chat_id,
        message_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::get_forwarded_messages(
        uid,
        chat_id,
        message_id,
        &mut conn,
        &services.media,
        &services.avatars,
    )
}

pub async fn list_forwarded_bundle_messages(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesListForwardedBundleMessagesParams,
) -> Result<ForwardedMessagesResponse, AppError> {
    let MessagesListForwardedBundleMessagesParams {
        chat_id,
        message_id,
        bundle_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::get_forwarded_bundle_messages(
        uid,
        chat_id,
        message_id,
        bundle_id,
        &mut conn,
        &services.media,
        &services.avatars,
    )
}

pub async fn send_in_thread(
    context: &RpcCallContext,
    services: &RpcServices,
    params: MessagesSendInThreadParams,
) -> Result<MessageResponse, AppError> {
    let MessagesSendInThreadParams {
        chat_id,
        thread_id,
        body,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::post_thread_message(
        uid,
        chat_id,
        thread_id,
        body,
        &mut conn,
        api::PostThreadMessageDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            link_previews: &services.link_previews,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
            message_search: &services.message_search,
        },
    )
    .await
}

pub async fn preview_links(
    context: &RpcCallContext,
    services: &RpcServices,
    params: crate::dto::rpc::messages::MessagesPreviewLinksParams,
) -> Result<Vec<crate::dto::link_previews::LinkPreviewResponse>, AppError> {
    let uid = context.uid()?;
    {
        let mut conn = services.db.get()?;
        crate::services::api::members::check_membership(&mut conn, params.chat_id, uid)?;
    }
    services.link_previews.drafts.fetch(uid, params.urls).await
}
