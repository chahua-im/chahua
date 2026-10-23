use chrono::{DateTime, Duration, Utc};
use diesel::prelude::*;
use std::collections::HashMap;

use crate::dto::groups::{
    ChatNotificationSettingResponse, NotificationSettingMode, UpdateNotificationSettingRequest,
};
use crate::dto::users::{NotificationSettingsResponse, UpdateNotificationSettingsRequest};
use crate::errors::AppError;
use crate::models::{FriendAddVerificationMode, GroupKind, NewUserExtra, PresenceVisibility};
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

#[derive(Debug, Clone, Copy, Queryable, PartialEq, Eq)]
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
    let user = NewUserExtra {
        uid,
        first_seen_at: now,
        last_seen_at: now,
        sticker_pack_order: serde_json::json!([]),
        verification_mode: FriendAddVerificationMode::Direct,
        verification_question: None,
        presence_visibility: PresenceVisibility::Everyone,
    };
    // The conflict UPDATE writes only supplied fields, so concurrent edits to
    // different categories cannot overwrite each other or unrelated user settings.
    Ok(diesel::insert_into(user_extra::table)
        .values((
            user,
            user_extra::mute_group_chats_by_default
                .eq(patch.mute_group_chats_by_default.unwrap_or(true)),
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

impl Default for NotificationDefaults {
    fn default() -> Self {
        Self {
            group_chats_muted: true,
            direct_chats_muted: false,
        }
    }
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
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-23T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn new_and_missing_accounts_mute_groups_but_notify_direct_chats() {
        let defaults = NotificationDefaults::default();
        assert!(defaults.group_chats_muted);
        assert!(!defaults.direct_chats_muted);
        let inherited = ChatNotificationSetting {
            muted_until: None,
            mute_override: None,
        };
        assert!(inherited.is_muted(GroupKind::Group, defaults, now()));
        assert!(!inherited.is_muted(GroupKind::Dm, defaults, now()));
    }

    #[test]
    fn effective_mute_covers_defaults_overrides_and_expiry_boundaries() {
        let now = now();
        for group_chats_muted in [false, true] {
            for direct_chats_muted in [false, true] {
                let defaults = NotificationDefaults {
                    group_chats_muted,
                    direct_chats_muted,
                };
                for kind in [GroupKind::Group, GroupKind::Dm] {
                    let inherited = match kind {
                        GroupKind::Group => group_chats_muted,
                        GroupKind::Dm => direct_chats_muted,
                    };
                    for mute_override in [None, Some(false), Some(true)] {
                        for muted_until in [None, Some(now - Duration::seconds(1)), Some(now)] {
                            assert_eq!(
                                ChatNotificationSetting {
                                    muted_until,
                                    mute_override
                                }
                                .is_muted(kind, defaults, now),
                                mute_override.unwrap_or(inherited),
                            );
                        }
                        assert!(ChatNotificationSetting {
                            muted_until: Some(now + Duration::seconds(1)),
                            mute_override,
                        }
                        .is_muted(kind, defaults, now));
                    }
                }
            }
        }
    }

    #[test]
    fn modern_commands_clear_or_preserve_the_fallback_deliberately() {
        for (command, expected) in [
            (ChatNotificationCommand::Inherit, None),
            (ChatNotificationCommand::AlwaysMuted, Some(true)),
            (ChatNotificationCommand::AlwaysUnmuted, Some(false)),
        ] {
            let changes = command.changes(now()).unwrap();
            assert_eq!(changes.muted_until, Some(None));
            assert_eq!(changes.mute_override, Some(expected));
            assert_eq!(changes.archived, None);
        }
        for duration_seconds in [1, MAX_TEMPORARY_MUTE_SECONDS] {
            let changes = ChatNotificationCommand::TemporarilyMuted { duration_seconds }
                .changes(now())
                .unwrap();
            assert_eq!(
                changes.muted_until,
                Some(Some(now() + Duration::seconds(duration_seconds)))
            );
            assert_eq!(changes.mute_override, None);
            assert_eq!(changes.archived, None);
        }
        for duration_seconds in [i64::MIN, -1, 0, MAX_TEMPORARY_MUTE_SECONDS + 1, i64::MAX] {
            assert!(matches!(
                ChatNotificationCommand::TemporarilyMuted { duration_seconds }.changes(now()),
                Err(AppError::BadRequest(
                    "Duration must be between 1 second and 7 days"
                ))
            ));
        }
    }

    #[test]
    fn legacy_commands_keep_the_timestamp_contract_and_atomic_unarchive() {
        for duration_seconds in [None, Some(i64::MIN), Some(-1), Some(0)] {
            let changes = ChatNotificationCommand::LegacyMute { duration_seconds }
                .changes(now())
                .unwrap();
            assert_eq!(
                changes.muted_until,
                Some(Some(super::super::chat::indefinite_mute_until()))
            );
            assert_eq!(changes.mute_override, Some(Some(true)));
            assert_eq!(changes.archived, None);
        }
        for seconds in [1, MAX_TEMPORARY_MUTE_SECONDS] {
            let changes = ChatNotificationCommand::LegacyMute {
                duration_seconds: Some(seconds),
            }
            .changes(now())
            .unwrap();
            assert_eq!(
                changes.muted_until,
                Some(Some(now() + Duration::seconds(seconds)))
            );
            assert_eq!(changes.mute_override, Some(None));
            assert_eq!(changes.archived, None);
        }
        for seconds in [MAX_TEMPORARY_MUTE_SECONDS + 1, i64::MAX] {
            assert!(matches!(
                ChatNotificationCommand::LegacyMute {
                    duration_seconds: Some(seconds)
                }
                .changes(now()),
                Err(AppError::BadRequest("Duration exceeds 7 day maximum"))
            ));
        }
        let changes = ChatNotificationCommand::LegacyUnmuteAndUnarchive
            .changes(now())
            .unwrap();
        assert_eq!(changes.muted_until, Some(None));
        assert_eq!(changes.mute_override, Some(Some(false)));
        assert_eq!(changes.archived, Some(false));
    }

    #[test]
    fn database_commands_preserve_overrides_and_other_memberships() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute(
            "CREATE TEMP TABLE group_membership (
                chat_id BIGINT, uid INTEGER, muted_until TIMESTAMPTZ,
                mute_override BOOLEAN, archived BOOLEAN NOT NULL DEFAULT FALSE,
                PRIMARY KEY (chat_id, uid));
             INSERT INTO group_membership (chat_id, uid, archived)
             VALUES (1, 10, TRUE), (1, 20, FALSE), (2, 10, FALSE);",
        )
        .unwrap();
        let read = |conn: &mut PgConnection| {
            group_membership::table
                .filter(
                    group_membership::chat_id
                        .eq(1)
                        .and(group_membership::uid.eq(10)),
                )
                .select((
                    group_membership::muted_until,
                    group_membership::mute_override,
                    group_membership::archived,
                ))
                .first::<(Option<DateTime<Utc>>, Option<bool>, bool)>(conn)
                .unwrap()
        };
        for override_command in [
            ChatNotificationCommand::Inherit,
            ChatNotificationCommand::AlwaysMuted,
            ChatNotificationCommand::AlwaysUnmuted,
        ] {
            let fallback =
                update_chat_notification_setting(&mut conn, 1, 10, override_command, now())
                    .unwrap();
            let temporary = update_chat_notification_setting(
                &mut conn,
                1,
                10,
                ChatNotificationCommand::TemporarilyMuted {
                    duration_seconds: 60,
                },
                now(),
            )
            .unwrap();
            assert_eq!(temporary.mute_override, fallback.mute_override);
            assert_eq!(temporary.muted_until, Some(now() + Duration::seconds(60)));
            assert!(read(&mut conn).2);
            assert_eq!(
                temporary.is_muted(
                    GroupKind::Group,
                    NotificationDefaults::default(),
                    now() + Duration::seconds(60)
                ),
                fallback.mute_override.unwrap_or(true)
            );
        }
        update_chat_notification_setting(
            &mut conn,
            1,
            10,
            ChatNotificationCommand::LegacyMute {
                duration_seconds: None,
            },
            now(),
        )
        .unwrap();
        assert_eq!(
            read(&mut conn),
            (
                Some(super::super::chat::indefinite_mute_until()),
                Some(true),
                true
            )
        );
        update_chat_notification_setting(
            &mut conn,
            1,
            10,
            ChatNotificationCommand::LegacyMute {
                duration_seconds: Some(60),
            },
            now(),
        )
        .unwrap();
        assert_eq!(
            read(&mut conn),
            (Some(now() + Duration::seconds(60)), None, true)
        );
        let before = read(&mut conn);
        assert!(update_chat_notification_setting(
            &mut conn,
            1,
            10,
            ChatNotificationCommand::LegacyMute {
                duration_seconds: Some(MAX_TEMPORARY_MUTE_SECONDS + 1)
            },
            now()
        )
        .is_err());
        assert_eq!(read(&mut conn), before);
        update_chat_notification_setting(
            &mut conn,
            1,
            10,
            ChatNotificationCommand::LegacyUnmuteAndUnarchive,
            now(),
        )
        .unwrap();
        assert_eq!(read(&mut conn), (None, Some(false), false));
        assert!(matches!(
            update_chat_notification_setting(
                &mut conn,
                1,
                30,
                ChatNotificationCommand::AlwaysMuted,
                now()
            ),
            Err(AppError::DbQuery(diesel::result::Error::NotFound))
        ));
        let others = group_membership::table
            .filter(
                group_membership::chat_id
                    .ne(1)
                    .or(group_membership::uid.ne(10)),
            )
            .select((
                group_membership::muted_until,
                group_membership::mute_override,
                group_membership::archived,
            ))
            .load::<(Option<DateTime<Utc>>, Option<bool>, bool)>(&mut conn)
            .unwrap();
        assert_eq!(others, vec![(None, None, false); 2]);
    }

    #[test]
    fn database_migration_preserves_history_and_unrelated_profile_updates() {
        use crate::models::{
            FriendAddVerificationMode, NewUserExtra, PresenceVisibility, UserExtra,
        };
        use crate::schema::user_extra;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        // Reconstruct the prior user table while keeping real enum types/defaults.
        // ALTER TABLE resolves to these temporary tables, never application rows.
        conn.batch_execute(
            "CREATE TEMP TABLE user_extra (LIKE public.user_extra INCLUDING ALL);
             ALTER TABLE user_extra DROP COLUMN mute_group_chats_by_default,
                 DROP COLUMN mute_direct_chats_by_default;
             CREATE TEMP TABLE group_membership (
                 chat_id BIGINT, uid INTEGER, muted_until TIMESTAMPTZ, archived BOOLEAN,
                 PRIMARY KEY (chat_id, uid));
             INSERT INTO group_membership VALUES
                 (1, 10, '9999-12-31 23:59:59+00', TRUE),
                 (2, 10, '9999-12-31 23:59:59+00', FALSE),
                 (3, 10, '2026-10-24 08:00:00+00', FALSE),
                 (4, 10, NULL, FALSE);",
        )
        .unwrap();
        let user = NewUserExtra {
            uid: 10,
            first_seen_at: now().naive_utc(),
            last_seen_at: now().naive_utc(),
            sticker_pack_order: serde_json::json!([{"stickerPackId": "123", "lastUsedOn": 42}]),
            verification_mode: FriendAddVerificationMode::Question,
            verification_question: Some("question".into()),
            presence_visibility: PresenceVisibility::Nobody,
        };
        diesel::insert_into(user_extra::table)
            .values(&user)
            .execute(&mut conn)
            .unwrap();
        let history = |conn: &mut PgConnection| {
            group_membership::table
                .order(group_membership::chat_id)
                .select((group_membership::muted_until, group_membership::archived))
                .load::<(Option<DateTime<Utc>>, bool)>(conn)
                .unwrap()
        };
        let before = history(&mut conn);
        let up = include_str!(
            "../../migrations/2026-10-23-090458-0000_add_notification_preferences/up.sql"
        );
        let down = include_str!(
            "../../migrations/2026-10-23-090458-0000_add_notification_preferences/down.sql"
        );
        conn.batch_execute(up).unwrap();
        assert_eq!(history(&mut conn), before);
        assert_eq!(
            group_membership::table
                .select(group_membership::mute_override)
                .load::<Option<bool>>(&mut conn)
                .unwrap(),
            vec![None; 4]
        );
        let loaded = user_extra::table
            .find(10)
            .select(UserExtra::as_select())
            .first::<UserExtra>(&mut conn)
            .unwrap();
        assert!(!loaded.mute_group_chats_by_default);
        assert!(!loaded.mute_direct_chats_by_default);
        assert_eq!(loaded.sticker_pack_order, user.sticker_pack_order);
        assert_eq!(loaded.verification_question, user.verification_question);

        diesel::update(user_extra::table.find(10))
            .set((
                user_extra::mute_group_chats_by_default.eq(true),
                user_extra::mute_direct_chats_by_default.eq(true),
            ))
            .execute(&mut conn)
            .unwrap();
        super::super::social::update_presence_settings(&mut conn, 10, PresenceVisibility::Friends)
            .unwrap();
        let loaded = user_extra::table
            .find(10)
            .select(UserExtra::as_select())
            .first::<UserExtra>(&mut conn)
            .unwrap();
        assert!(loaded.mute_group_chats_by_default && loaded.mute_direct_chats_by_default);
        assert_eq!(loaded.sticker_pack_order, user.sticker_pack_order);
        assert_eq!(loaded.verification_question, user.verification_question);

        let new_user = NewUserExtra { uid: 20, ..user };
        diesel::insert_into(user_extra::table)
            .values(new_user)
            .execute(&mut conn)
            .unwrap();
        let loaded = user_extra::table
            .find(20)
            .select(UserExtra::as_select())
            .first::<UserExtra>(&mut conn)
            .unwrap();
        assert!(!loaded.mute_group_chats_by_default && !loaded.mute_direct_chats_by_default);

        conn.batch_execute(down).unwrap();
        assert_eq!(history(&mut conn), before);
        assert_eq!(
            user_extra::table
                .find(10)
                .select(user_extra::verification_question)
                .first::<Option<String>>(&mut conn)
                .unwrap(),
            Some("question".into())
        );
        // Rolling forward after a rollback recreates only the removed preference fields.
        conn.batch_execute(up).unwrap();
        assert_eq!(history(&mut conn), before);
        let loaded = user_extra::table
            .find(10)
            .select(UserExtra::as_select())
            .first::<UserExtra>(&mut conn)
            .unwrap();
        assert!(!loaded.mute_group_chats_by_default && !loaded.mute_direct_chats_by_default);
    }

    #[test]
    fn database_reset_migration_resets_groups_and_preserves_only_unarchived_dm_permanent_mutes() {
        use crate::schema::user_extra;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute(
            "CREATE TEMP TABLE user_extra (
                uid INTEGER PRIMARY KEY,
                mute_group_chats_by_default BOOLEAN NOT NULL DEFAULT FALSE,
                mute_direct_chats_by_default BOOLEAN NOT NULL DEFAULT FALSE);
             CREATE TEMP TABLE groups (id BIGINT PRIMARY KEY, kind TEXT NOT NULL);
             CREATE TEMP TABLE group_membership (
                chat_id BIGINT, uid INTEGER, muted_until TIMESTAMPTZ,
                mute_override BOOLEAN, archived BOOLEAN NOT NULL DEFAULT FALSE,
                PRIMARY KEY (chat_id, uid));
             INSERT INTO user_extra VALUES (10,FALSE,FALSE),(20,FALSE,TRUE),(30,TRUE,TRUE);
             INSERT INTO groups VALUES (1,'group'),(2,'group'),(3,'group'),(4,'group'),(5,'group'),
                 (10,'dm'),(11,'dm'),(12,'dm'),(13,'dm'),(14,'dm');
             INSERT INTO group_membership VALUES
                (1,10,NULL,FALSE,FALSE),
                (1,20,'9999-12-31 23:59:59+00',TRUE,FALSE),
                (2,10,'2026-10-24 08:00:00+00',FALSE,FALSE),
                (3,10,'9999-12-31 23:59:59+00',TRUE,TRUE),
                (4,10,'2026-10-22 08:00:00+00',TRUE,FALSE),
                (5,10,NULL,NULL,FALSE),
                (10,10,'9999-12-31 23:59:59+00',NULL,FALSE),
                (10,20,NULL,NULL,FALSE),
                (11,10,'9999-12-31 23:59:59+00',TRUE,TRUE),
                (11,20,'9999-12-31 23:59:59+00',NULL,TRUE),
                (12,10,'2026-10-24 08:00:00+00',NULL,FALSE),
                (13,10,'2026-10-22 08:00:00+00',NULL,FALSE),
                (14,10,'2026-10-24 08:00:00+00',NULL,TRUE);",
        )
        .unwrap();
        conn.batch_execute(include_str!(
            "../../migrations/2026-10-23-092156-0000_reset_chat_notification_defaults/up.sql"
        ))
        .unwrap();
        // Inserts that omit settings and pre-existing users share the same defaults.
        diesel::insert_into(user_extra::table)
            .values(user_extra::uid.eq(40))
            .execute(&mut conn)
            .unwrap();
        assert_eq!(
            user_extra::table
                .order(user_extra::uid)
                .select((
                    user_extra::mute_group_chats_by_default,
                    user_extra::mute_direct_chats_by_default
                ))
                .load::<(bool, bool)>(&mut conn)
                .unwrap(),
            vec![(true, false); 4]
        );

        let rows = group_membership::table
            .order((group_membership::chat_id, group_membership::uid))
            .select((
                group_membership::chat_id,
                group_membership::uid,
                (
                    group_membership::muted_until,
                    group_membership::mute_override,
                ),
                group_membership::archived,
            ))
            .load::<(i64, i32, ChatNotificationSetting, bool)>(&mut conn)
            .unwrap();
        let inherited = ChatNotificationSetting {
            muted_until: None,
            mute_override: None,
        };
        let defaults = NotificationDefaults::default();
        assert_eq!(rows.len(), 13);
        for (chat_id, _, setting, archived) in &rows[..6] {
            assert_eq!(*setting, inherited);
            assert!(setting.is_muted(GroupKind::Group, defaults, now()));
            assert_eq!(*archived, *chat_id == 3);
        }
        assert_eq!(
            rows[6],
            (
                10,
                10,
                ChatNotificationSetting {
                    muted_until: Some(super::super::chat::indefinite_mute_until()),
                    mute_override: Some(true),
                },
                false
            )
        );
        assert_eq!(rows[7], (10, 20, inherited, false));
        assert_eq!(rows[8], (11, 10, inherited, true));
        assert_eq!(rows[9], (11, 20, inherited, true));
        for row in &rows[10..] {
            let expiry = if row.0 == 13 {
                now() - Duration::days(1)
            } else {
                now() + Duration::days(1)
            };
            assert_eq!(
                row.2,
                ChatNotificationSetting {
                    muted_until: Some(expiry),
                    mute_override: None
                }
            );
            assert_eq!(row.3, row.0 == 14);
            assert!(!row
                .2
                .is_muted(GroupKind::Dm, defaults, now() + Duration::days(1)));
        }

        assert!(rows[6].2.is_muted(GroupKind::Dm, defaults, now()));
        assert!(!rows[8].2.is_muted(GroupKind::Dm, defaults, now()));
        // Reject rollback instead of claiming that erased preferences can be reconstructed.
        let rollback_error = conn
            .batch_execute(include_str!(
                "../../migrations/2026-10-23-092156-0000_reset_chat_notification_defaults/down.sql"
            ))
            .unwrap_err();
        assert!(rollback_error.to_string().contains("reset is irreversible"));
        assert_eq!(
            group_membership::table
                .find((1_i64, 10_i32))
                .select((
                    group_membership::muted_until,
                    group_membership::mute_override
                ))
                .first::<ChatNotificationSetting>(&mut conn)
                .unwrap(),
            inherited
        );
    }
}
