use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::dto::{
    messages::{MessageResponse, ReactionSummary},
    pins::PinResponse,
    users::StickerPackOrderItem,
};

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TicketResponse {
    pub ticket: String,
}

/// Client controls retain their flat wire shape; future message types are ignored.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientWsMessage {
    Auth {
        ticket: String,
    },
    Ping {
        state: Option<OnlineClientStatus>,
    },
    AppState {
        state: Option<OnlineClientStatus>,
    },
    WatchPresence {
        request_id: Option<u64>,
        user_ids: Option<Vec<i32>>,
        chat_ids: Option<Vec<String>>,
    },
    #[serde(other)]
    Unknown,
}

/// A WebSocket connection's app-presence state.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum OnlineClientStatus {
    Active,
    Inactive,
}

/// A current WebSocket connection belonging to the authenticated user.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OnlineClientConnectionResponse {
    /// Server-assigned identifier unique to this connection.
    pub connection_id: u64,
    /// Authenticated client identifier carried by the WebSocket ticket.
    pub client_id: String,
    /// Most recently recorded HTTP application version for this client, when known.
    pub last_app_version: Option<String>,
    /// Current app-presence state reported by this connection.
    pub status: OnlineClientStatus,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BulkDeletedPayload {
    pub chat_id: String,
    pub message_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ServerWsMessage {
    Message(MessageResponse),
    MessageUpdated(MessageResponse),
    MessageDeleted(MessageResponse),
    MessagesBulkDeleted(BulkDeletedPayload),
    ReactionUpdated(ReactionUpdatePayload),
    PresenceUpdate(PresenceUpdatePayload),
    PresenceSnapshot(PresenceSnapshotPayload),
    ThreadUpdate(ThreadUpdatePayload),
    ThreadMembershipChanged(ThreadMembershipChangedPayload),
    ChatArchiveStateChanged(ChatArchiveStateChangedPayload),
    ReadReceiptChanged(ReadReceiptChangedPayload),
    /// Chat-level pin event. Kept stable for already-deployed clients.
    PinAdded(PinUpdatePayload),
    /// Thread-scoped pin event. Old clients ignore this unknown event type.
    ThreadPinAdded(PinUpdatePayload),
    /// Chat-level pin event. Kept stable for already-deployed clients.
    PinRemoved(PinUpdatePayload),
    /// Thread-scoped pin event. Old clients ignore this unknown event type.
    ThreadPinRemoved(PinUpdatePayload),
    StickerPackOrderUpdated(StickerPackOrderUpdatePayload),
    FriendRequestReceived(FriendRequestReceivedPayload),
    FriendRequestResolved(FriendRequestResolvedPayload),
    FriendshipRemoved(FriendshipRemovedPayload),
    Notification(NotificationPayload),
}

impl ServerWsMessage {
    pub fn message_type(&self) -> &'static str {
        match self {
            Self::Message(_) => "message",
            Self::MessageUpdated(_) => "messageUpdated",
            Self::MessageDeleted(_) => "messageDeleted",
            Self::MessagesBulkDeleted(_) => "messagesBulkDeleted",
            Self::ReactionUpdated(_) => "reactionUpdated",
            Self::PresenceUpdate(_) => "presenceUpdate",
            Self::PresenceSnapshot(_) => "presenceSnapshot",
            Self::ThreadUpdate(_) => "threadUpdate",
            Self::ThreadMembershipChanged(_) => "threadMembershipChanged",
            Self::ChatArchiveStateChanged(_) => "chatArchiveStateChanged",
            Self::ReadReceiptChanged(_) => "readReceiptChanged",
            Self::PinAdded(_) => "pinAdded",
            Self::ThreadPinAdded(_) => "threadPinAdded",
            Self::PinRemoved(_) => "pinRemoved",
            Self::ThreadPinRemoved(_) => "threadPinRemoved",
            Self::StickerPackOrderUpdated(_) => "stickerPackOrderUpdated",
            Self::FriendRequestReceived(_) => "friendRequestReceived",
            Self::FriendRequestResolved(_) => "friendRequestResolved",
            Self::FriendshipRemoved(_) => "friendshipRemoved",
            Self::Notification(_) => "notification",
        }
    }
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionUpdatePayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub message_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub reactions: Vec<ReactionSummary>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUpdatePayload {
    pub active_connections: u32,
}

/// One watched user's current presence. `last_seen_at` is omitted when no HTTP activity has
/// been recorded for that user.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserPresenceResponse {
    pub uid: i32,
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// Current aggregate presence for one regular group.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupPresenceResponse {
    /// Snowflake chat ID encoded as a decimal string.
    pub chat_id: String,
    pub member_count: u32,
    pub online_count: u32,
}

/// Absolute response to a `watchPresence` control message.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshotPayload {
    /// Echoed only when the client supplied a correlation ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
    pub users: Vec<UserPresenceResponse>,
    pub groups: Vec<GroupPresenceResponse>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUpdatePayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub thread_root_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub last_reply_at: DateTime<Utc>,
    pub reply_count: i64,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMembershipChangedPayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub thread_root_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatArchiveStateChangedPayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted_until: Option<DateTime<Utc>>,
}

/// Invalidation-only signal for a direct-message receipt. The cursor itself
/// stays private to the HTTP endpoint; privacy changes let clients clear a
/// previously rendered receipt before their authorized refetch completes.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadReceiptChangedPayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy_changed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PinUpdatePayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub pin_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub message_id: i64,
    #[serde(
        with = "crate::serde_i64_string::opt",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>)]
    pub thread_root_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<PinResponse>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackOrderUpdatePayload {
    pub order: Vec<StickerPackOrderItem>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestReceivedPayload {
    pub from_uid: i32,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestResolvedPayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub request_id: i64,
    pub status: crate::models::FriendRequestStatus,
    /// The uid of the user who accepted/rejected the request.
    pub by_uid: i32,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendshipRemovedPayload {
    /// The uid of the user who removed the friendship.
    pub actor_uid: i32,
}

/// Kind of directed notification delivered to a specific user.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum NotificationType {
    Mention,
    Reply,
    Reaction,
}

/// Directed notification to a specific user about a mention, a reply to one of
/// their messages, or a reaction on one of their messages. Delivered only to
/// the affected user via the realtime WebSocket.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub notification_type: NotificationType,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub message_id: i64,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(value_type = Option<String>)]
    pub thread_root_id: Option<i64>,
    pub actor_uid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        ClientWsMessage, GroupPresenceResponse, NotificationPayload, NotificationType,
        OnlineClientStatus, PinUpdatePayload, PresenceSnapshotPayload, PresenceUpdatePayload,
        ReadReceiptChangedPayload, ServerWsMessage, ThreadMembershipChangedPayload,
        UserPresenceResponse,
    };
    use serde_json::json;

    #[test]
    fn decodes_flat_client_controls_with_variant_specific_fields() {
        assert!(matches!(
            serde_json::from_str::<ClientWsMessage>(r#"{"type":"auth","ticket":"session"}"#).unwrap(),
            ClientWsMessage::Auth { ticket } if ticket == "session"
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
            ).unwrap(),
            ClientWsMessage::Ping { state: Some(OnlineClientStatus::Inactive) }
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
        let value =
            serde_json::to_value(ServerWsMessage::PresenceSnapshot(PresenceSnapshotPayload {
                request_id: Some(12),
                users: vec![UserPresenceResponse {
                    uid: 7,
                    online: true,
                    last_seen_at: None,
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
                thread_root_id: 42,
                chat_id: 7,
            },
        ))
        .expect("serialize thread membership event");

        assert_eq!(value["type"], json!("threadMembershipChanged"));
        assert_eq!(value["payload"]["threadRootId"], json!("42"));
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
}
