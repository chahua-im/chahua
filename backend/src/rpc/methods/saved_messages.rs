use crate::dto::{
    messages::ForwardedMessagesResponse,
    rpc::saved_messages::{
        SavedMessagesDeleteByMessageParams, SavedMessagesDeleteParams,
        SavedMessagesListForChatParams, SavedMessagesListForwardedBundleMessagesParams,
        SavedMessagesListForwardedMessagesParams, SavedMessagesListParams, SavedMessagesSaveParams,
    },
    saved_messages::{ListSavedMessagesResponse, SavedMessageResponse},
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::{chats::saved_messages as chat_api, saved_messages as api};

pub async fn list_for_chat(
    context: &RpcCallContext,
    services: &RpcServices,
    params: SavedMessagesListForChatParams,
) -> Result<ListSavedMessagesResponse, AppError> {
    let SavedMessagesListForChatParams { chat_id, query } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    chat_api::list_chat_saved_messages(uid, chat_id, query, &mut conn, &services.media)
}

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    params: SavedMessagesListParams,
) -> Result<ListSavedMessagesResponse, AppError> {
    let SavedMessagesListParams { query } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::list_saved_messages(uid, query, &mut conn, &services.media)
}

pub async fn save(
    context: &RpcCallContext,
    services: &RpcServices,
    params: SavedMessagesSaveParams,
) -> Result<SavedMessageResponse, AppError> {
    let SavedMessagesSaveParams { message_id } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::put_saved_message(
        uid,
        message_id,
        &mut conn,
        &services.media,
        &services.avatars,
        services.id_gen.as_ref(),
    )
    .await
}

pub async fn delete_by_message(
    context: &RpcCallContext,
    services: &RpcServices,
    params: SavedMessagesDeleteByMessageParams,
) -> Result<(), AppError> {
    let SavedMessagesDeleteByMessageParams { message_id } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::delete_saved_message_by_original(uid, message_id, &mut conn)
}

pub async fn delete(
    context: &RpcCallContext,
    services: &RpcServices,
    params: SavedMessagesDeleteParams,
) -> Result<(), AppError> {
    let SavedMessagesDeleteParams { saved_message_id } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::delete_saved_message_by_id(uid, saved_message_id, &mut conn)
}

pub async fn list_forwarded_messages(
    context: &RpcCallContext,
    services: &RpcServices,
    params: SavedMessagesListForwardedMessagesParams,
) -> Result<ForwardedMessagesResponse, AppError> {
    let SavedMessagesListForwardedMessagesParams { saved_message_id } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::get_saved_forwarded_messages(
        uid,
        saved_message_id,
        &mut conn,
        &services.media,
        &services.avatars,
    )
}

pub async fn list_forwarded_bundle_messages(
    context: &RpcCallContext,
    services: &RpcServices,
    params: SavedMessagesListForwardedBundleMessagesParams,
) -> Result<ForwardedMessagesResponse, AppError> {
    let SavedMessagesListForwardedBundleMessagesParams {
        saved_message_id,
        bundle_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::get_saved_forwarded_bundle_messages(
        uid,
        saved_message_id,
        bundle_id,
        &mut conn,
        &services.media,
        &services.avatars,
    )
}
