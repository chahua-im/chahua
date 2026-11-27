use crate::dto::{
    pins::{ListPinsResponse, PinResponse},
    rpc::pins::{
        PinsCreateForThreadParams, PinsCreateParams, PinsDeleteForThreadParams, PinsDeleteParams,
        PinsListForThreadParams, PinsListParams,
    },
};
use crate::errors::AppError;
use crate::rpc::{AppState, RpcCallContext};

pub async fn list(
    context: &RpcCallContext,
    services: &AppState,
    params: PinsListParams,
) -> Result<ListPinsResponse, AppError> {
    let PinsListParams { chat_id } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services.pins.list_pins(uid, chat_id, &mut conn).await
}

pub async fn create(
    context: &RpcCallContext,
    services: &AppState,
    params: PinsCreateParams,
) -> Result<PinResponse, AppError> {
    let PinsCreateParams { chat_id, body } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .pins
        .create_pin(uid, chat_id, body, &mut conn)
        .await
}

pub async fn delete(
    context: &RpcCallContext,
    services: &AppState,
    params: PinsDeleteParams,
) -> Result<(), AppError> {
    let PinsDeleteParams { chat_id, pin_id } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .pins
        .delete_pin(uid, chat_id, pin_id, &mut conn)
        .await
}

pub async fn list_for_thread(
    context: &RpcCallContext,
    services: &AppState,
    params: PinsListForThreadParams,
) -> Result<ListPinsResponse, AppError> {
    let PinsListForThreadParams {
        chat_id,
        thread_root_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .pins
        .list_thread_pins(uid, chat_id, thread_root_id, &mut conn)
        .await
}

pub async fn create_for_thread(
    context: &RpcCallContext,
    services: &AppState,
    params: PinsCreateForThreadParams,
) -> Result<PinResponse, AppError> {
    let PinsCreateForThreadParams {
        chat_id,
        thread_root_id,
        body,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .pins
        .create_thread_pin(uid, chat_id, thread_root_id, body, &mut conn)
        .await
}

pub async fn delete_for_thread(
    context: &RpcCallContext,
    services: &AppState,
    params: PinsDeleteForThreadParams,
) -> Result<(), AppError> {
    let PinsDeleteForThreadParams {
        chat_id,
        thread_root_id,
        pin_id,
    } = params;
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .pins
        .delete_thread_pin(uid, chat_id, thread_root_id, pin_id, &mut conn)
        .await
}
