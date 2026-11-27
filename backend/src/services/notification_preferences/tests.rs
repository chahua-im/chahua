use super::*;
use diesel::connection::SimpleConnection;

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-10-23T08:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

#[test]
fn new_and_missing_accounts_notify_both_chat_kinds() {
    let defaults = NotificationDefaults::default();
    assert!(!defaults.group_chats_muted);
    assert!(!defaults.direct_chats_muted);
    let inherited = ChatNotificationSetting {
        muted_until: None,
        mute_override: None,
    };
    assert!(!inherited.is_muted(GroupKind::Group, defaults, now()));
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
            update_chat_notification_setting(&mut conn, 1, 10, override_command, now()).unwrap();
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
            fallback.mute_override.unwrap_or(false)
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
    use crate::models::{FriendAddVerificationMode, NewUserExtra, PresenceVisibility, UserExtra};
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
        "../../../migrations/2026-10-23-090458-0000_add_notification_preferences/up.sql"
    );
    let down = include_str!(
        "../../../migrations/2026-10-23-090458-0000_add_notification_preferences/down.sql"
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
fn database_migration_backfills_permanent_mutes_without_resetting_account_defaults() {
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
             INSERT INTO user_extra VALUES (10,FALSE,FALSE),(20,FALSE,TRUE),
                 (30,TRUE,TRUE),(40,TRUE,FALSE);
             INSERT INTO groups VALUES (1,'group'),(2,'dm');
             INSERT INTO group_membership
             SELECT g.id, (row_number() OVER (PARTITION BY g.id))::INTEGER,
                 setting.muted_until, setting.mute_override, archive.archived
             FROM groups g
             CROSS JOIN (VALUES (FALSE),(TRUE)) archive(archived)
             CROSS JOIN (VALUES
                 (NULL::TIMESTAMPTZ,NULL::BOOLEAN),
                 (NULL::TIMESTAMPTZ,FALSE),
                 (NULL::TIMESTAMPTZ,TRUE),
                 ('9999-12-31 23:59:59+00'::TIMESTAMPTZ,NULL::BOOLEAN),
                 ('9999-12-31 23:59:59+00'::TIMESTAMPTZ,FALSE),
                 ('9999-12-31 23:59:59+00'::TIMESTAMPTZ,TRUE),
                 ('2026-10-24 08:00:00+00'::TIMESTAMPTZ,NULL::BOOLEAN),
                 ('2026-10-24 08:00:00+00'::TIMESTAMPTZ,FALSE),
                 ('2026-10-24 08:00:00+00'::TIMESTAMPTZ,TRUE),
                 ('2026-10-22 08:00:00+00'::TIMESTAMPTZ,NULL::BOOLEAN)
             ) setting(muted_until,mute_override);",
    )
    .unwrap();
    let memberships = |conn: &mut PgConnection| {
        group_membership::table
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
            .load::<(i64, i32, ChatNotificationSetting, bool)>(conn)
            .unwrap()
    };
    let before = memberships(&mut conn);
    let up = include_str!(
        "../../../migrations/2026-10-23-161420-0000_preserve_chat_notification_mutes/up.sql"
    );
    conn.batch_execute(up).unwrap();
    // Preserve existing account choices; the first migration already made
    // inserts that omit preferences notify by default for both chat kinds.
    diesel::insert_into(user_extra::table)
        .values(user_extra::uid.eq(50))
        .execute(&mut conn)
        .unwrap();
    assert_eq!(
        user_extra::table
            .order(user_extra::uid)
            .select((
                user_extra::mute_group_chats_by_default,
                user_extra::mute_direct_chats_by_default,
            ))
            .load::<(bool, bool)>(&mut conn)
            .unwrap(),
        vec![
            (false, false),
            (false, true),
            (true, true),
            (true, false),
            (false, false)
        ]
    );
    let mut expected = before;
    for (_, _, setting, _) in &mut expected {
        if setting.muted_until == Some(super::super::chat::indefinite_mute_until()) {
            setting.mute_override = Some(true);
        }
    }
    assert_eq!(expected.len(), 40);
    assert_eq!(memberships(&mut conn), expected);
    for (chat_id, _, setting, _) in &expected {
        let kind = if *chat_id == 1 {
            GroupKind::Group
        } else {
            GroupKind::Dm
        };
        assert_eq!(
            setting.is_muted(
                kind,
                NotificationDefaults::default(),
                now() + Duration::days(1)
            ),
            setting.mute_override == Some(true)
        );
    }
    conn.batch_execute(up).unwrap();
    assert_eq!(memberships(&mut conn), expected);

    let rollback_error = conn
        .batch_execute(include_str!(
            "../../../migrations/2026-10-23-161420-0000_preserve_chat_notification_mutes/down.sql"
        ))
        .unwrap_err();
    assert!(rollback_error
        .to_string()
        .contains("backfill is irreversible"));
    assert_eq!(memberships(&mut conn), expected);
}
