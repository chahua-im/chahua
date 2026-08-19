use chrono::{DateTime, Utc};
use serde::Serialize;

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
    ThreadUpdate(ThreadUpdatePayload),
    ThreadMembershipChanged(ThreadMembershipChangedPayload),
    ChatArchiveStateChanged(ChatArchiveStateChangedPayload),
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
            Self::ThreadUpdate(_) => "threadUpdate",
            Self::ThreadMembershipChanged(_) => "threadMembershipChanged",
            Self::ChatArchiveStateChanged(_) => "chatArchiveStateChanged",
            Self::PinAdded(_) => "pinAdded",
            Self::ThreadPinAdded(_) => "threadPinAdded",
            Self::PinRemoved(_) => "pinRemoved",
            Self::ThreadPinRemoved(_) => "threadPinRemoved",
            Self::StickerPackOrderUpdated(_) => "stickerPackOrderUpdated",
            Self::FriendRequestReceived(_) => "friendRequestReceived",
            Self::FriendRequestResolved(_) => "friendRequestResolved",
            Self::FriendshipRemoved(_) => "friendshipRemoved",
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

#[cfg(test)]
mod tests {
    use super::{
        PinUpdatePayload, PresenceUpdatePayload, ServerWsMessage, ThreadMembershipChangedPayload,
    };
    use serde_json::json;

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
}
