use super::{counted_failure_persistence_action, CountedFailurePersistenceAction};

#[test]
fn delivery_changes_only_require_a_connection_for_persistence() {
    use super::*;
    use crate::services::push::delivery::DeliveryFailureClass;

    let metrics = super::super::metrics::PushMetrics::new(&prometheus::Registry::new());
    let success = DeliveryAttemptResult::Success {
        subscription_id: 1,
        should_reset_failure_state: false,
    };
    let ignored_failure = DeliveryAttemptResult::Failure {
        failure: DeliveryFailure {
            subscription_id: 2,
            user_id: 7,
            provider: PushProvider::WebPush,
            class: DeliveryFailureClass::BackendConfig,
            reason: "config".into(),
            action: DeliveryFailureAction::None,
        },
        next_failure_count: 1,
    };
    assert!(collect_delivery_changes(&metrics, vec![success, ignored_failure]).is_empty());
    assert!(!collect_delivery_changes(
        &metrics,
        vec![DeliveryAttemptResult::Success {
            subscription_id: 1,
            should_reset_failure_state: true,
        }],
    )
    .is_empty());
}

#[test]
fn database_delivery_cleanup_resets_records_and_prunes() {
    use super::*;
    use crate::services::push::delivery::DeliveryFailureClass;
    use diesel::connection::SimpleConnection;

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute(
            "CREATE TEMP TABLE push_subscriptions (id BIGINT PRIMARY KEY, delivery_failure_count INTEGER NOT NULL, last_delivery_error TEXT, last_delivery_error_at TIMESTAMPTZ);
             INSERT INTO push_subscriptions VALUES (1, 2, 'old', now()), (2, 0, NULL, NULL), (3, 2, 'old', now()), (4, 0, NULL, NULL);",
        ).unwrap();
    let failure = |id, action| DeliveryFailure {
        subscription_id: id,
        user_id: 7,
        provider: PushProvider::WebPush,
        class: DeliveryFailureClass::ProviderRejected,
        reason: "rejected".into(),
        action,
    };
    let metrics = super::super::metrics::PushMetrics::new(&prometheus::Registry::new());
    let changes = collect_delivery_changes(
        &metrics,
        vec![
            DeliveryAttemptResult::Success {
                subscription_id: 1,
                should_reset_failure_state: true,
            },
            DeliveryAttemptResult::Failure {
                failure: failure(2, DeliveryFailureAction::Counted),
                next_failure_count: 1,
            },
            DeliveryAttemptResult::Failure {
                failure: failure(3, DeliveryFailureAction::Counted),
                next_failure_count: 3,
            },
            DeliveryAttemptResult::Failure {
                failure: failure(4, DeliveryFailureAction::PruneImmediate),
                next_failure_count: 1,
            },
        ],
    );
    apply_delivery_changes(&mut conn, changes).unwrap();
    let rows = push_subscriptions::table
        .select((
            push_subscriptions::id,
            push_subscriptions::delivery_failure_count,
            push_subscriptions::last_delivery_error,
            push_subscriptions::last_delivery_error_at,
        ))
        .order(push_subscriptions::id)
        .load::<(
            i64,
            i32,
            Option<String>,
            Option<chrono::DateTime<chrono::Utc>>,
        )>(&mut conn)
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], (1, 0, None, None));
    assert_eq!(
        (rows[1].0, rows[1].1, rows[1].2.as_deref()),
        (2, 1, Some("rejected"))
    );
    assert!(rows[1].3.is_some());
}

#[test]
fn database_push_candidates_keep_preferences_and_thread_membership_boundaries() {
    use super::*;
    use diesel::connection::SimpleConnection;
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute("
            CREATE TEMP TABLE group_membership (chat_id BIGINT, uid INTEGER, muted_until TIMESTAMPTZ, mute_override BOOLEAN, archived BOOLEAN);
            CREATE TEMP TABLE thread_user_states (chat_id BIGINT, uid INTEGER, thread_root_id BIGINT, subscribed BOOLEAN, archived BOOLEAN);
            INSERT INTO group_membership VALUES (1,7,NULL,NULL,FALSE),(1,8,NULL,FALSE,FALSE),(1,9,NULL,TRUE,TRUE),(2,10,NULL,FALSE,FALSE);
            INSERT INTO thread_user_states VALUES (1,7,100,TRUE,FALSE),(1,8,100,FALSE,FALSE);
        ").unwrap();
    let mut job = PushJob {
        chat_id: 1,
        sender_uid: 1,
        sender_username: "sender".into(),
        chat_name: "group".into(),
        message_preview: crate::services::push::PushMessagePreview {
            message: None,
            message_type: crate::models::MessageType::Text,
            sticker: None,
            attachments: vec![],
            is_deleted: false,
        },
        body_preview: None,
        message_id: 101,
        thread_root_id: None,
        mentioned_uids: vec![8, 10],
        reply_target_uid: None,
    };
    let candidates = load_recipient_candidates(&mut conn, &job).unwrap();
    assert_eq!(candidates.len(), 3);
    let settings = candidates
        .iter()
        .map(|c| (c.uid, c.notification_setting.mute_override))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(settings[&7], None);
    assert_eq!(settings[&8], Some(false));
    assert_eq!(settings[&9], Some(true));
    job.thread_root_id = Some(100);
    let candidates = load_recipient_candidates(&mut conn, &job).unwrap();
    assert_eq!(candidates.len(), 2);
    assert_eq!(
        candidates.iter().find(|c| c.uid == 7).unwrap().thread_state,
        ThreadPushState::ActiveSubscription
    );
    assert_eq!(
        candidates.iter().find(|c| c.uid == 8).unwrap().thread_state,
        ThreadPushState::NoSubscription
    );
    assert!(candidates.iter().all(|c| c.uid != 10));
}

#[test]
fn first_counted_delivery_failure_is_recorded() {
    assert_eq!(
        counted_failure_persistence_action(1),
        CountedFailurePersistenceAction::Record
    );
}

#[test]
fn second_counted_delivery_failure_is_recorded() {
    assert_eq!(
        counted_failure_persistence_action(2),
        CountedFailurePersistenceAction::Record
    );
}

#[test]
fn third_counted_delivery_failure_prunes_subscription() {
    assert_eq!(
        counted_failure_persistence_action(3),
        CountedFailurePersistenceAction::Prune
    );
}
