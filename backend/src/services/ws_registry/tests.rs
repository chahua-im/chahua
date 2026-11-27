use super::*;

fn registry() -> ConnectionRegistry {
    ConnectionRegistry::new(Arc::new(WsMetrics::new(&prometheus::Registry::new())))
}

#[tokio::test]
async fn sync_connections_wake_without_legacy_message_frames_and_close_on_removal() {
    let registry = registry();
    let (_legacy, mut legacy_rx) = registry.register(7, "legacy".into());
    let (sync, mut sync_rx) = registry.register_sync(7, "sync".into());
    let subscription = sync.message_sync.as_ref().unwrap();
    subscription.attach([42]);
    let (hidden, mut hidden_rx) = registry.register_sync(8, "hidden".into());
    let hidden_subscription = hidden.message_sync.as_ref().unwrap();
    hidden_subscription.attach([42]);
    while legacy_rx.try_recv().is_ok() {}
    while sync_rx.try_recv().is_ok() {}
    while hidden_rx.try_recv().is_ok() {}

    registry.broadcast_to_uids(
        &[7],
        Arc::new(ServerWsMessage::ReactionUpdated(
            crate::dto::ws::ReactionUpdatePayload {
                message_id: 1,
                chat_id: 42,
                reactions: vec![],
            },
        )),
    );
    assert!(matches!(
        &*legacy_rx.try_recv().unwrap(),
        ServerWsMessage::ReactionUpdated(_)
    ));
    assert!(sync_rx.try_recv().is_err());
    tokio::time::timeout(
        std::time::Duration::from_millis(50),
        subscription.notified(),
    )
    .await
    .unwrap();
    assert!(hidden_rx.try_recv().is_err());
    tokio::time::timeout(
        std::time::Duration::from_millis(50),
        hidden_subscription.notified(),
    )
    .await
    .unwrap();

    crate::services::chat::publish_membership_changed(&registry, 7, 43);
    assert!(matches!(
        &*legacy_rx.try_recv().unwrap(),
        ServerWsMessage::ChatMembershipChanged(_)
    ));
    assert!(matches!(
        &*sync_rx.try_recv().unwrap(),
        ServerWsMessage::ChatMembershipChanged(_)
    ));
    tokio::time::timeout(
        std::time::Duration::from_millis(50),
        subscription.notified(),
    )
    .await
    .unwrap();

    registry.remove_connection(7, sync.conn_id);
    assert!(subscription.is_closed());
    let (stale, _rx) = registry.register_sync(8, "stale".into());
    stale.last_ping_at.store(0, Ordering::Relaxed);
    registry.prune_stale(1);
    assert!(stale.message_sync.as_ref().unwrap().is_closed());
}

#[tokio::test]
async fn chat_membership_event_reaches_only_the_members_devices_without_a_message() {
    let registry = registry();
    let (first, mut first_rx) = registry.register(7, "first".into());
    let (second, mut second_rx) = registry.register(7, "second".into());
    let (_, mut other_rx) = registry.register(8, "other".into());
    for rx in [&mut first_rx, &mut second_rx, &mut other_rx] {
        while rx.try_recv().is_ok() {}
    }

    crate::services::chat::publish_membership_changed(&registry, 7, 9_007_199_254_740_993);

    for rx in [&mut first_rx, &mut second_rx] {
        let event = rx.try_recv().unwrap();
        assert_eq!(event.message_type(), "chatMembershipChanged");
        assert_eq!(
            serde_json::to_value(&*event).unwrap(),
            serde_json::json!({
                "type": "chatMembershipChanged",
                "payload": { "chatId": "9007199254740993" }
            })
        );
        assert!(rx.try_recv().is_err());
    }
    assert!(other_rx.try_recv().is_err());
    for entry in [first, second] {
        for changed in [&entry.unread_changed, &entry.states_changed] {
            tokio::time::timeout(std::time::Duration::from_millis(50), changed.notified())
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn notification_preferences_reach_only_the_owners_devices_and_refresh_unread() {
    use crate::dto::{
        groups::ChatNotificationSettingResponse, users::NotificationSettingsResponse,
    };
    let registry = registry();
    let (first, mut rx1) = registry.register(7, "a".into());
    let (second, mut rx2) = registry.register(7, "b".into());
    let (_, mut other) = registry.register(8, "other".into());
    while rx1.try_recv().is_ok() {}
    while rx2.try_recv().is_ok() {}
    while other.try_recv().is_ok() {}
    registry.broadcast_to_uids(
        &[7],
        Arc::new(ServerWsMessage::NotificationSettingsChanged(
            NotificationSettingsResponse {
                mute_group_chats_by_default: true,
                mute_direct_chats_by_default: false,
            },
        )),
    );
    crate::services::notification_preferences::publish_chat_notification_setting(
        &registry,
        7,
        ChatNotificationSettingResponse {
            chat_id: 42,
            kind: crate::models::GroupKind::Group,
            archived: false,
            muted_until: None,
            mute_override: Some(false),
            is_muted: false,
        },
    );
    for rx in [&mut rx1, &mut rx2] {
        assert!(matches!(
            &*rx.try_recv().unwrap(),
            ServerWsMessage::NotificationSettingsChanged(_)
        ));
        assert!(matches!(
            &*rx.try_recv().unwrap(),
            ServerWsMessage::ChatArchiveStateChanged(_)
        ));
        let snapshot = rx.try_recv().unwrap();
        assert!(
            matches!(&*snapshot, ServerWsMessage::ChatNotificationSettingChanged(setting) if setting.mute_override == Some(false) && !setting.is_muted)
        );
        let value = serde_json::to_value(&*snapshot).unwrap();
        assert_eq!(value["payload"]["chatId"], "42");
        assert!(value["payload"]["mutedUntil"].is_null());
        assert_eq!(value["payload"]["muteOverride"], false);
    }
    registry.broadcast_to_uids(
        &[7],
        Arc::new(ServerWsMessage::NotificationExceptionsCleared(
            crate::dto::groups::NotificationExceptionsCleared {
                kind: crate::models::GroupKind::Group,
                chat_ids: vec!["9007199254740993".into()],
            },
        )),
    );
    for rx in [&mut rx1, &mut rx2] {
        let event = rx.try_recv().unwrap();
        let value = serde_json::to_value(&*event).unwrap();
        assert_eq!(value["type"], "notificationExceptionsCleared");
        assert_eq!(value["payload"]["chatIds"][0], "9007199254740993");
        assert!(rx.try_recv().is_err());
    }
    assert!(other.try_recv().is_err());
    for entry in [first, second] {
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            entry.unread_changed.notified(),
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn unread_invalidation_survives_a_full_event_queue_and_reaches_every_device() {
    let registry = registry();
    let (first, _rx) = registry.register(7, "a".into());
    let (second, _rx2) = registry.register(7, "b".into());
    let event = Arc::new(ServerWsMessage::ThreadMembershipChanged(
        crate::dto::ws::ThreadMembershipChangedPayload {
            status: None,
            chat_id: 1,
            thread_root_id: 2,
        },
    ));
    while first.tx.try_send(event.clone()).is_ok() {}
    registry.broadcast_to_uids(&[7], event);
    tokio::time::timeout(
        std::time::Duration::from_millis(50),
        first.unread_changed.notified(),
    )
    .await
    .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_millis(50),
        second.unread_changed.notified(),
    )
    .await
    .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_millis(50),
        first.lagged.notified(),
    )
    .await
    .unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        second.lagged.notified()
    )
    .await
    .is_err());
    for entry in [&first, &second] {
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            entry.states_changed.notified(),
        )
        .await
        .unwrap();
    }
    registry.invalidate_unread(&[7]);
    tokio::time::timeout(
        std::time::Duration::from_millis(50),
        first.unread_changed.notified(),
    )
    .await
    .unwrap();
}

#[test]
fn personal_away_expires_at_five_minutes_despite_inactive_reports() {
    let registry = registry();
    let (entry, _rx) = registry.register(7, "client-a".into());

    entry.update_app_state_at(AppPresenceState::Active, 1_000);
    entry.update_app_state_at(AppPresenceState::Inactive, 1_050);
    for at in [1_100, 1_150, 1_200, 1_250, 1_299] {
        entry.update_app_state_at(AppPresenceState::Inactive, at);
    }
    assert_eq!(
        entry.state_and_last_transition_at(),
        (AppPresenceState::Inactive, 1_050)
    );
    assert_eq!(
        registry.personal_presence_at(7, 1_299),
        Some(AppPresenceState::Inactive)
    );
    entry.update_app_state_at(AppPresenceState::Inactive, 1_300);
    assert_eq!(registry.personal_presence_at(7, 1_300), None);
}

#[test]
fn expired_away_connection_stays_live_without_suppressing_push() {
    let registry = registry();
    let (entry, _rx) = registry.register(7, "client-a".into());
    let now = now_secs();
    entry.update_app_state_at(AppPresenceState::Active, now - AWAY_TIMEOUT_SECS - 1);
    entry.update_app_state_at(AppPresenceState::Inactive, now - AWAY_TIMEOUT_SECS);

    entry.update_ping(AppPresenceState::Inactive);

    assert_eq!(registry.personal_presence(7), None);
    assert_eq!(registry.count_online(&[7]), 0);
    assert!(!registry.should_suppress_push(7, 30));
}

#[test]
fn personal_presence_prefers_active_device_over_away_device() {
    let registry = registry();
    let (away, _away_rx) = registry.register(7, "away".into());
    away.update_app_state_at(AppPresenceState::Active, 100);
    away.update_app_state_at(AppPresenceState::Inactive, 150);
    let (active, _active_rx) = registry.register(7, "active".into());
    active.update_app_state_at(AppPresenceState::Active, 180);
    assert_eq!(
        registry.personal_presence_at(7, 180),
        Some(AppPresenceState::Active)
    );
    away.update_app_state_at(AppPresenceState::Inactive, 230);
    assert_eq!(
        registry.personal_presence_at(7, 239),
        Some(AppPresenceState::Active)
    );
    assert_eq!(
        registry.personal_presence_at(7, 240),
        Some(AppPresenceState::Inactive)
    );
    assert_eq!(away.presence.lock().unwrap().last_end, Some(240));
}

#[test]
fn initial_or_reconnected_inactive_connection_has_no_personal_away_grace() {
    let registry = registry();
    let (entry, _rx) = registry.register(7, "client-a".into());

    entry.update_app_state_at(AppPresenceState::Inactive, 1_000);
    assert_eq!(registry.personal_presence_at(7, 1_000), None);

    entry.update_app_state_at(AppPresenceState::Active, 1_010);
    entry.update_app_state_at(AppPresenceState::Inactive, 1_020);
    assert_eq!(
        registry.personal_presence_at(7, 1_020),
        Some(AppPresenceState::Inactive)
    );
    registry.remove_connection(7, entry.conn_id);

    let (reconnected, _reconnected_rx) = registry.register(7, "client-a".into());
    reconnected.update_app_state_at(AppPresenceState::Inactive, 1_100);
    assert_eq!(registry.personal_presence_at(7, 1_100), None);
}

#[test]
fn last_active_disconnect_cancels_other_devices_away() {
    let registry = registry();
    let (away, _away_rx) = registry.register(7, "away".into());
    let (active, _active_rx) = registry.register(7, "active".into());
    away.update_ping(AppPresenceState::Active);
    away.update_ping(AppPresenceState::Inactive);
    active.update_ping(AppPresenceState::Active);
    registry.remove_connection(7, active.conn_id);
    assert_eq!(registry.personal_presence(7), None);
    away.update_ping(AppPresenceState::Inactive);
    assert_eq!(registry.personal_presence(7), None);
    assert!(registry.active_period_end(7).is_some());
}

#[test]
fn silent_expiry_ends_at_freshness_deadline_and_cannot_become_away() {
    let registry = registry();
    let (entry, _rx) = registry.register(7, "client".into());
    entry.update_app_state_at(AppPresenceState::Active, 1_000);
    assert_eq!(
        registry.personal_presence_at(7, 1_059),
        Some(AppPresenceState::Active)
    );
    assert_eq!(registry.personal_presence_at(7, 1_060), None);
    assert_eq!(entry.presence.lock().unwrap().last_end, Some(1_060));
    entry.update_app_state_at(AppPresenceState::Inactive, 1_061);
    assert_eq!(registry.personal_presence_at(7, 1_061), None);
    assert_eq!(entry.presence.lock().unwrap().last_end, Some(1_060));
}

#[test]
fn suppresses_push_for_fresh_active_connection() {
    let registry = registry();
    let (entry, _rx) = registry.register(7, "client-a".to_string());
    entry.update_ping(AppPresenceState::Active);

    assert!(registry.should_suppress_push(7, 30));
}

#[test]
fn does_not_suppress_push_for_inactive_connection() {
    let registry = registry();
    let (entry, _rx) = registry.register(7, "client-a".to_string());
    entry.update_app_state(AppPresenceState::Inactive);

    assert!(!registry.should_suppress_push(7, 30));
}

#[test]
fn does_not_suppress_push_for_stale_connection() {
    let registry = registry();
    let (entry, _rx) = registry.register(7, "client-a".to_string());
    entry.update_ping(AppPresenceState::Active);
    entry
        .last_ping_at
        .store(now_secs().saturating_sub(31), Ordering::Relaxed);

    assert!(!registry.should_suppress_push(7, 30));
}

#[test]
fn suppresses_push_when_any_connection_is_active() {
    let registry = registry();
    let (inactive_entry, _rx1) = registry.register(7, "client-a".to_string());
    inactive_entry.update_app_state(AppPresenceState::Inactive);
    let (active_entry, _rx2) = registry.register(7, "client-b".to_string());
    active_entry.update_ping(AppPresenceState::Active);

    assert!(registry.should_suppress_push(7, 30));
}

#[test]
fn lists_only_fresh_open_connections_for_the_requested_user() {
    let registry = registry();
    let (first, first_rx) = registry.register(7, "client-a".to_string());
    first.update_ping(AppPresenceState::Active);
    let (second, _second_rx) = registry.register(7, "client-a".to_string());
    second.update_app_state(AppPresenceState::Inactive);
    let (other_user, _other_rx) = registry.register(8, "client-b".to_string());
    let (stale, _stale_rx) = registry.register(7, "client-c".to_string());
    stale.last_ping_at.store(
        now_secs().saturating_sub(STALE_CONNECTION_TIMEOUT_SECS + 1),
        Ordering::Relaxed,
    );
    let fresh_connections = registry.online_connections(7);
    assert_eq!(fresh_connections.len(), 2);
    assert_eq!(fresh_connections[0].client_id, "client-a");
    assert_eq!(fresh_connections[0].app_state, AppPresenceState::Active);
    assert_eq!(fresh_connections[1].client_id, "client-a");
    assert_eq!(fresh_connections[1].app_state, AppPresenceState::Inactive);

    drop(first_rx);

    let connections = registry.online_connections(7);

    assert_eq!(
        connections,
        vec![OnlineConnection {
            connection_id: second.conn_id,
            client_id: "client-a".to_string(),
            app_state: AppPresenceState::Inactive,
        }]
    );
    assert_ne!(first.conn_id, second.conn_id);
    assert_ne!(other_user.conn_id, second.conn_id);

    registry.remove_connection(7, second.conn_id);
    assert!(registry.online_connections(7).is_empty());
}

#[test]
fn removing_one_device_preserves_another_fresh_device() {
    let registry = registry();
    let (closing, _closing_rx) = registry.register(7, "client-a".to_string());
    let (surviving, _surviving_rx) = registry.register(7, "client-b".to_string());
    surviving.update_ping(AppPresenceState::Active);

    registry.remove_connection(7, closing.conn_id);

    assert!(registry.is_online(7));
    assert_eq!(
        registry.online_connections(7),
        vec![OnlineConnection {
            connection_id: surviving.conn_id,
            client_id: "client-b".to_string(),
            app_state: AppPresenceState::Active,
        }]
    );
}

#[test]
fn presence_is_offline_for_a_fresh_background_connection() {
    let registry = registry();
    let (entry, _rx) = registry.register(7, "client-a".to_string());
    entry.update_app_state(AppPresenceState::Inactive);

    assert!(!registry.is_online(7));
}

#[test]
fn presence_is_online_when_any_device_is_fresh() {
    let registry = registry();
    let (stale, _stale_rx) = registry.register(7, "client-a".to_string());
    stale.update_app_state_at(AppPresenceState::Active, now_secs().saturating_sub(61));
    let (fresh, _fresh_rx) = registry.register(7, "client-b".to_string());
    fresh.update_ping(AppPresenceState::Active);
    assert!(registry.is_online(7));
    fresh.update_ping(AppPresenceState::Inactive);
    assert!(!registry.is_online(7));
}

#[test]
fn group_online_count_counts_users_not_devices_and_excludes_dead_connections() {
    let registry = registry();
    let (first, _first_rx) = registry.register(7, "first".into());
    first.update_ping(AppPresenceState::Active);
    let (second, second_rx) = registry.register(7, "second".into());
    second.update_app_state(AppPresenceState::Inactive);
    second.update_ping(AppPresenceState::Active);
    let (stale, _stale_rx) = registry.register(8, "stale".into());
    stale.update_app_state_at(AppPresenceState::Active, now_secs().saturating_sub(61));
    let (_closed, closed_rx) = registry.register(9, "closed".into());
    _closed.update_ping(AppPresenceState::Active);
    drop(closed_rx);

    assert_eq!(registry.count_online(&[7, 8, 9, 10]), 1);

    registry.remove_connection(7, first.conn_id);
    assert_eq!(registry.count_online(&[7, 8, 9, 10]), 1);

    drop(second_rx);
    assert_eq!(registry.count_online(&[7, 8, 9, 10]), 0);
}
