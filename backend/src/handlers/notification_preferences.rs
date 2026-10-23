use axum::{
    extract::{Query, State},
    Json,
};
use std::sync::Arc;
use utoipa_axum::router::OpenApiRouter;

use crate::dto::{
    groups::{
        ChatNotificationSettingResponse, NotificationException, NotificationExceptionsCleared,
        NotificationExceptionsResponse,
    },
    users::{NotificationSettingsResponse, UpdateNotificationSettingsRequest},
    ws::ServerWsMessage,
};
use crate::services::notification_preferences::{
    list_notification_exceptions, load_notification_defaults, update_notification_defaults,
};
use crate::{
    errors::AppError,
    extractors::DbConn,
    models::GroupKind,
    utils::{auth::CurrentUid, pagination::validate_limit},
    AppState,
};

#[utoipa::path(get, path = "/me/notification-settings", tag = "users",
    responses((status = OK, body = NotificationSettingsResponse)), security(("bearer_jwt" = [])))]
async fn get_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<NotificationSettingsResponse>, AppError> {
    Ok(Json(load_notification_defaults(&mut conn, uid)?.into()))
}

#[utoipa::path(patch, path = "/me/notification-settings", tag = "users", request_body = UpdateNotificationSettingsRequest,
    responses((status = OK, body = NotificationSettingsResponse)), security(("bearer_jwt" = [])))]
async fn patch_settings(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<UpdateNotificationSettingsRequest>,
) -> Result<Json<NotificationSettingsResponse>, AppError> {
    let _update = crate::services::notification_preferences::lock_notification_update(uid);
    let saved: NotificationSettingsResponse =
        update_notification_defaults(&mut conn, uid, &body)?.into();
    state.ws_registry.broadcast_to_uids(
        &[uid],
        Arc::new(ServerWsMessage::NotificationSettingsChanged(saved)),
    );
    Ok(Json(saved))
}

#[derive(serde::Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionsQuery {
    kind: GroupKind,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    after: Option<i64>,
    limit: Option<i64>,
}

#[utoipa::path(get, path = "/me/notification-exceptions", tag = "users", params(ExceptionsQuery),
    responses((status = OK, body = NotificationExceptionsResponse)), security(("bearer_jwt" = [])))]
async fn get_exceptions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<ExceptionsQuery>,
) -> Result<Json<NotificationExceptionsResponse>, AppError> {
    let page = list_notification_exceptions(
        &mut conn,
        uid,
        query.kind,
        query.after,
        validate_limit(query.limit, 100),
    )?;
    let peers = page
        .rows
        .iter()
        .filter(|row| row.kind == GroupKind::Dm)
        .filter_map(|row| {
            if row.dm_uid1 == Some(uid) {
                row.dm_uid2
            } else {
                row.dm_uid1
            }
        })
        .collect::<Vec<_>>();
    let peers = super::users::build_member_summary_map(&mut conn, &state, &peers)?;
    let defaults = load_notification_defaults(&mut conn, uid)?;
    let now = chrono::Utc::now();
    let exceptions = page
        .rows
        .into_iter()
        .map(|row| {
            let peer_uid = if row.dm_uid1 == Some(uid) {
                row.dm_uid2
            } else {
                row.dm_uid1
            };
            NotificationException {
                setting: ChatNotificationSettingResponse {
                    chat_id: row.chat_id,
                    kind: row.kind,
                    archived: row.archived,
                    muted_until: row.setting.muted_until,
                    mute_override: row.setting.mute_override,
                    is_muted: row.setting.is_muted(row.kind, defaults, now),
                },
                name: row.name,
                avatar: row
                    .avatar_key
                    .as_deref()
                    .map(|key| state.media.public_url(key)),
                peer: peer_uid.and_then(|uid| peers.get(&uid).cloned()),
            }
        })
        .collect();
    Ok(Json(NotificationExceptionsResponse {
        exceptions,
        total_count: page.total_count,
        next_cursor: page.next_cursor,
    }))
}

#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct ClearExceptionsQuery {
    kind: GroupKind,
}

#[utoipa::path(delete, path = "/me/notification-exceptions", tag = "users", params(ClearExceptionsQuery),
    responses((status = OK, body = NotificationExceptionsCleared)), security(("bearer_jwt" = [])))]
async fn clear_exceptions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<ClearExceptionsQuery>,
) -> Result<Json<NotificationExceptionsCleared>, AppError> {
    let _update = crate::services::notification_preferences::lock_notification_update(uid);
    let chat_ids = crate::services::notification_preferences::clear_notification_exceptions(
        &mut conn, uid, query.kind,
    )?;
    let cleared = NotificationExceptionsCleared {
        kind: query.kind,
        chat_ids: chat_ids.into_iter().map(|id| id.to_string()).collect(),
    };
    state.ws_registry.broadcast_to_uids(
        &[uid],
        Arc::new(ServerWsMessage::NotificationExceptionsCleared(
            cleared.clone(),
        )),
    );
    Ok(Json(cleared))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_settings, patch_settings))
        .routes(utoipa_axum::routes!(get_exceptions, clear_exceptions))
}
