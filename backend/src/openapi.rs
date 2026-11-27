use crate::dto::attachments::ChatAttachmentKindFilter;
use crate::dto::conversations::ConversationView;
use crate::dto::groups::{GroupSearchMode, GroupSelectorScope};
use crate::dto::threads::ThreadOrder;
use crate::dto::ws::{
    ChatArchiveStateChangedPayload, FriendRequestReceivedPayload, FriendRequestResolvedPayload,
    FriendshipRemovedPayload, GroupPresenceResponse, PinUpdatePayload, PresenceSnapshotPayload,
    PresenceUpdatePayload, ReactionUpdatePayload, ReadReceiptChangedPayload, ServerWsMessage,
    ThreadMembershipChangedPayload, ThreadUpdatePayload, UserPresenceResponse,
};
use crate::services::{message_search::MessageSearchSort, user::UserSearchMode};
use serde_json::Value;
use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Wetty Chat API",
        version = "0.1.0",
        description = "Real-time chat application backend API supporting groups, messaging, threads, stickers, invites, and push notifications.",
        license(name = "GPL-3.0", url = "https://www.gnu.org/licenses/gpl-3.0.html"),
    ),
    components(
        schemas(
            crate::dto::friends::PrivacyExceptionKind,
            ChatAttachmentKindFilter,
            ConversationView,
            MessageSearchSort,
            crate::dto::stickers::StickerPackSort,
            GroupSearchMode,
            GroupSelectorScope,
            UserSearchMode,
            ThreadOrder,
            ServerWsMessage,
            crate::dto::speaking::SpeakingRestrictedResponse,
            ReactionUpdatePayload,
            PresenceUpdatePayload,
            PresenceSnapshotPayload,
            UserPresenceResponse,
            GroupPresenceResponse,
            ThreadUpdatePayload,
            ThreadMembershipChangedPayload,
            ChatArchiveStateChangedPayload,
            ReadReceiptChangedPayload,
            PinUpdatePayload,
            FriendRequestReceivedPayload,
            FriendRequestResolvedPayload,
            FriendshipRemovedPayload,
        )
    ),
    modifiers(&SecurityAddon),
)]
pub struct ApiDoc;

struct SecurityAddon;

impl utoipa::Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "bearer_jwt",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
        components.add_security_scheme(
            "service_token_bearer",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
    }
}

/// Returns the complete HTTP OpenAPI document without initializing runtime
/// configuration or application services.
pub fn document() -> utoipa::openapi::OpenApi {
    let mut document = ApiDoc::openapi();
    document.merge(crate::handlers::api_router().into_openapi());
    apply_snowflake_markers(&mut document);
    document
}

/// This manifest marks only fields that are serialized as decimal Snowflake
/// strings. It deliberately excludes user IDs, counters, and control IDs.
const SNOWFLAKE_COMPONENT_FIELDS: &[(&str, &[&str])] = &[
    ("AttachmentResponse", &["id"]),
    ("AttachmentSnapshot", &["id"]),
    ("ChatAttachmentResponse", &["id", "messageId"]),
    (
        "ListChatAttachmentsResponse",
        &["olderCursor", "newerCursor"],
    ),
    ("UploadUrlResponse", &["attachmentId"]),
    (
        "ChatListItem",
        &["id", "lastReadMessageId", "peerLastReadMessageId"],
    ),
    ("ListChatsResponse", &["nextCursor"]),
    ("ListSyncRemoval", &["chatId", "threadId"]),
    ("MarkChatReadStateResponse", &["lastReadMessageId"]),
    ("UnreadMentionIdsResponse", &["messageIds"]),
    ("UnreadReactionIdsResponse", &["messageIds"]),
    ("ConversationRef", &["chatId", "threadId"]),
    ("MainUnreadChat", &["chatId"]),
    ("GroupPresenceResponse", &["chatId"]),
    ("ConversationState", &["lastReadMessageId"]),
    ("AcknowledgeReactionsBody", &["threadId"]),
    ("FriendRelationshipResponse", &["dmChatId"]),
    ("FriendRequestResponse", &["id"]),
    ("RelationshipPendingRequest", &["id"]),
    ("RelationshipStatus", &["dmChatId"]),
    ("CreateChatResponse", &["id"]),
    ("GroupInfoResponse", &["id", "avatarImageId"]),
    ("GroupSelectorItem", &["id"]),
    ("ListGroupsResponse", &["nextCursor"]),
    ("AvatarUploadUrlResponse", &["imageId"]),
    ("ChatNotificationSettingResponse", &["chatId"]),
    ("NotificationExceptionsResponse", &["nextCursor"]),
    ("MembershipMessagePolicyChanged", &["chatId"]),
    ("InviteResponse", &["id", "chatId", "requiredChatId"]),
    ("ExternalCreateInviteRequest", &["chatId"]),
    ("ExternalInviteChatResponse", &["id", "avatarImageId"]),
    (
        "CreateMessageBody",
        &["stickerId", "replyToId", "attachmentIds"],
    ),
    ("UpdateMessageBody", &["attachmentIds"]),
    ("BulkDeleteMessagesBody", &["messageIds"]),
    (
        "BulkDeletedPayload",
        &["chatId", "messageIds", "threadRootIds"],
    ),
    ("SystemMessageLinks", &["messageId"]),
    (
        "ForwardedFromInfo",
        &["originalChatId", "originalMessageId"],
    ),
    (
        "MessageResponse",
        &["id", "replyRootId", "chatId", "forwardedBundleId"],
    ),
    (
        "ForwardMessagesBody",
        &["sourceChatId", "messageIds", "threadId"],
    ),
    ("ForwardMessageBody", &["sourceChatId", "threadId"]),
    (
        "ForwardedMessagePreviewResponse",
        &["originalMessageId", "originalChatId"],
    ),
    (
        "ForwardedMessagePreviewSnapshot",
        &["originalMessageId", "originalChatId"],
    ),
    (
        "ForwardedMessageSnapshot",
        &["originalMessageId", "originalChatId"],
    ),
    ("ForwardedStickerSnapshot", &["id", "mediaId"]),
    ("ForwardedReplySnapshot", &["originalMessageId"]),
    ("ForwardedReplyResponse", &["originalMessageId"]),
    (
        "ForwardedBundleRefSnapshot",
        &["originalMessageId", "originalChatId", "forwardedBundleId"],
    ),
    (
        "ForwardedMessageResponse",
        &["originalMessageId", "originalChatId", "forwardedBundleId"],
    ),
    (
        "ListMessagesResponse",
        &["nextCursor", "prevCursor", "olderCursor", "newerCursor"],
    ),
    ("MessagePreview", &["id"]),
    ("MessageStickerMediaResponse", &["id"]),
    ("MessageStickerResponse", &["id"]),
    ("CreatePinBody", &["messageId"]),
    ("PinResponse", &["id", "chatId", "threadRootId"]),
    ("ReadReceiptResponse", &["lastReadMessageId"]),
    ("SavedAttachmentSnapshot", &["id"]),
    ("SavedStickerSnapshot", &["id"]),
    ("SavedChatSnapshot", &["id"]),
    (
        "SavedMessageResponse",
        &[
            "id",
            "originalChatId",
            "originalThreadRootId",
            "originalMessageId",
            "originalReplyToMessageId",
            "forwardedBundleId",
        ],
    ),
    ("ListSavedMessagesResponse", &["nextCursor"]),
    ("NotificationExceptionsCleared", &["chatIds"]),
    ("ServiceTokenResponse", &["id"]),
    ("GroupSpeakingModeResponse", &["chatId"]),
    ("MemberSpeakingModeResponse", &["chatId"]),
    ("StickersStickerMediaResponse", &["id"]),
    ("StickerSummary", &["id"]),
    ("StickerDetailResponse", &["id"]),
    ("StickerPackPreviewSticker", &["id"]),
    ("StickerPackSummary", &["id"]),
    ("StickerPackDetailResponse", &["id"]),
    ("StickerPackDiscoveryItem", &["id"]),
    ("StickerPackOrderItem", &["stickerPackId"]),
    ("UpdateStickerPackOrderItem", &["stickerPackId"]),
    (
        "ThreadListItem",
        &["chatId", "lastReadMessageId", "peerLastReadMessageId"],
    ),
    ("ListChatThreadsResponse", &["nextCursor"]),
    ("MarkThreadReadResponse", &["lastReadMessageId"]),
    ("ThreadReadStateResponse", &["lastReadMessageId"]),
    ("SearchUsersQuery", &["excludeMemberOf"]),
    ("ChatMembershipChangedPayload", &["chatId"]),
    ("MessageSyncChat", &["chatId"]),
    ("MessageSyncResumeParams", &["priorityChatId"]),
    (
        "MessageSyncPageParams",
        &["chatId", "threadId", "before", "after", "around"],
    ),
    ("MessageSyncBatch", &["chatId"]),
    ("MessageSyncChange", &["messageId", "threadRootId"]),
    ("MessageSyncReady", &["chatId"]),
    ("MessageSyncReset", &["chatId"]),
    ("MessageSyncRevoked", &["chatId"]),
    ("MessageSyncPageResult", &["chatId"]),
    ("ReactionUpdatePayload", &["messageId", "chatId"]),
    ("ThreadUpdatePayload", &["threadRootId", "chatId"]),
    (
        "ThreadMembershipChangedPayload",
        &["threadRootId", "chatId"],
    ),
    ("ChatArchiveStateChangedPayload", &["chatId"]),
    ("ReadReceiptChangedPayload", &["chatId", "threadRootId"]),
    (
        "PinUpdatePayload",
        &["chatId", "pinId", "messageId", "threadRootId"],
    ),
    ("FriendRequestResolvedPayload", &["requestId"]),
    (
        "NotificationPayload",
        &["chatId", "messageId", "threadRootId"],
    ),
];

fn apply_snowflake_markers(document: &mut utoipa::openapi::OpenApi) {
    let mut value = serde_json::to_value(&*document).expect("OpenAPI document is serializable");
    let schemas = value
        .pointer_mut("/components/schemas")
        .and_then(Value::as_object_mut)
        .expect("OpenAPI document has schema components");

    for (component, fields) in SNOWFLAKE_COMPONENT_FIELDS {
        if let Some(schema) = schemas.get_mut(*component) {
            mark_snowflake_component_fields(schema, fields);
        }
    }

    *document = serde_json::from_value(value).expect("marked OpenAPI document is valid");
}

pub(crate) fn mark_snowflake_component_fields(schema: &mut Value, fields: &[&str]) {
    fn mark_fields(schema: &mut Value, fields: &[&str]) {
        let Some(object) = schema.as_object_mut() else {
            return;
        };
        if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
            for field in fields {
                if let Some(schema) = properties.get_mut(*field) {
                    mark_snowflake_schema(schema);
                }
            }
        }
        for key in ["allOf", "oneOf", "anyOf"] {
            if let Some(variants) = object.get_mut(key).and_then(Value::as_array_mut) {
                for variant in variants {
                    mark_fields(variant, fields);
                }
            }
        }
    }

    mark_fields(schema, fields);
}

pub(crate) fn apply_snowflake_component_markers(
    schemas: &mut std::collections::BTreeMap<String, Value>,
) {
    for (component, fields) in SNOWFLAKE_COMPONENT_FIELDS {
        if let Some(schema) = schemas.get_mut(*component) {
            mark_snowflake_component_fields(schema, fields);
        }
    }
}

fn mark_snowflake_schema(schema: &mut Value) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    if let Some(items) = object.get_mut("items") {
        mark_snowflake_schema(items);
        return;
    }
    if object.contains_key("type") {
        object.insert("x-snowflake-id".to_owned(), Value::Bool(true));
        return;
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(variants) = object.get_mut(key).and_then(Value::as_array_mut) {
            for variant in variants {
                if variant.get("type") == Some(&Value::String("string".to_owned())) {
                    mark_snowflake_schema(variant);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
