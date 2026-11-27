use super::{
    ClientWsMessage, GroupPresenceResponse, NotificationPayload, NotificationType,
    OnlineClientStatus, PinUpdatePayload, PresenceSnapshotPayload, PresenceUpdatePayload,
    ReadReceiptChangedPayload, ServerWsMessage, ThreadMembershipChangedPayload,
    UserPresenceResponse,
};
use serde_json::json;

#[test]
fn unread_watch_preserves_large_ids_and_accepts_explicit_cancellation() {
    let watch: ClientWsMessage = serde_json::from_str(r#"{"type":"watchConversationUnread","requestId":7,"views":[{"key":"custom","selector":{"include":[{"chatId":"9223372036854775807","threadId":"9007199254740993"}]}}],"appBadge":true}"#).unwrap();
    let ClientWsMessage::WatchConversationUnread {
        request_id,
        views,
        app_badge,
    } = watch
    else {
        panic!()
    };
    assert_eq!(request_id, 7);
    assert!(app_badge);
    assert_eq!(views[0].selector.include[0].chat_id, i64::MAX);
    assert_eq!(
        views[0].selector.include[0].thread_id,
        Some(9007199254740993)
    );
    assert!(matches!(
        serde_json::from_str::<ClientWsMessage>(
            r#"{"type":"watchConversationUnread","requestId":8,"views":[]}"#
        )
        .unwrap(),
        ClientWsMessage::WatchConversationUnread {
            app_badge: false,
            ..
        }
    ));
}

#[test]
fn auth_accepts_optional_sync_versions_without_changing_legacy_auth() {
    for value in ["null", "2", "\"future\""] {
        let text = format!(r#"{{"type":"auth","ticket":"session","messageSync":{value}}}"#);
        assert!(matches!(
            serde_json::from_str::<ClientWsMessage>(&text).unwrap(),
            ClientWsMessage::Auth { ticket, .. } if ticket == "session"
        ));
    }
}

#[test]
fn decodes_flat_client_controls_with_variant_specific_fields() {
    assert!(matches!(
        serde_json::from_str::<ClientWsMessage>(r#"{"type":"auth","ticket":"session"}"#).unwrap(),
        ClientWsMessage::Auth { ticket, .. } if ticket == "session"
    ));
    assert!(matches!(
        serde_json::from_str::<ClientWsMessage>(r#"{"type":"ping","state":"active"}"#).unwrap(),
        ClientWsMessage::Ping {
            state: Some(OnlineClientStatus::Active)
        }
    ));
    assert!(matches!(
        serde_json::from_str::<ClientWsMessage>(r#"{"type":"appState","state":"inactive"}"#)
            .unwrap(),
        ClientWsMessage::AppState {
            state: Some(OnlineClientStatus::Inactive)
        }
    ));
    assert!(matches!(
        serde_json::from_str::<ClientWsMessage>(
            r#"{"type":"watchPresence","requestId":12,"userIds":[2],"chatIds":["9223372036854775807"]}"#
        ).unwrap(),
        ClientWsMessage::WatchPresence { request_id: Some(12), user_ids: Some(users), chat_ids: Some(chats) }
            if users == [2] && chats == ["9223372036854775807"]
    ));
}

#[test]
fn tolerates_future_message_types_and_unrelated_fields() {
    assert!(matches!(
            serde_json::from_str::<ClientWsMessage>(
                r#"{"type":"futureCommand","state":"futureState","userIds":"futureShape","payload":{"nested":[1,2]}}"#
            ).unwrap(),
            ClientWsMessage::Unknown
        ));
    assert!(matches!(
        serde_json::from_str::<ClientWsMessage>(
            r#"{"type":"ping","state":"inactive","requestId":"unrelated","userIds":"unrelated"}"#
        )
        .unwrap(),
        ClientWsMessage::Ping {
            state: Some(OnlineClientStatus::Inactive)
        }
    ));
}

#[test]
fn preserves_optional_client_fields_and_null_empty_scopes() {
    for message in [r#"{"type":"ping"}"#, r#"{"type":"ping","state":null}"#] {
        assert!(matches!(
            serde_json::from_str::<ClientWsMessage>(message).unwrap(),
            ClientWsMessage::Ping { state: None }
        ));
    }
    assert!(matches!(
        serde_json::from_str::<ClientWsMessage>(r#"{"type":"appState"}"#).unwrap(),
        ClientWsMessage::AppState { state: None }
    ));
    for message in [
        r#"{"type":"watchPresence","requestId":4}"#,
        r#"{"type":"watchPresence","requestId":4,"userIds":null,"chatIds":null}"#,
    ] {
        assert!(matches!(
            serde_json::from_str::<ClientWsMessage>(message).unwrap(),
            ClientWsMessage::WatchPresence {
                request_id: Some(4),
                user_ids: None,
                chat_ids: None
            }
        ));
    }
}

#[test]
fn accepts_watch_presence_without_correlation_and_preserves_zero() {
    for message in [
        r#"{"type":"watchPresence","userIds":[2]}"#,
        r#"{"type":"watchPresence","requestId":null,"userIds":[2]}"#,
    ] {
        assert!(matches!(
            serde_json::from_str::<ClientWsMessage>(message).unwrap(),
            ClientWsMessage::WatchPresence { request_id: None, user_ids: Some(users), .. }
                if users == [2]
        ));
    }
    assert!(matches!(
        serde_json::from_str::<ClientWsMessage>(
            r#"{"type":"watchPresence","requestId":0,"userIds":[2]}"#
        )
        .unwrap(),
        ClientWsMessage::WatchPresence {
            request_id: Some(0),
            ..
        }
    ));
}

#[test]
fn omits_absent_snapshot_correlation_without_substituting_zero() {
    let mut payload = PresenceSnapshotPayload {
        request_id: None,
        users: vec![],
        groups: vec![],
    };
    let value = serde_json::to_value(&payload).unwrap();
    assert!(value.get("requestId").is_none());
    payload.request_id = Some(0);
    let value = serde_json::to_value(&payload).unwrap();
    assert_eq!(value["requestId"], json!(0));
}

#[test]
fn read_receipt_invalidation_never_serializes_a_cursor() {
    let ordinary = serde_json::to_value(ServerWsMessage::ReadReceiptChanged(
        ReadReceiptChangedPayload {
            reader_uid: None,
            thread_root_id: None,
            chat_id: 9_223_372_036_854_775_807,
            privacy_changed: None,
        },
    ))
    .unwrap();
    assert_eq!(ordinary["type"], "readReceiptChanged");
    assert_eq!(
        ordinary["payload"],
        json!({"chatId": "9223372036854775807"})
    );

    let privacy_changed = serde_json::to_value(ServerWsMessage::ReadReceiptChanged(
        ReadReceiptChangedPayload {
            reader_uid: None,
            thread_root_id: None,
            chat_id: 7,
            privacy_changed: Some(true),
        },
    ))
    .unwrap();
    assert_eq!(
        privacy_changed["payload"],
        json!({"chatId": "7", "privacyChanged": true})
    );
}

#[test]
fn rejects_malformed_known_controls_instead_of_treating_them_as_unknown() {
    for message in [
        r#"{"type":"auth"}"#,
        r#"{"type":"auth","ticket":false}"#,
        r#"{"type":"ping","state":"unknownState"}"#,
        r#"{"type":"watchPresence","requestId":"wrong"}"#,
        r#"{"type":"watchPresence","requestId":1,"chatIds":[42]}"#,
        r#"{"type":42}"#,
        r#"{"state":"active"}"#,
        "{",
    ] {
        assert!(
            serde_json::from_str::<ClientWsMessage>(message).is_err(),
            "{message}"
        );
    }
}

#[test]
fn serializes_ws_event_types_and_payload_keys_as_camel_case() {
    let value = serde_json::to_value(ServerWsMessage::PresenceUpdate(PresenceUpdatePayload {
        active_connections: 3,
    }))
    .expect("serialize ws event");

    assert_eq!(value["type"], json!("presenceUpdate"));
    assert_eq!(value["payload"]["activeConnections"], json!(3));
    assert!(value["payload"].get("active_connections").is_none());
}

#[test]
fn serializes_absolute_presence_snapshot_and_omits_unknown_last_seen() {
    let value = serde_json::to_value(ServerWsMessage::PresenceSnapshot(PresenceSnapshotPayload {
        request_id: Some(12),
        users: vec![UserPresenceResponse {
            uid: 7,
            online: true,
            away: None,
            last_seen_at: None,
            last_seen_bucket: None,
        }],
        groups: vec![GroupPresenceResponse {
            chat_id: "9223372036854775807".to_string(),
            member_count: 5,
            online_count: 2,
        }],
    }))
    .expect("serialize presence snapshot");

    assert_eq!(value["type"], json!("presenceSnapshot"));
    assert_eq!(value["payload"]["requestId"], json!(12));
    assert_eq!(value["payload"]["users"][0]["uid"], json!(7));
    assert_eq!(
        value["payload"]["groups"][0]["chatId"],
        json!("9223372036854775807")
    );
    assert!(value["payload"]["users"][0].get("lastSeenAt").is_none());
}

#[test]
fn serializes_thread_membership_changed_as_camel_case() {
    let value = serde_json::to_value(ServerWsMessage::ThreadMembershipChanged(
        ThreadMembershipChangedPayload {
            status: Some(crate::dto::threads::ThreadSubscriptionStatusResponse {
                subscribed: true,
                archived: false,
            }),
            thread_root_id: 42,
            chat_id: 7,
        },
    ))
    .expect("serialize thread membership event");

    assert_eq!(value["type"], json!("threadMembershipChanged"));
    assert_eq!(value["payload"]["threadRootId"], json!("42"));
    assert_eq!(
        value["payload"]["status"],
        json!({"subscribed": true, "archived": false})
    );
    assert_eq!(value["payload"]["chatId"], json!("7"));
}

#[test]
fn serializes_thread_pin_events_with_a_distinct_type() {
    let value = serde_json::to_value(ServerWsMessage::ThreadPinAdded(PinUpdatePayload {
        chat_id: 1,
        pin_id: 2,
        message_id: 3,
        thread_root_id: Some(4),
        pin: None,
    }))
    .expect("serialize thread pin added event");

    assert_eq!(value["type"], json!("threadPinAdded"));
    assert_eq!(value["payload"]["threadRootId"], json!("4"));
}

#[test]
fn serializes_thread_pin_removal_with_a_distinct_type() {
    let value = serde_json::to_value(ServerWsMessage::ThreadPinRemoved(PinUpdatePayload {
        chat_id: 1,
        pin_id: 2,
        message_id: 3,
        thread_root_id: Some(4),
        pin: None,
    }))
    .expect("serialize thread pin removed event");

    assert_eq!(value["type"], json!("threadPinRemoved"));
    assert_eq!(value["payload"]["threadRootId"], json!("4"));
}

#[test]
fn omits_thread_scope_for_chat_level_pins() {
    let value = serde_json::to_value(ServerWsMessage::PinRemoved(PinUpdatePayload {
        chat_id: 1,
        pin_id: 2,
        message_id: 3,
        thread_root_id: None,
        pin: None,
    }))
    .expect("serialize pin removed event");

    assert_eq!(value["type"], json!("pinRemoved"));
    assert!(value["payload"].get("threadRootId").is_none());
}

#[test]
fn serializes_notification_event_as_camel_case() {
    let value = serde_json::to_value(ServerWsMessage::Notification(NotificationPayload {
        notification_type: NotificationType::Mention,
        chat_id: 7,
        message_id: 42,
        thread_root_id: Some(99),
        actor_uid: 5,
        actor_name: Some("alice".to_string()),
    }))
    .expect("serialize notification event");

    assert_eq!(value["type"], json!("notification"));
    assert_eq!(value["payload"]["notificationType"], json!("mention"));
    assert_eq!(value["payload"]["chatId"], json!("7"));
    assert_eq!(value["payload"]["messageId"], json!("42"));
    assert_eq!(value["payload"]["threadRootId"], json!("99"));
    assert_eq!(value["payload"]["actorUid"], json!(5));
    assert_eq!(value["payload"]["actorName"], json!("alice"));
    assert!(value["payload"].get("chat_id").is_none());
}

#[test]
fn serializes_reply_notification_type_as_reply() {
    let value = serde_json::to_value(ServerWsMessage::Notification(NotificationPayload {
        notification_type: NotificationType::Reply,
        chat_id: 7,
        message_id: 42,
        thread_root_id: None,
        actor_uid: 5,
        actor_name: None,
    }))
    .expect("serialize reply notification event");

    assert_eq!(value["payload"]["notificationType"], json!("reply"));
    assert_eq!(value["payload"]["threadRootId"], json!(null));
    assert!(value["payload"].get("actorName").is_none());
}

#[test]
fn serializes_reaction_notification_type_as_reaction() {
    let value = serde_json::to_value(ServerWsMessage::Notification(NotificationPayload {
        notification_type: NotificationType::Reaction,
        chat_id: 7,
        message_id: 42,
        thread_root_id: None,
        actor_uid: 5,
        actor_name: None,
    }))
    .expect("serialize reaction notification event");

    assert_eq!(value["payload"]["notificationType"], json!("reaction"));
    assert_eq!(value["payload"]["threadRootId"], json!(null));
    assert!(value["payload"].get("actorName").is_none());
}
