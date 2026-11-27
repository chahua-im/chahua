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
use crate::rpc::{AppState, RpcCallContext};
use crate::services::api::{notification_preferences, users};

pub async fn get_me(
    context: &RpcCallContext,
    services: &AppState,
    _params: UsersGetMeParams,
) -> Result<MeResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    users::get_me(
        uid,
        &mut conn,
        services.avatars.as_ref(),
        services.authz_service.as_ref(),
        &services.config.restricted_user_group_ids,
    )
}

pub async fn update_sticker_pack_order(
    context: &RpcCallContext,
    services: &AppState,
    params: UsersUpdateStickerPackOrderParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    users::put_stickerpack_order(uid, params.body, &mut conn, services.ws_registry.as_ref())
}

pub async fn update_chat_settings(
    context: &RpcCallContext,
    services: &AppState,
    params: UsersUpdateChatSettingsParams,
) -> Result<ChatSettings, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    users::put_chat_settings(uid, params.body, &mut conn, services.ws_registry.as_ref())
}

pub async fn search(
    context: &RpcCallContext,
    services: &AppState,
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
    services: &AppState,
    _params: UsersGetNotificationSettingsParams,
) -> Result<NotificationSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    notification_preferences::get_settings(uid, &mut conn)
}

pub async fn update_notification_settings(
    context: &RpcCallContext,
    services: &AppState,
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
    services: &AppState,
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
    services: &AppState,
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
