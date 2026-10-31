use axum::{
    extract::{Query, State},
    Json,
};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::groups::{NotificationExceptionsCleared, NotificationExceptionsResponse};
use crate::dto::notification_preferences::{ClearExceptionsQuery, ExceptionsQuery};
use crate::dto::users::{NotificationSettingsResponse, UpdateNotificationSettingsRequest};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::notification_preferences;
use crate::utils::auth::CurrentUid;
use crate::AppState;

#[utoipa::path(get, path = "/me/notification-settings", tag = "users",
    responses((status = OK, body = NotificationSettingsResponse)), security(("bearer_jwt" = [])))]
async fn get_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<NotificationSettingsResponse>, AppError> {
    notification_preferences::get_settings(uid, &mut conn).map(Json)
}

#[utoipa::path(patch, path = "/me/notification-settings", tag = "users", request_body = UpdateNotificationSettingsRequest,
    responses((status = OK, body = NotificationSettingsResponse)), security(("bearer_jwt" = [])))]
async fn patch_settings(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<UpdateNotificationSettingsRequest>,
) -> Result<Json<NotificationSettingsResponse>, AppError> {
    notification_preferences::patch_settings(uid, body, &mut conn, &state.ws_registry).map(Json)
}

#[utoipa::path(get, path = "/me/notification-exceptions", tag = "users", params(ExceptionsQuery),
    responses((status = OK, body = NotificationExceptionsResponse)), security(("bearer_jwt" = [])))]
async fn get_exceptions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<ExceptionsQuery>,
) -> Result<Json<NotificationExceptionsResponse>, AppError> {
    notification_preferences::get_exceptions(uid, query, &mut conn, &state.avatars, &state.media)
        .map(Json)
}

#[utoipa::path(delete, path = "/me/notification-exceptions", tag = "users", params(ClearExceptionsQuery),
    responses((status = OK, body = NotificationExceptionsCleared)), security(("bearer_jwt" = [])))]
async fn clear_exceptions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<ClearExceptionsQuery>,
) -> Result<Json<NotificationExceptionsCleared>, AppError> {
    notification_preferences::clear_exceptions(uid, query, &mut conn, &state.ws_registry).map(Json)
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_settings, patch_settings))
        .routes(utoipa_axum::routes!(get_exceptions, clear_exceptions))
}
