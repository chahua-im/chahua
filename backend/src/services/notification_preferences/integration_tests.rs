use super::*;
use diesel::connection::SimpleConnection;

fn connection() -> Option<PgConnection> {
    let url = std::env::var("WETTY_TEST_DATABASE_URL").ok()?;
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute("
        CREATE TEMP TABLE user_extra (LIKE public.user_extra INCLUDING ALL);
        CREATE TEMP TABLE groups (id BIGINT PRIMARY KEY, name TEXT NOT NULL, kind group_kind NOT NULL,
            avatar_image_id BIGINT, dm_uid1 INTEGER, dm_uid2 INTEGER);
        CREATE TEMP TABLE media (id BIGINT PRIMARY KEY, storage_key TEXT, deleted_at TIMESTAMPTZ);
        CREATE TEMP TABLE group_membership (chat_id BIGINT, uid INTEGER, archived BOOLEAN NOT NULL DEFAULT FALSE,
            muted_until TIMESTAMPTZ, mute_override BOOLEAN, last_read_message_id BIGINT, PRIMARY KEY(chat_id, uid));
        CREATE TEMP TABLE messages (id BIGINT PRIMARY KEY, chat_id BIGINT, reply_root_id BIGINT,
            deleted_at TIMESTAMPTZ, is_published BOOLEAN DEFAULT TRUE, has_thread BOOLEAN DEFAULT FALSE);
        CREATE TEMP TABLE thread_user_states (chat_id BIGINT, uid INTEGER, thread_root_id BIGINT,
            subscribed BOOLEAN, archived BOOLEAN, last_read_message_id BIGINT);
        CREATE TEMP TABLE message_mentions (chat_id BIGINT, mentioned_uid INTEGER, message_id BIGINT, thread_root_id BIGINT);
        INSERT INTO groups (id,name,kind) VALUES (1,'one','group'),(2,'two','group'),(3,'three','group'),(4,'four','dm'),(5,'five','group');
        INSERT INTO group_membership (chat_id,uid,archived,mute_override) VALUES
            (1,7,FALSE,NULL),(2,7,FALSE,FALSE),(3,7,TRUE,TRUE),(4,7,FALSE,NULL),(5,8,FALSE,TRUE);
        INSERT INTO messages (id,chat_id) VALUES (10,1),(20,2),(30,3),(40,4);
    ").unwrap();
    Some(conn)
}

#[test]
fn defaults_patches_preserve_omitted_categories_and_other_user_settings() {
    let Some(mut conn) = connection() else {
        return;
    };
    assert_eq!(
        load_notification_defaults(&mut conn, 7).unwrap(),
        NotificationDefaults::default()
    );
    let patch = UpdateNotificationSettingsRequest {
        mute_group_chats_by_default: Some(false),
        mute_direct_chats_by_default: None,
    };
    assert_eq!(
        update_notification_defaults(&mut conn, 7, &patch).unwrap(),
        NotificationDefaults {
            group_chats_muted: false,
            direct_chats_muted: false
        }
    );
    diesel::update(user_extra::table.find(7))
        .set((
            user_extra::verification_question.eq("keep"),
            user_extra::verification_mode.eq(FriendAddVerificationMode::Question),
        ))
        .execute(&mut conn)
        .unwrap();
    let patch = UpdateNotificationSettingsRequest {
        mute_group_chats_by_default: None,
        mute_direct_chats_by_default: Some(true),
    };
    assert_eq!(
        update_notification_defaults(&mut conn, 7, &patch).unwrap(),
        NotificationDefaults {
            group_chats_muted: false,
            direct_chats_muted: true
        }
    );
    assert_eq!(
        user_extra::table
            .find(7)
            .select(user_extra::verification_question)
            .first::<Option<String>>(&mut conn)
            .unwrap()
            .as_deref(),
        Some("keep")
    );
    let patch = UpdateNotificationSettingsRequest {
        mute_group_chats_by_default: None,
        mute_direct_chats_by_default: None,
    };
    assert!(matches!(
        update_notification_defaults(&mut conn, 7, &patch),
        Err(AppError::BadRequest(_))
    ));
    let batch = load_notification_defaults_for_users(&mut conn, &[7, 8]).unwrap();
    assert_eq!(
        batch[&7],
        NotificationDefaults {
            group_chats_muted: false,
            direct_chats_muted: true
        }
    );
    assert!(!batch.contains_key(&8));
}

#[test]
fn exception_pages_include_archived_rows_and_count_the_whole_category() {
    let Some(mut conn) = connection() else {
        return;
    };
    let first = list_notification_exceptions(&mut conn, 7, GroupKind::Group, None, 1).unwrap();
    assert_eq!(first.total_count, 2);
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.rows[0].chat_id, 2);
    assert_eq!(first.rows[0].setting.mute_override, Some(false));
    let second =
        list_notification_exceptions(&mut conn, 7, GroupKind::Group, first.next_cursor, 1).unwrap();
    assert_eq!(second.total_count, 2);
    assert_eq!(second.rows[0].chat_id, 3);
    assert!(second.rows[0].archived);
    assert_eq!(second.next_cursor, None);
    let empty = list_notification_exceptions(&mut conn, 7, GroupKind::Group, Some(100), 1).unwrap();
    assert!(empty.rows.is_empty());
    assert_eq!(empty.total_count, 2);
    let dm = list_notification_exceptions(&mut conn, 7, GroupKind::Dm, None, 100).unwrap();
    assert!(dm.rows.is_empty());
    assert_eq!(dm.total_count, 0);
    update_chat_notification_setting(
        &mut conn,
        4,
        7,
        ChatNotificationCommand::AlwaysMuted,
        Utc::now(),
    )
    .unwrap();
    assert_eq!(
        list_notification_exceptions(&mut conn, 7, GroupKind::Dm, None, 100)
            .unwrap()
            .total_count,
        1
    );
    assert_eq!(
        list_notification_exceptions(&mut conn, 8, GroupKind::Group, None, 100)
            .unwrap()
            .rows[0]
            .chat_id,
        5
    );
}

#[test]
fn archive_preserves_notification_preferences_and_legacy_unmute_still_clears_both() {
    let Some(mut conn) = connection() else {
        return;
    };
    let now = DateTime::from_timestamp(Utc::now().timestamp(), 0).unwrap();
    update_chat_notification_setting(
        &mut conn,
        2,
        7,
        ChatNotificationCommand::TemporarilyMuted {
            duration_seconds: 60,
        },
        now,
    )
    .unwrap();
    for archived in [true, false] {
        set_chat_archived(&mut conn, 2, 7, archived).unwrap();
        let saved = load_chat_notification_setting(&mut conn, 2, 7).unwrap();
        assert_eq!(saved.archived, archived);
        assert_eq!(saved.mute_override, Some(false));
        assert_eq!(saved.muted_until, Some(now + Duration::seconds(60)));
        assert!(saved.is_muted);
    }
    update_chat_notification_setting(&mut conn, 3, 7, ChatNotificationCommand::AlwaysUnmuted, now)
        .unwrap();
    assert!(
        load_chat_notification_setting(&mut conn, 3, 7)
            .unwrap()
            .archived
    );
    update_chat_notification_setting(
        &mut conn,
        3,
        7,
        ChatNotificationCommand::LegacyUnmuteAndUnarchive,
        now,
    )
    .unwrap();
    let saved = load_chat_notification_setting(&mut conn, 3, 7).unwrap();
    assert!(!saved.archived && !saved.is_muted);
    assert_eq!(saved.muted_until, None);
    assert_eq!(saved.mute_override, Some(false));
    assert!(load_chat_notification_setting(&mut conn, 5, 7).is_err());
}

#[test]
fn account_badges_and_collection_summaries_share_defaults_overrides_and_expiry() {
    use crate::dto::conversations::{ConversationCategory, ConversationSelector, ConversationView};
    let Some(mut conn) = connection() else {
        return;
    };
    let unread = crate::services::unread::UnreadService::new();
    let views = vec![ConversationView {
        key: "all".into(),
        selector: ConversationSelector {
            categories: vec![ConversationCategory::Group, ConversationCategory::Dm],
            ..Default::default()
        },
    }];
    let check = |conn: &mut PgConnection, expected| {
        let account = unread.count_user_unread_summary(conn, 7).unwrap();
        assert_eq!(account.unread_count, expected);
        assert_eq!(account.archived_unread_count, 1);
        assert_eq!(
            unread.count_users_unread_totals(conn, &[7, 8]).unwrap()[&7],
            expected
        );
        let collection = unread.conversation_summaries(conn, 7, &views).unwrap();
        assert_eq!(collection[0].unread_message_count, 3);
        assert_eq!(collection[0].unread_unmuted_message_count, expected);
        assert_eq!(collection[0].unread_unmuted_conversation_count, expected);
    };
    check(&mut conn, 2); // Default-muted group, explicit-notify group, ordinary DM.
    update_notification_defaults(
        &mut conn,
        7,
        &UpdateNotificationSettingsRequest {
            mute_group_chats_by_default: Some(false),
            mute_direct_chats_by_default: Some(true),
        },
    )
    .unwrap();
    check(&mut conn, 2); // Both groups notify, default-muted DM.
    update_chat_notification_setting(
        &mut conn,
        2,
        7,
        ChatNotificationCommand::TemporarilyMuted {
            duration_seconds: 60,
        },
        Utc::now(),
    )
    .unwrap();
    check(&mut conn, 1);
    diesel::update(group_membership::table.find((2_i64, 7_i32)))
        .set(group_membership::muted_until.eq(Utc::now() - Duration::seconds(1)))
        .execute(&mut conn)
        .unwrap();
    check(&mut conn, 2); // Expiry restores the explicit-notify fallback without marking read.
    update_chat_notification_setting(
        &mut conn,
        4,
        7,
        ChatNotificationCommand::AlwaysUnmuted,
        Utc::now(),
    )
    .unwrap();
    check(&mut conn, 3);
}

#[test]
fn simultaneous_default_patches_do_not_overwrite_other_categories() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    let uid = 1_900_023_007;
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        for patch in [
            UpdateNotificationSettingsRequest {
                mute_group_chats_by_default: Some(false),
                mute_direct_chats_by_default: None,
            },
            UpdateNotificationSettingsRequest {
                mute_group_chats_by_default: None,
                mute_direct_chats_by_default: Some(true),
            },
        ] {
            let url = &url;
            let barrier = &barrier;
            scope.spawn(move || {
                let mut conn = PgConnection::establish(url).unwrap();
                barrier.wait();
                update_notification_defaults(&mut conn, uid, &patch).unwrap();
            });
        }
    });
    let saved = load_notification_defaults(&mut conn, uid).unwrap();
    diesel::delete(user_extra::table.find(uid))
        .execute(&mut conn)
        .unwrap();
    assert_eq!(
        saved,
        NotificationDefaults {
            group_chats_muted: false,
            direct_chats_muted: true
        }
    );
}

#[test]
fn clearing_exceptions_is_scoped_and_preserves_archive_and_inherited_temporary_mutes() {
    let Some(mut conn) = connection() else {
        return;
    };
    conn.batch_execute(
        "UPDATE group_membership SET muted_until = NOW() + INTERVAL '1 day' WHERE uid = 7;
        UPDATE group_membership SET mute_override = TRUE WHERE uid = 7 AND chat_id = 4;",
    )
    .unwrap();
    let mut cleared = clear_notification_exceptions(&mut conn, 7, GroupKind::Group).unwrap();
    cleared.sort();
    assert_eq!(cleared, vec![2, 3]);
    let archived = load_chat_notification_setting(&mut conn, 3, 7).unwrap();
    assert!(archived.archived);
    assert_eq!(archived.mute_override, None);
    assert_eq!(archived.muted_until, None);
    assert!(archived.is_muted); // inherits group default
    assert!(load_chat_notification_setting(&mut conn, 1, 7)
        .unwrap()
        .muted_until
        .is_some());
    assert_eq!(
        load_chat_notification_setting(&mut conn, 4, 7)
            .unwrap()
            .mute_override,
        Some(true)
    );
    assert_eq!(
        load_chat_notification_setting(&mut conn, 5, 8)
            .unwrap()
            .mute_override,
        Some(true)
    );
    assert!(
        clear_notification_exceptions(&mut conn, 7, GroupKind::Group)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        clear_notification_exceptions(&mut conn, 7, GroupKind::Dm).unwrap(),
        vec![4]
    );
    assert!(
        !load_chat_notification_setting(&mut conn, 4, 7)
            .unwrap()
            .is_muted
    );
}
