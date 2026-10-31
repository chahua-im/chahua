use std::sync::Arc;

use diesel::PgConnection;

use crate::dto::groups::{
    ChatNotificationSettingResponse, NotificationException, NotificationExceptionsCleared,
    NotificationExceptionsResponse,
};
use crate::dto::notification_preferences::{ClearExceptionsQuery, ExceptionsQuery};
use crate::dto::users::{NotificationSettingsResponse, UpdateNotificationSettingsRequest};
use crate::dto::ws::ServerWsMessage;
use crate::errors::AppError;
use crate::models::GroupKind;
use crate::services::api::users::build_member_summary_map;
use crate::services::avatars::AvatarService;
use crate::services::media::MediaStore;
use crate::services::notification_preferences::{
    clear_notification_exceptions, list_notification_exceptions, load_notification_defaults,
    lock_notification_update, update_notification_defaults,
};
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::pagination::validate_limit;

pub fn get_settings(
    uid: i32,
    conn: &mut PgConnection,
) -> Result<NotificationSettingsResponse, AppError> {
    Ok(load_notification_defaults(conn, uid)?.into())
}

pub fn patch_settings(
    uid: i32,
    body: UpdateNotificationSettingsRequest,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<NotificationSettingsResponse, AppError> {
    let _update = lock_notification_update(uid);
    let saved: NotificationSettingsResponse =
        update_notification_defaults(conn, uid, &body)?.into();
    ws_registry.broadcast_to_uids(
        &[uid],
        Arc::new(ServerWsMessage::NotificationSettingsChanged(saved)),
    );
    Ok(saved)
}

pub fn get_exceptions(
    uid: i32,
    query: ExceptionsQuery,
    conn: &mut PgConnection,
    avatars: &AvatarService,
    media: &MediaStore,
) -> Result<NotificationExceptionsResponse, AppError> {
    let page = list_notification_exceptions(
        conn,
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
    let peers = build_member_summary_map(conn, avatars, &peers)?;
    let defaults = load_notification_defaults(conn, uid)?;
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
                avatar: row.avatar_key.as_deref().map(|key| media.public_url(key)),
                peer: peer_uid.and_then(|uid| peers.get(&uid).cloned()),
            }
        })
        .collect();
    Ok(NotificationExceptionsResponse {
        exceptions,
        total_count: page.total_count,
        next_cursor: page.next_cursor,
    })
}

pub fn clear_exceptions(
    uid: i32,
    query: ClearExceptionsQuery,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<NotificationExceptionsCleared, AppError> {
    let _update = lock_notification_update(uid);
    let chat_ids = clear_notification_exceptions(conn, uid, query.kind)?;
    let cleared = NotificationExceptionsCleared {
        kind: query.kind,
        chat_ids: chat_ids.into_iter().map(|id| id.to_string()).collect(),
    };
    ws_registry.broadcast_to_uids(
        &[uid],
        Arc::new(ServerWsMessage::NotificationExceptionsCleared(
            cleared.clone(),
        )),
    );
    Ok(cleared)
}
