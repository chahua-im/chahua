use crate::dto::{
    pins::{ListPinsResponse, PinResponse},
    rpc::pins::{
        PinsCreateForThreadParams, PinsCreateParams, PinsDeleteForThreadParams, PinsDeleteParams,
        PinsListForThreadParams, PinsListParams,
    },
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::pins as api;

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PinsListParams,
) -> Result<ListPinsResponse, AppError> {
    let PinsListParams { chat_id } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::list_pins(uid, chat_id, &mut conn, &services.media, &services.avatars).await
}

pub async fn create(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PinsCreateParams,
) -> Result<PinResponse, AppError> {
    let PinsCreateParams { chat_id, body } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::create_pin(
        uid,
        chat_id,
        body,
        &mut conn,
        api::CreatePinDeps {
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

pub async fn delete(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PinsDeleteParams,
) -> Result<(), AppError> {
    let PinsDeleteParams { chat_id, pin_id } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::delete_pin(
        uid,
        chat_id,
        pin_id,
        &mut conn,
        api::DeletePinDeps {
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

pub async fn list_for_thread(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PinsListForThreadParams,
) -> Result<ListPinsResponse, AppError> {
    let PinsListForThreadParams {
        chat_id,
        thread_root_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::list_thread_pins(
        uid,
        chat_id,
        thread_root_id,
        &mut conn,
        &services.media,
        &services.avatars,
    )
    .await
}

pub async fn create_for_thread(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PinsCreateForThreadParams,
) -> Result<PinResponse, AppError> {
    let PinsCreateForThreadParams {
        chat_id,
        thread_root_id,
        body,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::create_thread_pin(
        uid,
        chat_id,
        thread_root_id,
        body,
        &mut conn,
        api::CreatePinDeps {
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

pub async fn delete_for_thread(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PinsDeleteForThreadParams,
) -> Result<(), AppError> {
    let PinsDeleteForThreadParams {
        chat_id,
        thread_root_id,
        pin_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    api::delete_thread_pin(
        uid,
        chat_id,
        thread_root_id,
        pin_id,
        &mut conn,
        api::DeletePinDeps {
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
