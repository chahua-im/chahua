use super::*;
use crate::services::messages::{authorize_message_send, AuthorizedMessageTarget};
use diesel::connection::SimpleConnection;

const MODES: [SpeakingMode; 4] = [
    SpeakingMode::Unrestricted,
    SpeakingMode::ThreadsOnly,
    SpeakingMode::RepliesOnly,
    SpeakingMode::ReadOnly,
];

fn connection() -> Option<PgConnection> {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return None;
    };
    Some(PgConnection::establish(&url).expect("connect to test database"))
}

fn fixture() -> Option<PgConnection> {
    let mut conn = connection()?;
    // Session-local copies retain production defaults, enums and CHECK constraints.
    // No fixtures or changes escape into the shared test database.
    conn.batch_execute(
        "CREATE TEMP TABLE groups (LIKE public.groups INCLUDING ALL);
         CREATE TEMP TABLE group_membership (LIKE public.group_membership INCLUDING ALL);
         CREATE TEMP TABLE messages (LIKE public.messages INCLUDING ALL);
         INSERT INTO groups (id, name) VALUES (1, 'speaking'), (2, 'other');
         INSERT INTO groups (id, name, kind, dm_uid1, dm_uid2)
             VALUES (3, '', 'dm', 1, 2);
         INSERT INTO group_membership (chat_id, uid, role)
             VALUES (1, 1, 'admin'), (1, 2, 'member'), (1, 3, 'member'),
                    (1, 4, 'admin'), (3, 1, 'member'), (3, 2, 'member');
         INSERT INTO messages
             (id, chat_id, sender_uid, message_type, message, client_generated_id,
              created_at, has_thread, reply_root_id, is_published, deleted_at)
             VALUES
             (100, 1, 2, 'text', 'ordinary', 'speaking-100', NOW(), FALSE, NULL, TRUE, NULL),
             (101, 1, 2, 'text', 'root', 'speaking-101', NOW(), TRUE, NULL, TRUE, NULL),
             (102, 1, 2, 'text', 'reply', 'speaking-102', NOW(), FALSE, 101, TRUE, NULL),
             (103, 2, 2, 'text', 'other chat', 'speaking-103', NOW(), TRUE, NULL, TRUE, NULL),
             (104, 1, 2, 'file', NULL, 'speaking-104', NOW(), FALSE, NULL, TRUE, NULL),
             (105, 1, 2, 'text', 'deleted', 'speaking-105', NOW(), FALSE, NULL, TRUE, NOW()),
             (106, 1, 2, 'text', 'deleted root', 'speaking-106', NOW(), TRUE, NULL, TRUE, NOW()),
             (107, 1, 2, 'text', 'unpublished', 'speaking-107', NOW(), TRUE, NULL, FALSE, NULL);",
    )
    .unwrap();
    Some(conn)
}

fn send(
    conn: &mut PgConnection,
    thread_id: Option<i64>,
    uid: i32,
) -> Result<AuthorizedMessageTarget, AppError> {
    conn.transaction(|conn| authorize_message_send(conn, 1, thread_id, uid).map_err(AppError::from))
}

#[test]
fn all_mode_combinations_intersect_allowed_actions_and_exempt_admins() {
    let actions = [
        SpeakingAction::ChatMessage,
        SpeakingAction::CreateThread,
        SpeakingAction::ThreadReply,
    ];
    let expected = [
        [true, true, true],
        [false, true, true],
        [false, false, true],
        [false, false, false],
    ];
    for (group_index, group_mode) in MODES.into_iter().enumerate() {
        for (member_index, member_mode) in MODES.into_iter().enumerate() {
            for (action_index, action) in actions.into_iter().enumerate() {
                let effective = effective_mode(&GroupRole::Member, group_mode, member_mode);
                assert_eq!(
                    allows(effective, action),
                    expected[group_index][action_index] && expected[member_index][action_index]
                );
                assert!(allows(
                    effective_mode(&GroupRole::Admin, group_mode, member_mode),
                    action
                ));
            }
        }
    }
}

#[test]
fn database_send_authorization_covers_every_group_and_personal_mode() {
    let Some(mut conn) = fixture() else {
        return;
    };
    let expected = [
        [true, true, true],
        [false, true, true],
        [false, false, true],
        [false, false, false],
    ];
    for (group_index, group_mode) in MODES.into_iter().enumerate() {
        update_group_mode(&mut conn, 1, 1, group_mode).unwrap();
        for (member_index, member_mode) in MODES.into_iter().enumerate() {
            update_member_mode(&mut conn, 1, 1, 2, member_mode).unwrap();
            for (action_index, root) in [None, Some(100), Some(101)].into_iter().enumerate() {
                let result = send(&mut conn, root, 2);
                if expected[group_index][action_index] && expected[member_index][action_index] {
                    assert!(result.is_ok(), "{group_mode:?}, {member_mode:?}, {root:?}");
                } else {
                    assert!(
                        matches!(result, Err(AppError::SpeakingRestricted(mode)) if mode == group_mode.max(member_mode))
                    );
                }
                assert!(send(&mut conn, root, 1).is_ok());
            }
        }
    }
}

#[test]
fn database_existing_thread_checks_reject_invalid_roots() {
    let Some(mut conn) = fixture() else {
        return;
    };
    update_group_mode(&mut conn, 1, 1, SpeakingMode::RepliesOnly).unwrap();
    assert!(matches!(
        send(&mut conn, Some(100), 2),
        Err(AppError::SpeakingRestricted(_))
    ));
    for root in [102, 103, 105, 107, 999] {
        assert!(matches!(
            send(&mut conn, Some(root), 2),
            Err(AppError::NotFound(_))
        ));
    }
    assert!(matches!(
        send(&mut conn, Some(104), 2),
        Err(AppError::BadRequest(_))
    ));
    // A deleted root still anchors its surviving thread.
    assert!(send(&mut conn, Some(106), 2).is_ok());
    // "Existing" is evaluated at send time, not when the restriction was set.
    diesel::update(crate::schema::messages::table.find(100))
        .set(crate::schema::messages::has_thread.eq(true))
        .execute(&mut conn)
        .unwrap();
    assert!(send(&mut conn, Some(100), 2).is_ok());
    assert!(matches!(
        send(&mut conn, None, 999),
        Err(AppError::Forbidden(_))
    ));
}

#[test]
fn database_edit_permissions_follow_message_location() {
    let Some(mut conn) = fixture() else {
        return;
    };
    let messages = crate::schema::messages::table
        .filter(crate::schema::messages::id.eq_any([100_i64, 101, 102]))
        .order(crate::schema::messages::id)
        .select(Message::as_select())
        .load::<Message>(&mut conn)
        .unwrap();
    let expected = [
        [true, true, true],
        [false, false, true],
        [false, false, true],
        [false, false, false],
    ];
    for (mode_index, mode) in MODES.into_iter().enumerate() {
        update_member_mode(&mut conn, 1, 1, 2, mode).unwrap();
        for (message_index, message) in messages.iter().enumerate() {
            let result = conn.transaction::<_, AppError, _>(|conn| {
                lock_chat(conn, 1, false)?;
                require_edit(conn, message, 2)
            });
            assert_eq!(result.is_ok(), expected[mode_index][message_index]);
            assert!(require_edit(&mut conn, message, 1).is_ok());
        }
    }
    assert!(matches!(
        require_edit(&mut conn, &messages[0], 999),
        Err(AppError::Forbidden(_))
    ));
}

#[test]
fn database_admin_controls_promotion_demotion_and_membership_reset() {
    let Some(mut conn) = fixture() else {
        return;
    };
    assert!(matches!(
        update_group_mode(&mut conn, 1, 2, SpeakingMode::ReadOnly),
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        update_group_mode(&mut conn, 1, 999, SpeakingMode::ReadOnly),
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        update_member_mode(&mut conn, 1, 2, 3, SpeakingMode::ReadOnly),
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        update_member_mode(&mut conn, 1, 1, 999, SpeakingMode::ReadOnly),
        Err(AppError::NotFound(_))
    ));
    for admin in [1, 4] {
        for mode in MODES {
            assert!(matches!(
                update_member_mode(&mut conn, 1, 1, admin, mode),
                Err(AppError::BadRequest(_))
            ));
        }
    }
    assert!(matches!(
        update_member_role(&mut conn, 1, 1, 1, GroupRole::Member),
        Err(AppError::BadRequest(_))
    ));
    update_group_mode(&mut conn, 1, 1, SpeakingMode::ThreadsOnly).unwrap();
    update_member_mode(&mut conn, 1, 1, 2, SpeakingMode::ReadOnly).unwrap();
    let promoted = update_member_role(&mut conn, 1, 1, 2, GroupRole::Admin).unwrap();
    assert_eq!(promoted.speaking_mode, SpeakingMode::Unrestricted);
    assert_eq!(
        effective_mode(
            &promoted.role,
            SpeakingMode::ThreadsOnly,
            promoted.speaking_mode
        ),
        SpeakingMode::Unrestricted
    );
    assert!(send(&mut conn, None, 2).is_ok());
    let demoted = update_member_role(&mut conn, 1, 1, 2, GroupRole::Member).unwrap();
    assert_eq!(demoted.speaking_mode, SpeakingMode::Unrestricted);
    assert_eq!(
        effective_mode(
            &demoted.role,
            SpeakingMode::ThreadsOnly,
            demoted.speaking_mode
        ),
        SpeakingMode::ThreadsOnly
    );
    update_member_mode(&mut conn, 1, 1, 2, SpeakingMode::ReadOnly).unwrap();
    diesel::delete(gm::table.find((1_i64, 2_i32)))
        .execute(&mut conn)
        .unwrap();
    conn.batch_execute("INSERT INTO group_membership (chat_id, uid) VALUES (1, 2)")
        .unwrap();
    assert!(send(&mut conn, Some(100), 2).is_ok());
    assert!(matches!(
        send(&mut conn, None, 2),
        Err(AppError::SpeakingRestricted(SpeakingMode::ThreadsOnly))
    ));
    // Another member's state is unaffected, and the setters are idempotent.
    for _ in 0..2 {
        let state = update_member_mode(&mut conn, 1, 1, 2, SpeakingMode::RepliesOnly).unwrap();
        assert_eq!(state.effective_speaking_mode, SpeakingMode::RepliesOnly);
        assert!(send(&mut conn, Some(100), 3).is_ok());
    }
}

#[test]
fn database_constraints_and_dm_exclusion() {
    let Some(mut conn) = fixture() else {
        return;
    };
    assert!(matches!(
        update_group_mode(&mut conn, 3, 1, SpeakingMode::ReadOnly),
        Err(AppError::BadRequest(_))
    ));
    assert!(matches!(
        update_member_mode(&mut conn, 3, 1, 2, SpeakingMode::ReadOnly),
        Err(AppError::BadRequest(_))
    ));
    let mut message = crate::schema::messages::table
        .find(100_i64)
        .select(Message::as_select())
        .first::<Message>(&mut conn)
        .unwrap();
    message.chat_id = 3;
    assert!(require_edit(&mut conn, &message, 1).is_ok());
    // Database constraints protect invariants even from direct SQL writers.
    assert!(diesel::update(gm::table.find((1_i64, 1_i32)))
        .set(gm::speaking_mode.eq(SpeakingMode::ReadOnly))
        .execute(&mut conn)
        .is_err());
    assert!(diesel::update(groups::table.find(3_i64))
        .set(groups::speaking_mode.eq(SpeakingMode::ReadOnly))
        .execute(&mut conn)
        .is_err());
}

#[test]
fn database_moderation_lock_waits_for_sends_and_blocks_new_sends() {
    let Some(mut sender) = connection() else {
        return;
    };
    let mut moderator = connection().unwrap();
    let chat_id = 8_765_432_100_i64;
    sender
        .batch_execute("BEGIN; SET LOCAL lock_timeout = '150ms'")
        .unwrap();
    moderator
        .batch_execute("BEGIN; SET LOCAL lock_timeout = '150ms'")
        .unwrap();
    lock_chat(&mut sender, chat_id, false).unwrap();
    // Multiple sends do not serialize on the moderation lock.
    lock_chat(&mut moderator, chat_id, false).unwrap();
    moderator
        .batch_execute("ROLLBACK; BEGIN; SET LOCAL lock_timeout = '150ms'")
        .unwrap();
    assert!(lock_chat(&mut moderator, chat_id, true).is_err());
    moderator.batch_execute("ROLLBACK").unwrap();
    sender.batch_execute("COMMIT").unwrap();
    moderator.batch_execute("BEGIN").unwrap();
    lock_chat(&mut moderator, chat_id, true).unwrap();
    sender
        .batch_execute("BEGIN; SET LOCAL lock_timeout = '150ms'")
        .unwrap();
    assert!(lock_chat(&mut sender, chat_id, false).is_err());
    sender.batch_execute("ROLLBACK").unwrap();
    moderator.batch_execute("COMMIT").unwrap();
    sender
        .transaction::<_, AppError, _>(|conn| {
            lock_chat(conn, chat_id, false)?;
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn restriction_errors_have_a_stable_json_contract() {
    use axum::response::IntoResponse;
    let response = AppError::SpeakingRestricted(SpeakingMode::RepliesOnly).into_response();
    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        serde_json::json!({
            "code": "speakingRestricted", "effectiveSpeakingMode": "repliesOnly"
        })
    );
}

#[tokio::test]
async fn database_broadcasts_reach_members_or_only_the_target_and_admins() {
    use crate::services::ws_registry::WsMetrics;
    let Some(mut conn) = fixture() else {
        return;
    };
    let registry = ConnectionRegistry::new(std::sync::Arc::new(WsMetrics::new(
        &prometheus::Registry::new(),
    )));
    let mut receivers = Vec::new();
    // Admin, affected user on two devices, ordinary member, other admin, outsider.
    for uid in [1, 2, 2, 3, 4, 999] {
        let (_, receiver) = registry.register(uid, format!("device-{}", receivers.len()));
        receivers.push(receiver);
    }
    for receiver in &mut receivers {
        while receiver.try_recv().is_ok() {}
    }
    update_member_mode(&mut conn, 1, 1, 2, SpeakingMode::ReadOnly).unwrap();
    broadcast_member_mode(&mut conn, &registry, 1, 2).unwrap();
    for (index, receiver) in receivers.iter_mut().enumerate() {
        if [0, 1, 2, 4].contains(&index) {
            let event = receiver.try_recv().unwrap();
            let value = serde_json::to_value(&*event).unwrap();
            assert_eq!(value["type"], "memberSpeakingModeChanged");
            assert_eq!(value["payload"]["speakingMode"], "readOnly");
            assert_eq!(value["payload"]["effectiveSpeakingMode"], "readOnly");
            assert_eq!(value["payload"]["chatId"], "1");
        } else {
            assert!(receiver.try_recv().is_err());
        }
    }
    update_group_mode(&mut conn, 1, 1, SpeakingMode::ThreadsOnly).unwrap();
    broadcast_group_mode(&mut conn, &registry, 1).unwrap();
    for (index, receiver) in receivers.iter_mut().enumerate() {
        if index == 5 {
            assert!(receiver.try_recv().is_err());
        } else {
            assert!(
                matches!(&*receiver.try_recv().unwrap(), ServerWsMessage::GroupSpeakingModeChanged(state) if state.speaking_mode == SpeakingMode::ThreadsOnly)
            );
        }
    }
}

#[tokio::test]
async fn database_delayed_broadcasts_reload_group_member_and_role_state() {
    use crate::services::ws_registry::WsMetrics;
    let Some(mut conn) = fixture() else { return };
    let registry = ConnectionRegistry::new(std::sync::Arc::new(WsMetrics::new(
        &prometheus::Registry::new(),
    )));
    let (_, mut receiver) = registry.register(2, "speaking-order".into());
    while receiver.try_recv().is_ok() {}

    // A commits first, B commits and broadcasts, then A's delayed broadcast runs.
    update_group_mode(&mut conn, 1, 1, SpeakingMode::ReadOnly).unwrap();
    update_group_mode(&mut conn, 1, 4, SpeakingMode::Unrestricted).unwrap();
    for _ in 0..2 {
        broadcast_group_mode(&mut conn, &registry, 1).unwrap();
        assert!(matches!(&*receiver.try_recv().unwrap(),
            ServerWsMessage::GroupSpeakingModeChanged(state)
                if state.speaking_mode == SpeakingMode::Unrestricted));
    }

    update_member_mode(&mut conn, 1, 1, 2, SpeakingMode::ReadOnly).unwrap();
    update_member_mode(&mut conn, 1, 4, 2, SpeakingMode::RepliesOnly).unwrap();
    update_group_mode(&mut conn, 1, 4, SpeakingMode::ThreadsOnly).unwrap();
    for _ in 0..2 {
        broadcast_member_mode(&mut conn, &registry, 1, 2).unwrap();
        assert!(matches!(&*receiver.try_recv().unwrap(),
            ServerWsMessage::MemberSpeakingModeChanged(state)
                if state.speaking_mode == SpeakingMode::RepliesOnly
                    && state.group_speaking_mode == SpeakingMode::ThreadsOnly
                    && state.effective_speaking_mode == SpeakingMode::RepliesOnly));
    }

    // Promotion overtakes an outstanding personal-restriction broadcast.
    update_member_role(&mut conn, 1, 1, 2, GroupRole::Admin).unwrap();
    broadcast_member_mode(&mut conn, &registry, 1, 2).unwrap();
    assert!(matches!(&*receiver.try_recv().unwrap(),
        ServerWsMessage::MemberSpeakingModeChanged(state)
            if state.role == GroupRole::Admin
                && state.effective_speaking_mode == SpeakingMode::Unrestricted));

    conn.transaction::<_, AppError, _>(|conn| {
        lock_chat(conn, 1, true)?;
        diesel::delete(gm::table.find((1_i64, 2_i32))).execute(conn)?;
        Ok(())
    })
    .unwrap();
    broadcast_member_mode(&mut conn, &registry, 1, 2).unwrap();
    assert!(receiver.try_recv().is_err());
}
