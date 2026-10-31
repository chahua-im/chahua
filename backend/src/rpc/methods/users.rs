use crate::dto::groups::{NotificationExceptionsCleared, NotificationExceptionsResponse};
use crate::dto::rpc::users::{
    UsersClearNotificationExceptionsParams, UsersGetMeParams, UsersGetNotificationSettingsParams,
    UsersListNotificationExceptionsParams, UsersSearchParams, UsersUpdateChatSettingsParams,
    UsersUpdateNotificationSettingsParams, UsersUpdateStickerPackOrderParams,
};
use crate::dto::users::{
    ChatSettings, MeResponse, NotificationSettingsResponse, SearchUsersResponse,
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::{notification_preferences, users};

pub async fn get_me(
    context: &RpcCallContext,
    services: &RpcServices,
    _params: UsersGetMeParams,
) -> Result<MeResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    users::get_me(
        uid,
        &mut conn,
        services.avatars.as_ref(),
        services.authz_service.as_ref(),
    )
}

pub async fn update_sticker_pack_order(
    context: &RpcCallContext,
    services: &RpcServices,
    params: UsersUpdateStickerPackOrderParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    users::put_stickerpack_order(uid, params.body, &mut conn, services.ws_registry.as_ref())
}

pub async fn update_chat_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: UsersUpdateChatSettingsParams,
) -> Result<ChatSettings, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    users::put_chat_settings(uid, params.body, &mut conn, services.ws_registry.as_ref())
}

pub async fn search(
    context: &RpcCallContext,
    services: &RpcServices,
    params: UsersSearchParams,
) -> Result<SearchUsersResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    users::get_user_search(
        uid,
        params.query,
        &mut conn,
        services.avatars.as_ref(),
        services.authz_service.as_ref(),
    )
}

pub async fn get_notification_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    _params: UsersGetNotificationSettingsParams,
) -> Result<NotificationSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    notification_preferences::get_settings(uid, &mut conn)
}

pub async fn update_notification_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: UsersUpdateNotificationSettingsParams,
) -> Result<NotificationSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    notification_preferences::patch_settings(
        uid,
        params.body,
        &mut conn,
        services.ws_registry.as_ref(),
    )
}

pub async fn list_notification_exceptions(
    context: &RpcCallContext,
    services: &RpcServices,
    params: UsersListNotificationExceptionsParams,
) -> Result<NotificationExceptionsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    notification_preferences::get_exceptions(
        uid,
        params.query,
        &mut conn,
        services.avatars.as_ref(),
        &services.media,
    )
}

pub async fn clear_notification_exceptions(
    context: &RpcCallContext,
    services: &RpcServices,
    params: UsersClearNotificationExceptionsParams,
) -> Result<NotificationExceptionsCleared, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    notification_preferences::clear_exceptions(
        uid,
        params.query,
        &mut conn,
        services.ws_registry.as_ref(),
    )
}
