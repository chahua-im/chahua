use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::dto::{messages::ReactionSummary, pins::PinResponse, users::StickerPackOrderItem};

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
        #[serde(default)]
        message_sync: Option<serde_json::Value>,
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
    WatchConversationUnread {
        request_id: u32,
        views: Vec<crate::dto::conversations::ConversationView>,
        #[serde(default)]
        app_badge: bool,
    },
    WatchConversationStates {
        request_id: u32,
        conversations: Vec<crate::dto::conversations::ConversationRef>,
    },
    MessageSyncResume(crate::dto::message_sync::MessageSyncResumeParams),
    MessageSyncPage(crate::dto::message_sync::MessageSyncPageParams),
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
    /// Authenticated client identifier retained by this connection.
    pub client_id: String,
    /// Most recently recorded application version for this client, when known.
    pub last_app_version: Option<String>,
    /// Current app-presence state reported by this connection.
    pub status: OnlineClientStatus,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BulkDeletedPayload {
    /// False for intermediate batches; true after metadata and read cursors are reconciled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_root_ids: Option<Vec<String>>,
    pub chat_id: String,
    pub message_ids: Vec<String>,
}

/// The one source of truth for server event variants and their wire
/// literals. RPC event metadata and encoding consume this list as well.
macro_rules! server_ws_messages {
    ($callback:ident) => {
        $callback! {
            ChatMembershipChanged(crate::dto::ws::ChatMembershipChangedPayload) => "chatMembershipChanged",
            MembershipMessagePolicyChanged(crate::dto::groups::MembershipMessagePolicyChanged) => "membershipMessagePolicyChanged",
            Message(crate::dto::messages::MessageResponse) => "message",
            MessageUpdated(crate::dto::messages::MessageResponse) => "messageUpdated",
            MessageDeleted(crate::dto::messages::MessageResponse) => "messageDeleted",
            MessagesBulkDeleted(crate::dto::ws::BulkDeletedPayload) => "messagesBulkDeleted",
            ReactionUpdated(crate::dto::ws::ReactionUpdatePayload) => "reactionUpdated",
            MessageSyncHello(crate::dto::message_sync::MessageSyncHello) => "messageSyncHello",
            MessageSyncBatch(crate::dto::message_sync::MessageSyncBatch) => "messageSyncBatch",
            MessageSyncReady(crate::dto::message_sync::MessageSyncReady) => "messageSyncReady",
            MessageSyncReset(crate::dto::message_sync::MessageSyncReset) => "messageSyncReset",
            MessageSyncRevoked(crate::dto::message_sync::MessageSyncRevoked) => "messageSyncRevoked",
            MessageSyncPageResult(crate::dto::message_sync::MessageSyncPageResult) => "messageSyncPageResult",
            MessageSyncResumed(crate::dto::message_sync::MessageSyncResumed) => "messageSyncResumed",
            PresenceUpdate(crate::dto::ws::PresenceUpdatePayload) => "presenceUpdate",
            PresenceSnapshot(crate::dto::ws::PresenceSnapshotPayload) => "presenceSnapshot",
            ConversationUnread(crate::dto::conversations::ConversationUnreadPayload) => "conversationUnread",
            ConversationStates(crate::dto::conversations::ConversationStatesPayload) => "conversationStates",
            ConversationStatesError(crate::dto::conversations::ConversationUnreadErrorPayload) => "conversationStatesError",
            ConversationUnreadError(crate::dto::conversations::ConversationUnreadErrorPayload) => "conversationUnreadError",
            ThreadUpdate(crate::dto::ws::ThreadUpdatePayload) => "threadUpdate",
            ThreadMembershipChanged(crate::dto::ws::ThreadMembershipChangedPayload) => "threadMembershipChanged",
            ChatArchiveStateChanged(crate::dto::ws::ChatArchiveStateChangedPayload) => "chatArchiveStateChanged",
            NotificationExceptionsCleared(crate::dto::groups::NotificationExceptionsCleared) => "notificationExceptionsCleared",
            NotificationSettingsChanged(crate::dto::users::NotificationSettingsResponse) => "notificationSettingsChanged",
            ChatSettingsChanged(crate::dto::users::ChatSettings) => "chatSettingsChanged",
            ChatNotificationSettingChanged(crate::dto::groups::ChatNotificationSettingResponse) => "chatNotificationSettingChanged",
            GroupSpeakingModeChanged(crate::dto::speaking::GroupSpeakingModeResponse) => "groupSpeakingModeChanged",
            MemberSpeakingModeChanged(crate::dto::speaking::MemberSpeakingModeResponse) => "memberSpeakingModeChanged",
            ReadReceiptChanged(crate::dto::ws::ReadReceiptChangedPayload) => "readReceiptChanged",
            /// Chat-level pin event. Kept stable for already-deployed clients.
            PinAdded(crate::dto::ws::PinUpdatePayload) => "pinAdded",
            /// Thread-scoped pin event. Old clients ignore this unknown event type.
            ThreadPinAdded(crate::dto::ws::PinUpdatePayload) => "threadPinAdded",
            /// Chat-level pin event. Kept stable for already-deployed clients.
            PinRemoved(crate::dto::ws::PinUpdatePayload) => "pinRemoved",
            /// Thread-scoped pin event. Old clients ignore this unknown event type.
            ThreadPinRemoved(crate::dto::ws::PinUpdatePayload) => "threadPinRemoved",
            StickerPackOrderUpdated(crate::dto::ws::StickerPackOrderUpdatePayload) => "stickerPackOrderUpdated",
            FriendRequestReceived(crate::dto::ws::FriendRequestReceivedPayload) => "friendRequestReceived",
            FriendRequestResolved(crate::dto::ws::FriendRequestResolvedPayload) => "friendRequestResolved",
            FriendshipRemoved(crate::dto::ws::FriendshipRemovedPayload) => "friendshipRemoved",
            Notification(crate::dto::ws::NotificationPayload) => "notification",
        }
    };
}

pub(crate) use server_ws_messages;

macro_rules! define_server_ws_message {
    ($($(#[$doc:meta])* $variant:ident($payload:ty) => $message_type:literal,)*) => {
        #[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
        #[serde(tag = "type", content = "payload", rename_all = "camelCase")]
        pub enum ServerWsMessage {
            $(
                $(#[$doc])*
                $variant($payload),
            )*
        }

        impl ServerWsMessage {
            pub fn message_type(&self) -> &'static str {
                match self {
                    $(Self::$variant(_) => $message_type,)*
                }
            }
        }
    };
}

server_ws_messages!(define_server_ws_message);

/// Invalidate the recipient's chat-list row after joining, independently of system messages.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMembershipChangedPayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
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

/// Privacy-filtered last-seen approximation. Boundaries are 3, 7 and 30 days.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum LastSeenBucket {
    Recently,
    WithinWeek,
    WithinMonth,
    LongAgo,
}

/// One watched user's presence. Hidden presence has only a bucket and `online: false`;
/// this suppresses the online indicator without asserting the user is offline.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserPresenceResponse {
    pub uid: i32,
    pub online: bool,
    /// Present only with exact visibility, no active connection, and a fresh connection within its away grace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub away: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_bucket: Option<LastSeenBucket>,
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
    /// Absolute subscription state; omitted only by older servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<crate::dto::threads::ThreadSubscriptionStatusResponse>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatArchiveStateChangedPayload {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub archived: bool,
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
    /// Reader whose cursor advanced. Absent for legacy or privacy invalidations.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_uid: Option<i32>,
    #[serde(
        with = "crate::serde_i64_string::opt",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>)]
    pub thread_root_id: Option<i64>,
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
mod tests;
