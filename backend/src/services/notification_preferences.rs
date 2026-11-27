use chrono::{DateTime, Duration, Utc};
use diesel::prelude::*;
use std::collections::HashMap;

use crate::dto::groups::{
    ChatNotificationSettingResponse, NotificationSettingMode, UpdateNotificationSettingRequest,
};
use crate::dto::users::{NotificationSettingsResponse, UpdateNotificationSettingsRequest};
use crate::errors::AppError;
use crate::models::{GroupKind, NewUserExtra};
use crate::schema::{group_membership, groups, media, user_extra};

pub const MAX_TEMPORARY_MUTE_SECONDS: i64 = 7 * 24 * 60 * 60;

// Keep an account's commit + snapshot broadcast in order within this server.
// Otherwise a slower handler could broadcast an older absolute snapshot after
// another device's successful write. Fixed stripes avoid retaining per-user locks.
static UPDATE_LOCKS: [std::sync::Mutex<()>; 64] = [const { std::sync::Mutex::new(()) }; 64];

pub fn lock_notification_update(uid: i32) -> std::sync::MutexGuard<'static, ()> {
    UPDATE_LOCKS[uid as usize % UPDATE_LOCKS.len()]
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod integration_tests;

#[derive(Debug, Default, Clone, Copy, Queryable, PartialEq, Eq)]
pub struct NotificationDefaults {
    pub group_chats_muted: bool,
    pub direct_chats_muted: bool,
}

impl From<NotificationDefaults> for NotificationSettingsResponse {
    fn from(value: NotificationDefaults) -> Self {
        Self {
            mute_group_chats_by_default: value.group_chats_muted,
            mute_direct_chats_by_default: value.direct_chats_muted,
        }
    }
}

pub fn load_notification_defaults(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<NotificationDefaults> {
    user_extra::table
        .find(uid)
        .select((
            user_extra::mute_group_chats_by_default,
            user_extra::mute_direct_chats_by_default,
        ))
        .first(conn)
        .optional()
        .map(|value| value.unwrap_or_default())
}

pub fn load_notification_defaults_for_users(
    conn: &mut PgConnection,
    uids: &[i32],
) -> QueryResult<HashMap<i32, NotificationDefaults>> {
    if uids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(user_extra::table
        .filter(user_extra::uid.eq_any(uids))
        .select((
            user_extra::uid,
            (
                user_extra::mute_group_chats_by_default,
                user_extra::mute_direct_chats_by_default,
            ),
        ))
        .load::<(i32, NotificationDefaults)>(conn)?
        .into_iter()
        .collect())
}

pub fn update_notification_defaults(
    conn: &mut PgConnection,
    uid: i32,
    patch: &UpdateNotificationSettingsRequest,
) -> Result<NotificationDefaults, AppError> {
    if patch.mute_group_chats_by_default.is_none() && patch.mute_direct_chats_by_default.is_none() {
        return Err(AppError::BadRequest(
            "At least one notification default is required",
        ));
    }
    let now = Utc::now().naive_utc();
    let user = NewUserExtra::new(uid, now);
    // The conflict UPDATE writes only supplied fields, so concurrent edits to
    // different categories cannot overwrite each other or unrelated user settings.
    Ok(diesel::insert_into(user_extra::table)
        .values((
            user,
            user_extra::mute_group_chats_by_default
                .eq(patch.mute_group_chats_by_default.unwrap_or(false)),
            user_extra::mute_direct_chats_by_default
                .eq(patch.mute_direct_chats_by_default.unwrap_or(false)),
        ))
        .on_conflict(user_extra::uid)
        .do_update()
        .set(patch)
        .returning((
            user_extra::mute_group_chats_by_default,
            user_extra::mute_direct_chats_by_default,
        ))
        .get_result(conn)?)
}

impl TryFrom<UpdateNotificationSettingRequest> for ChatNotificationCommand {
    type Error = AppError;
    fn try_from(request: UpdateNotificationSettingRequest) -> Result<Self, Self::Error> {
        match request.mode {
            NotificationSettingMode::TemporarilyMuted => Ok(Self::TemporarilyMuted {
                duration_seconds: request
                    .duration_seconds
                    .ok_or(AppError::BadRequest("Duration is required"))?,
            }),
            mode => {
                if request.duration_seconds.is_some() {
                    return Err(AppError::BadRequest(
                        "Duration is only valid for temporary mute",
                    ));
                }
                Ok(match mode {
                    NotificationSettingMode::Inherit => Self::Inherit,
                    NotificationSettingMode::AlwaysMuted => Self::AlwaysMuted,
                    NotificationSettingMode::AlwaysUnmuted => Self::AlwaysUnmuted,
                    NotificationSettingMode::TemporarilyMuted => unreachable!(),
                })
            }
        }
    }
}

pub fn load_chat_notification_setting(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<ChatNotificationSettingResponse, AppError> {
    let (kind, archived, setting) = group_membership::table
        .inner_join(groups::table)
        .filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        )
        .select((
            groups::kind,
            group_membership::archived,
            (
                group_membership::muted_until,
                group_membership::mute_override,
            ),
        ))
        .first::<(GroupKind, bool, ChatNotificationSetting)>(conn)?;
    let defaults = load_notification_defaults(conn, uid)?;
    Ok(ChatNotificationSettingResponse {
        chat_id,
        kind,
        archived,
        muted_until: setting.muted_until,
        mute_override: setting.mute_override,
        is_muted: setting.is_muted(kind, defaults, Utc::now()),
    })
}

/// Archiving changes list membership, never the user's notification preference.
pub fn set_chat_archived(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
    archived: bool,
) -> QueryResult<()> {
    diesel::update(
        group_membership::table.filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        ),
    )
    .set(group_membership::archived.eq(archived))
    .execute(conn)?;
    Ok(())
}

pub fn publish_chat_notification_setting(
    registry: &super::ws_registry::ConnectionRegistry,
    uid: i32,
    setting: ChatNotificationSettingResponse,
) {
    use crate::dto::ws::{ChatArchiveStateChangedPayload, ServerWsMessage};
    use std::sync::Arc;
    // Existing clients still consume the archive/mute snapshot through this event.
    registry.broadcast_to_uids(
        &[uid],
        Arc::new(ServerWsMessage::ChatArchiveStateChanged(
            ChatArchiveStateChangedPayload {
                chat_id: setting.chat_id,
                archived: setting.archived,
                muted_until: setting.muted_until,
            },
        )),
    );
    registry.broadcast_to_uids(
        &[uid],
        Arc::new(ServerWsMessage::ChatNotificationSettingChanged(setting)),
    );
}

#[derive(Queryable)]
pub struct ExceptionRow {
    pub chat_id: i64,
    pub name: String,
    pub avatar_key: Option<String>,
    pub kind: GroupKind,
    pub dm_uid1: Option<i32>,
    pub dm_uid2: Option<i32>,
    pub archived: bool,
    pub setting: ChatNotificationSetting,
}

pub struct ExceptionPage {
    pub rows: Vec<ExceptionRow>,
    pub total_count: i64,
    pub next_cursor: Option<i64>,
}

/// Clear only explicit exceptions. Inherited temporary mutes and archive flags stay intact.
pub fn clear_notification_exceptions(
    conn: &mut PgConnection,
    uid: i32,
    kind: GroupKind,
) -> QueryResult<Vec<i64>> {
    // Start from the owner's memberships; the subquery uses the group primary key.
    diesel::update(
        group_membership::table
            .filter(group_membership::uid.eq(uid))
            .filter(group_membership::mute_override.is_not_null())
            .filter(
                group_membership::chat_id.eq_any(
                    groups::table
                        .filter(groups::kind.eq(kind))
                        .select(groups::id),
                ),
            ),
    )
    .set((
        group_membership::mute_override.eq(None::<bool>),
        group_membership::muted_until.eq(None::<DateTime<Utc>>),
    ))
    .returning(group_membership::chat_id)
    .get_results(conn)
}

pub fn list_notification_exceptions(
    conn: &mut PgConnection,
    uid: i32,
    kind: GroupKind,
    after: Option<i64>,
    limit: i64,
) -> QueryResult<ExceptionPage> {
    // Both count and page use the uid membership index; no messages or per-row
    // fetches. An extra index is unnecessary for the user's bounded memberships.
    conn.build_transaction()
        .read_only()
        .repeatable_read()
        .run(|conn| {
            let total_count = group_membership::table
                .inner_join(groups::table)
                .filter(group_membership::uid.eq(uid))
                .filter(groups::kind.eq(kind))
                .filter(group_membership::mute_override.is_not_null())
                .count()
                .get_result(conn)?;
            let mut query = group_membership::table
                .inner_join(groups::table)
                .left_join(
                    media::table.on(groups::avatar_image_id
                        .eq(media::id.nullable())
                        .and(media::deleted_at.is_null())),
                )
                .filter(group_membership::uid.eq(uid))
                .filter(groups::kind.eq(kind))
                .filter(group_membership::mute_override.is_not_null())
                .into_boxed();
            if let Some(after) = after {
                query = query.filter(group_membership::chat_id.gt(after));
            }
            let mut rows = query
                .select((
                    groups::id,
                    groups::name,
                    media::storage_key.nullable(),
                    groups::kind,
                    groups::dm_uid1,
                    groups::dm_uid2,
                    group_membership::archived,
                    (
                        group_membership::muted_until,
                        group_membership::mute_override,
                    ),
                ))
                .order(group_membership::chat_id.asc())
                .limit(limit + 1)
                .load::<ExceptionRow>(conn)?;
            let more = rows.len() > limit as usize;
            rows.truncate(limit as usize);
            let next_cursor = more.then(|| rows.last().map(|row| row.chat_id)).flatten();
            Ok(ExceptionPage {
                rows,
                total_count,
                next_cursor,
            })
        })
}

#[derive(Debug, Clone, Copy, Queryable, PartialEq, Eq)]
pub struct ChatNotificationSetting {
    pub muted_until: Option<DateTime<Utc>>,
    /// None inherits the account default; false explicitly enables notifications.
    pub mute_override: Option<bool>,
}

impl ChatNotificationSetting {
    pub fn is_muted(
        self,
        kind: GroupKind,
        defaults: NotificationDefaults,
        now: DateTime<Utc>,
    ) -> bool {
        self.muted_until.is_some_and(|until| until > now)
            || self.mute_override.unwrap_or(match kind {
                GroupKind::Group => defaults.group_chats_muted,
                GroupKind::Dm => defaults.direct_chats_muted,
            })
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ChatNotificationCommand {
    Inherit,
    AlwaysMuted,
    AlwaysUnmuted,
    TemporarilyMuted {
        duration_seconds: i64,
    },
    /// Old clients only understand mutedUntil, including the permanent sentinel.
    LegacyMute {
        duration_seconds: Option<i64>,
    },
    LegacyUnmuteAndUnarchive,
}

#[derive(AsChangeset)]
#[diesel(table_name = group_membership)]
struct NotificationChanges {
    // The outer Option distinguishes "leave unchanged" from "clear".
    muted_until: Option<Option<DateTime<Utc>>>,
    mute_override: Option<Option<bool>>,
    archived: Option<bool>,
}

impl ChatNotificationCommand {
    fn changes(self, now: DateTime<Utc>) -> Result<NotificationChanges, AppError> {
        let mut changes = NotificationChanges {
            muted_until: Some(None),
            mute_override: Some(None),
            archived: None,
        };
        match self {
            Self::Inherit => {}
            Self::AlwaysMuted => changes.mute_override = Some(Some(true)),
            Self::AlwaysUnmuted => changes.mute_override = Some(Some(false)),
            Self::TemporarilyMuted { duration_seconds } => {
                if !(1..=MAX_TEMPORARY_MUTE_SECONDS).contains(&duration_seconds) {
                    return Err(AppError::BadRequest(
                        "Duration must be between 1 second and 7 days",
                    ));
                }
                changes.muted_until = Some(Some(now + Duration::seconds(duration_seconds)));
                changes.mute_override = None;
            }
            Self::LegacyMute { duration_seconds } => {
                let seconds = duration_seconds.unwrap_or(0);
                if seconds > MAX_TEMPORARY_MUTE_SECONDS {
                    return Err(AppError::BadRequest("Duration exceeds 7 day maximum"));
                }
                if seconds > 0 {
                    // Legacy clients expect a finite mute to expire back to the default.
                    changes.muted_until = Some(Some(now + Duration::seconds(seconds)));
                } else {
                    // Preserve the old null, zero and negative duration behavior.
                    changes.muted_until = Some(Some(super::chat::indefinite_mute_until()));
                    changes.mute_override = Some(Some(true));
                }
            }
            Self::LegacyUnmuteAndUnarchive => {
                changes.mute_override = Some(Some(false));
                changes.archived = Some(false);
            }
        }
        Ok(changes)
    }
}

/// Apply a notification command to an authorized membership in one UPDATE.
/// Temporary modern mutes preserve the override in SQL, including concurrent edits.
pub fn update_chat_notification_setting(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
    command: ChatNotificationCommand,
    now: DateTime<Utc>,
) -> Result<ChatNotificationSetting, AppError> {
    let changes = command.changes(now)?;
    Ok(diesel::update(
        group_membership::table.filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        ),
    )
    .set(changes)
    .returning((
        group_membership::muted_until,
        group_membership::mute_override,
    ))
    .get_result(conn)?)
}

#[cfg(test)]
mod tests;
