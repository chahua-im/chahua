use crate::dto::friends::{
    PresenceSettingsResponse, PrivacyExceptionsResponse, ReadReceiptSettingsResponse,
};
use crate::dto::rpc::privacy::{
    PrivacyClearExceptionsParams, PrivacyGetPresenceSettingsParams,
    PrivacyGetReadReceiptSettingsParams, PrivacyListExceptionsParams,
    PrivacyUpdatePresenceSettingsParams, PrivacyUpdateReadReceiptSettingsParams,
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::friends;

pub async fn get_presence_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    _: PrivacyGetPresenceSettingsParams,
) -> Result<PresenceSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::get_my_presence_settings(uid, &mut conn).await
}

pub async fn update_presence_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PrivacyUpdatePresenceSettingsParams,
) -> Result<PresenceSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::update_my_presence_settings(
        uid,
        params.body,
        &mut conn,
        services.presence_service.as_ref(),
    )
    .await
}

pub async fn get_read_receipt_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    _: PrivacyGetReadReceiptSettingsParams,
) -> Result<ReadReceiptSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::get_my_read_receipt_settings(uid, &mut conn).await
}

pub async fn update_read_receipt_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PrivacyUpdateReadReceiptSettingsParams,
) -> Result<ReadReceiptSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::update_my_read_receipt_settings(uid, params.body, &mut conn, &services.ws_registry)
        .await
}

pub async fn list_exceptions(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PrivacyListExceptionsParams,
) -> Result<PrivacyExceptionsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::get_privacy_exceptions(uid, params.query.kind, &mut conn, services.avatars.as_ref())
        .await
}

pub async fn clear_exceptions(
    context: &RpcCallContext,
    services: &RpcServices,
    params: PrivacyClearExceptionsParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::clear_privacy_exceptions(
        uid,
        params.query.kind,
        &mut conn,
        services.presence_service.as_ref(),
        &services.ws_registry,
    )
    .await
}
