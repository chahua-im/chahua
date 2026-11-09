mod attachments;
mod blocks;
mod chats;
mod control;
mod friends;
mod groups;
mod invites;
mod messages;
mod pins;
mod privacy;
mod push;
mod reactions;
mod saved_messages;
mod service_tokens;
mod sessions;
mod stickers;
mod threads;
mod users;

use serde_json::Value;
use tracing::Instrument;
use utoipa::{
    openapi::{schema::Schema, RefOr},
    ToSchema,
};

use super::error::{RpcError, RpcErrorCode, RpcLifecycleFailure};
use super::protocol::{decode_params, RpcCall, RpcResponse};
use super::{RpcCallContext, RpcServices};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionClass {
    Read,
    Mutation,
    Session,
    Control,
}

pub struct SchemaSet {
    pub name: String,
    pub schema: RefOr<Schema>,
    pub dependencies: Vec<(String, RefOr<Schema>)>,
}

pub struct MethodMetadata {
    pub name: &'static str,
    pub execution_class: ExecutionClass,
    pub params: fn() -> SchemaSet,
    pub result: fn() -> SchemaSet,
}

fn schema_for<T: ToSchema>() -> SchemaSet {
    let mut dependencies = Vec::new();
    T::schemas(&mut dependencies);
    SchemaSet {
        name: T::name().into_owned(),
        schema: T::schema(),
        dependencies,
    }
}

macro_rules! register_methods {
    ($(($name:literal, $params:ty, $result:ty, $class:ident, $handler:path)),+ $(,)?) => {
        pub fn method_metadata() -> &'static [MethodMetadata] {
            &[$( MethodMetadata {
                name: $name,
                execution_class: ExecutionClass::$class,
                params: schema_for::<$params>,
                result: schema_for::<$result>,
            }, )+]
        }

        pub fn method_class(method: &str) -> Option<ExecutionClass> {
            match method {
                $( $name => Some(ExecutionClass::$class), )+
                _ => None,
            }
        }

        pub fn registered_name(method: &str) -> &'static str {
            match method { $( $name => $name, )+ _ => "unknown" }
        }

        async fn dispatch_registered(context: &RpcCallContext, services: &RpcServices, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
            match method {
                $( $name => {
                    let params: $params = decode_params(params)?;
                    let result: $result = $handler(context, services, params).await.map_err(RpcError::from)?;
                    serde_json::to_value(result).map_err(|error| {
                        tracing::error!(?error, "RPC result serialization failed");
                        RpcError::new(RpcErrorCode::DispatcherInternal)
                    })
                }, )+
                _ => Err(RpcError::new(RpcErrorCode::MethodNotFound)),
            }
        }
    };
}

register_methods! {
    ("session.open", crate::dto::rpc::session::SessionOpenParams, crate::dto::rpc::session::SessionOpenResult, Session, control::open),
    ("auth.createDevSession", crate::dto::rpc::auth::AuthCreateDevSessionParams, crate::dto::auth::AuthTokenResponse, Session, control::create_dev_session),
    ("auth.refresh", crate::dto::rpc::auth::AuthRefreshParams, crate::dto::auth::AuthTokenResponse, Session, control::refresh),
    ("session.ping", crate::dto::rpc::session::SessionPingParams, (), Control, control::ping),
    ("session.setAppState", crate::dto::rpc::session::SessionSetAppStateParams, (), Control, control::set_app_state),
    ("presence.watch", crate::dto::rpc::presence::PresenceWatchParams, (), Control, control::watch_presence),
    ("conversations.watchUnread", crate::dto::rpc::conversations::ConversationsWatchUnreadParams, (), Control, control::watch_unread),
    ("conversations.watchStates", crate::dto::rpc::conversations::ConversationsWatchStatesParams, (), Control, control::watch_states),
("messages.list", crate::dto::rpc::messages::MessagesListParams, crate::dto::messages::ListMessagesResponse, Read, messages::list),
("messages.send", crate::dto::rpc::messages::MessagesSendParams, crate::dto::messages::MessageResponse, Mutation, messages::send),
("messages.searchAll", crate::dto::messages::SearchMessagesQuery, crate::dto::messages::SearchMessagesResponse, Read, messages::search_all),
("messages.search", crate::dto::rpc::messages::MessagesSearchParams, crate::dto::messages::SearchMessagesResponse, Read, messages::search),
("messages.get", crate::dto::rpc::messages::MessagesGetParams, crate::dto::messages::MessageResponse, Read, messages::get),
("messages.edit", crate::dto::rpc::messages::MessagesEditParams, crate::dto::messages::MessageResponse, Mutation, messages::edit),
("messages.delete", crate::dto::rpc::messages::MessagesDeleteParams, (), Mutation, messages::delete),
("messages.deleteMany", crate::dto::rpc::messages::MessagesDeleteManyParams, crate::dto::ws::BulkDeletedPayload, Mutation, messages::delete_many),
("messages.forward", crate::dto::rpc::messages::MessagesForwardParams, crate::dto::messages::MessageResponse, Mutation, messages::forward),
("messages.forwardOne", crate::dto::rpc::messages::MessagesForwardOneParams, crate::dto::messages::MessageResponse, Mutation, messages::forward_one),
("messages.listForwardedMessages", crate::dto::rpc::messages::MessagesListForwardedMessagesParams, crate::dto::messages::ForwardedMessagesResponse, Read, messages::list_forwarded_messages),
("messages.listForwardedBundleMessages", crate::dto::rpc::messages::MessagesListForwardedBundleMessagesParams, crate::dto::messages::ForwardedMessagesResponse, Read, messages::list_forwarded_bundle_messages),
("messages.sendInThread", crate::dto::rpc::messages::MessagesSendInThreadParams, crate::dto::messages::MessageResponse, Mutation, messages::send_in_thread),
("reactions.list", crate::dto::rpc::reactions::ReactionsListParams, crate::dto::messages::ReactionDetailResponse, Read, reactions::list),
("reactions.add", crate::dto::rpc::reactions::ReactionsAddParams, (), Mutation, reactions::add),
("reactions.remove", crate::dto::rpc::reactions::ReactionsRemoveParams, (), Mutation, reactions::remove),
("pins.list", crate::dto::rpc::pins::PinsListParams, crate::dto::pins::ListPinsResponse, Read, pins::list),
("pins.create", crate::dto::rpc::pins::PinsCreateParams, crate::dto::pins::PinResponse, Mutation, pins::create),
("pins.delete", crate::dto::rpc::pins::PinsDeleteParams, (), Mutation, pins::delete),
("pins.listForThread", crate::dto::rpc::pins::PinsListForThreadParams, crate::dto::pins::ListPinsResponse, Read, pins::list_for_thread),
("pins.createForThread", crate::dto::rpc::pins::PinsCreateForThreadParams, crate::dto::pins::PinResponse, Mutation, pins::create_for_thread),
("pins.deleteForThread", crate::dto::rpc::pins::PinsDeleteForThreadParams, (), Mutation, pins::delete_for_thread),
("savedMessages.listForChat", crate::dto::rpc::saved_messages::SavedMessagesListForChatParams, crate::dto::saved_messages::ListSavedMessagesResponse, Read, saved_messages::list_for_chat),
("savedMessages.list", crate::dto::rpc::saved_messages::SavedMessagesListParams, crate::dto::saved_messages::ListSavedMessagesResponse, Read, saved_messages::list),
("savedMessages.save", crate::dto::rpc::saved_messages::SavedMessagesSaveParams, crate::dto::saved_messages::SavedMessageResponse, Mutation, saved_messages::save),
("savedMessages.deleteByMessage", crate::dto::rpc::saved_messages::SavedMessagesDeleteByMessageParams, (), Mutation, saved_messages::delete_by_message),
("savedMessages.delete", crate::dto::rpc::saved_messages::SavedMessagesDeleteParams, (), Mutation, saved_messages::delete),
("savedMessages.listForwardedMessages", crate::dto::rpc::saved_messages::SavedMessagesListForwardedMessagesParams, crate::dto::messages::ForwardedMessagesResponse, Read, saved_messages::list_forwarded_messages),
("savedMessages.listForwardedBundleMessages", crate::dto::rpc::saved_messages::SavedMessagesListForwardedBundleMessagesParams, crate::dto::messages::ForwardedMessagesResponse, Read, saved_messages::list_forwarded_bundle_messages),
("chats.list", crate::dto::rpc::chats::ChatsListParams, crate::dto::chats::ListChatsResponse, Read, chats::list),
("chats.getTotalUnreadCount", crate::dto::rpc::chats::ChatsGetTotalUnreadCountParams, crate::dto::chats::UnreadCountResponse, Read, chats::get_total_unread_count),
("chats.archive", crate::dto::rpc::chats::ChatsArchiveParams, (), Mutation, chats::archive),
("chats.unarchive", crate::dto::rpc::chats::ChatsUnarchiveParams, (), Mutation, chats::unarchive),
("chats.markAsRead", crate::dto::rpc::chats::ChatsMarkAsReadParams, crate::dto::chats::MarkChatReadStateResponse, Mutation, chats::mark_as_read),
("chats.markAsUnread", crate::dto::rpc::chats::ChatsMarkAsUnreadParams, crate::dto::chats::MarkChatReadStateResponse, Mutation, chats::mark_as_unread),
("chats.getUnreadCount", crate::dto::rpc::chats::ChatsGetUnreadCountParams, crate::dto::chats::MarkChatReadStateResponse, Read, chats::get_unread_count),
("chats.getReadReceipt", crate::dto::rpc::chats::ChatsGetReadReceiptParams, crate::dto::read_receipts::ReadReceiptResponse, Read, chats::get_read_receipt),
("chats.listMentions", crate::dto::rpc::chats::ChatsListMentionsParams, crate::dto::chats::UnreadMentionIdsResponse, Read, chats::list_mentions),
("chats.listUnreadReactions", crate::dto::rpc::chats::ChatsListUnreadReactionsParams, crate::dto::chats::UnreadReactionIdsResponse, Read, chats::list_unread_reactions),
("chats.acknowledgeReactions", crate::dto::rpc::chats::ChatsAcknowledgeReactionsParams, crate::dto::chats::UnreadReactionsAckResponse, Mutation, chats::acknowledge_reactions),
("threads.list", crate::dto::rpc::threads::ThreadsListParams, crate::dto::threads::ListThreadsResponse, Read, threads::list),
("threads.getUnreadCount", crate::dto::rpc::threads::ThreadsGetUnreadCountParams, crate::dto::threads::UnreadThreadCountResponse, Read, threads::get_unread_count),
("threads.listForChat", crate::dto::rpc::threads::ThreadsListForChatParams, crate::dto::threads::ListChatThreadsResponse, Read, threads::list_for_chat),
("threads.listParticipants", crate::dto::rpc::threads::ThreadsListParticipantsParams, crate::dto::threads::ListThreadParticipantsResponse, Read, threads::list_participants),
("threads.markAsRead", crate::dto::rpc::threads::ThreadsMarkAsReadParams, crate::dto::threads::MarkThreadReadResponse, Mutation, threads::mark_as_read),
("threads.getReadState", crate::dto::rpc::threads::ThreadsGetReadStateParams, crate::dto::threads::ThreadReadStateResponse, Read, threads::get_read_state),
("threads.getSubscriptionStatus", crate::dto::rpc::threads::ThreadsGetSubscriptionStatusParams, crate::dto::threads::ThreadSubscriptionStatusResponse, Read, threads::get_subscription_status),
("threads.subscribe", crate::dto::rpc::threads::ThreadsSubscribeParams, (), Mutation, threads::subscribe),
("threads.unsubscribe", crate::dto::rpc::threads::ThreadsUnsubscribeParams, (), Mutation, threads::unsubscribe),
("threads.archive", crate::dto::rpc::threads::ThreadsArchiveParams, (), Mutation, threads::archive),
("threads.unarchive", crate::dto::rpc::threads::ThreadsUnarchiveParams, (), Mutation, threads::unarchive),
("attachments.listForChat", crate::dto::rpc::attachments::AttachmentsListForChatParams, crate::dto::attachments::ListChatAttachmentsResponse, Read, attachments::list_for_chat),
("attachments.createUploadUrl", crate::dto::rpc::attachments::AttachmentsCreateUploadUrlParams, crate::dto::attachments::UploadUrlResponse, Mutation, attachments::create_upload_url),
("attachments.getConfig", crate::dto::rpc::attachments::AttachmentsGetConfigParams, crate::dto::attachments::AttachmentConfigResponse, Read, attachments::get_config),
("groups.list", crate::dto::rpc::groups::GroupsListParams, crate::dto::groups::ListGroupsResponse, Read, groups::list),
("groups.create", crate::dto::rpc::groups::GroupsCreateParams, crate::dto::groups::CreateChatResponse, Mutation, groups::create),
("groups.get", crate::dto::rpc::groups::GroupsGetParams, crate::dto::groups::GroupInfoResponse, Read, groups::get),
("groups.update", crate::dto::rpc::groups::GroupsUpdateParams, crate::dto::groups::GroupInfoResponse, Mutation, groups::update),
("groups.createAvatarUploadUrl", crate::dto::rpc::groups::GroupsCreateAvatarUploadUrlParams, crate::dto::groups::AvatarUploadUrlResponse, Mutation, groups::create_avatar_upload_url),
("groups.mute", crate::dto::rpc::groups::GroupsMuteParams, crate::dto::groups::MuteResponse, Mutation, groups::mute),
("groups.unmute", crate::dto::rpc::groups::GroupsUnmuteParams, (), Mutation, groups::unmute),
("groups.updateNotificationSetting", crate::dto::rpc::groups::GroupsUpdateNotificationSettingParams, crate::dto::groups::ChatNotificationSettingResponse, Mutation, groups::update_notification_setting),
("groups.updateSpeakingMode", crate::dto::rpc::groups::GroupsUpdateSpeakingModeParams, crate::dto::speaking::GroupSpeakingModeResponse, Mutation, groups::update_speaking_mode),
("groups.listMembers", crate::dto::rpc::groups::GroupsListMembersParams, crate::dto::members::ListMembersResponse, Read, groups::list_members),
("groups.addMember", crate::dto::rpc::groups::GroupsAddMemberParams, crate::dto::members::MemberResponse, Mutation, groups::add_member),
("groups.removeMember", crate::dto::rpc::groups::GroupsRemoveMemberParams, (), Mutation, groups::remove_member),
("groups.updateMember", crate::dto::rpc::groups::GroupsUpdateMemberParams, crate::dto::members::MemberResponse, Mutation, groups::update_member),
("groups.updateMemberSpeakingMode", crate::dto::rpc::groups::GroupsUpdateMemberSpeakingModeParams, crate::dto::speaking::MemberSpeakingModeResponse, Mutation, groups::update_member_speaking_mode),
("invites.list", crate::dto::rpc::invites::InvitesListParams, crate::dto::invites::ListInvitesResponse, Read, invites::list),
("invites.create", crate::dto::rpc::invites::InvitesCreateParams, crate::dto::invites::InviteResponse, Mutation, invites::create),
("invites.send", crate::dto::rpc::invites::InvitesSendParams, crate::dto::invites::SendInviteMessageResponse, Mutation, invites::send),
("invites.get", crate::dto::rpc::invites::InvitesGetParams, crate::dto::invites::InviteResponse, Read, invites::get),
("invites.getByCode", crate::dto::rpc::invites::InvitesGetByCodeParams, crate::dto::invites::InvitePreviewResponse, Read, invites::get_by_code),
("invites.update", crate::dto::rpc::invites::InvitesUpdateParams, crate::dto::invites::InviteResponse, Mutation, invites::update),
("invites.delete", crate::dto::rpc::invites::InvitesDeleteParams, (), Mutation, invites::delete),
("invites.redeem", crate::dto::rpc::invites::InvitesRedeemParams, crate::dto::invites::RedeemInviteResponse, Mutation, invites::redeem),
("friends.list", crate::dto::rpc::friends::FriendsListParams, crate::dto::friends::ListFriendsResponse, Read, friends::list),
("friends.getRelationship", crate::dto::rpc::friends::FriendsGetRelationshipParams, crate::dto::friends::FriendRelationshipResponse, Read, friends::get_relationship),
("friends.remove", crate::dto::rpc::friends::FriendsRemoveParams, (), Mutation, friends::remove),
("friends.createRequest", crate::dto::rpc::friends::FriendsCreateRequestParams, crate::dto::friends::FriendRequestResponse, Mutation, friends::create_request),
("friends.listRequests", crate::dto::rpc::friends::FriendsListRequestsParams, crate::dto::friends::ListFriendRequestHistoryResponse, Read, friends::list_requests),
("friends.getPendingRequestCount", crate::dto::rpc::friends::FriendsGetPendingRequestCountParams, crate::dto::friends::PendingFriendRequestCountResponse, Read, friends::get_pending_request_count),
("friends.acceptRequest", crate::dto::rpc::friends::FriendsAcceptRequestParams, crate::dto::friends::FriendRequestResponse, Mutation, friends::accept_request),
("friends.rejectRequest", crate::dto::rpc::friends::FriendsRejectRequestParams, crate::dto::friends::FriendRequestResponse, Mutation, friends::reject_request),
("friends.archiveRequest", crate::dto::rpc::friends::FriendsArchiveRequestParams, (), Mutation, friends::archive_request),
("friends.getSettings", crate::dto::rpc::friends::FriendsGetSettingsParams, crate::dto::friends::FriendSettingsResponse, Read, friends::get_settings),
("friends.updateSettings", crate::dto::rpc::friends::FriendsUpdateSettingsParams, crate::dto::friends::FriendSettingsResponse, Mutation, friends::update_settings),
("friends.getAddInfo", crate::dto::rpc::friends::FriendsGetAddInfoParams, crate::dto::friends::FriendAddInfoResponse, Read, friends::get_add_info),
("friends.getPresenceSettings", crate::dto::rpc::friends::FriendsGetPresenceSettingsParams, crate::dto::friends::FriendPresenceSettingsResponse, Read, friends::get_presence_settings),
("friends.updatePresenceSettings", crate::dto::rpc::friends::FriendsUpdatePresenceSettingsParams, crate::dto::friends::FriendPresenceSettingsResponse, Mutation, friends::update_presence_settings),
("friends.getReadReceiptSettings", crate::dto::rpc::friends::FriendsGetReadReceiptSettingsParams, crate::dto::friends::FriendReadReceiptSettingsResponse, Read, friends::get_read_receipt_settings),
("friends.updateReadReceiptSettings", crate::dto::rpc::friends::FriendsUpdateReadReceiptSettingsParams, crate::dto::friends::FriendReadReceiptSettingsResponse, Mutation, friends::update_read_receipt_settings),
("privacy.getPresenceSettings", crate::dto::rpc::privacy::PrivacyGetPresenceSettingsParams, crate::dto::friends::PresenceSettingsResponse, Read, privacy::get_presence_settings),
("privacy.updatePresenceSettings", crate::dto::rpc::privacy::PrivacyUpdatePresenceSettingsParams, crate::dto::friends::PresenceSettingsResponse, Mutation, privacy::update_presence_settings),
("privacy.getReadReceiptSettings", crate::dto::rpc::privacy::PrivacyGetReadReceiptSettingsParams, crate::dto::friends::ReadReceiptSettingsResponse, Read, privacy::get_read_receipt_settings),
("privacy.updateReadReceiptSettings", crate::dto::rpc::privacy::PrivacyUpdateReadReceiptSettingsParams, crate::dto::friends::ReadReceiptSettingsResponse, Mutation, privacy::update_read_receipt_settings),
("privacy.listExceptions", crate::dto::rpc::privacy::PrivacyListExceptionsParams, crate::dto::friends::PrivacyExceptionsResponse, Read, privacy::list_exceptions),
("privacy.clearExceptions", crate::dto::rpc::privacy::PrivacyClearExceptionsParams, (), Mutation, privacy::clear_exceptions),
("blocks.list", crate::dto::rpc::blocks::BlocksListParams, crate::dto::blocks::ListBlocksResponse, Read, blocks::list),
("blocks.create", crate::dto::rpc::blocks::BlocksCreateParams, (), Mutation, blocks::create),
("blocks.delete", crate::dto::rpc::blocks::BlocksDeleteParams, (), Mutation, blocks::delete),
("users.getMe", crate::dto::rpc::users::UsersGetMeParams, crate::dto::users::MeResponse, Read, users::get_me),
("users.updateStickerPackOrder", crate::dto::rpc::users::UsersUpdateStickerPackOrderParams, (), Mutation, users::update_sticker_pack_order),
("users.updateChatSettings", crate::dto::rpc::users::UsersUpdateChatSettingsParams, crate::dto::users::ChatSettings, Mutation, users::update_chat_settings),
("users.search", crate::dto::rpc::users::UsersSearchParams, crate::dto::users::SearchUsersResponse, Read, users::search),
("users.getNotificationSettings", crate::dto::rpc::users::UsersGetNotificationSettingsParams, crate::dto::users::NotificationSettingsResponse, Read, users::get_notification_settings),
("users.updateNotificationSettings", crate::dto::rpc::users::UsersUpdateNotificationSettingsParams, crate::dto::users::NotificationSettingsResponse, Mutation, users::update_notification_settings),
("users.listNotificationExceptions", crate::dto::rpc::users::UsersListNotificationExceptionsParams, crate::dto::groups::NotificationExceptionsResponse, Read, users::list_notification_exceptions),
("users.clearNotificationExceptions", crate::dto::rpc::users::UsersClearNotificationExceptionsParams, crate::dto::groups::NotificationExceptionsCleared, Mutation, users::clear_notification_exceptions),
("push.getVapidPublicKey", crate::dto::rpc::push::PushGetVapidPublicKeyParams, crate::dto::push::VapidPublicKeyResponse, Read, push::get_vapid_public_key),
("push.getSubscriptionStatus", crate::dto::rpc::push::PushGetSubscriptionStatusParams, crate::dto::push::SubscriptionStatusResponse, Read, push::get_subscription_status),
("push.subscribe", crate::dto::rpc::push::PushSubscribeParams, (), Mutation, push::subscribe),
("push.unsubscribe", crate::dto::rpc::push::PushUnsubscribeParams, (), Mutation, push::unsubscribe),
("stickers.listPacks", crate::dto::rpc::stickers::StickersListPacksParams, crate::dto::stickers::StickerPackDiscoveryResponse, Read, stickers::list_packs),
("stickers.createFromMessage", crate::dto::rpc::stickers::StickersCreateFromMessageParams, crate::dto::stickers::StickerSummary, Mutation, stickers::create_from_message),
("stickers.createPack", crate::dto::rpc::stickers::StickersCreatePackParams, crate::dto::stickers::StickerPackSummary, Mutation, stickers::create_pack),
("stickers.getPack", crate::dto::rpc::stickers::StickersGetPackParams, crate::dto::stickers::StickerPackDetailResponse, Read, stickers::get_pack),
("stickers.updatePack", crate::dto::rpc::stickers::StickersUpdatePackParams, crate::dto::stickers::StickerPackSummary, Mutation, stickers::update_pack),
("stickers.deletePack", crate::dto::rpc::stickers::StickersDeletePackParams, (), Mutation, stickers::delete_pack),
("stickers.listSubscribedPacks", crate::dto::rpc::stickers::StickersListSubscribedPacksParams, crate::dto::stickers::StickerPackListResponse, Read, stickers::list_subscribed_packs),
("stickers.listOwnedPacks", crate::dto::rpc::stickers::StickersListOwnedPacksParams, crate::dto::stickers::StickerPackListResponse, Read, stickers::list_owned_packs),
("stickers.subscribeToPack", crate::dto::rpc::stickers::StickersSubscribeToPackParams, (), Mutation, stickers::subscribe_to_pack),
("stickers.unsubscribeFromPack", crate::dto::rpc::stickers::StickersUnsubscribeFromPackParams, (), Mutation, stickers::unsubscribe_from_pack),
("stickers.addToPack", crate::dto::rpc::stickers::StickersAddToPackParams, (), Mutation, stickers::add_to_pack),
("stickers.removeFromPack", crate::dto::rpc::stickers::StickersRemoveFromPackParams, (), Mutation, stickers::remove_from_pack),
("stickers.get", crate::dto::rpc::stickers::StickersGetParams, crate::dto::stickers::StickerDetailResponse, Read, stickers::get),
("stickers.favorite", crate::dto::rpc::stickers::StickersFavoriteParams, (), Mutation, stickers::favorite),
("stickers.unfavorite", crate::dto::rpc::stickers::StickersUnfavoriteParams, (), Mutation, stickers::unfavorite),
("stickers.listFavorites", crate::dto::rpc::stickers::StickersListFavoritesParams, crate::dto::stickers::FavoriteStickerListResponse, Read, stickers::list_favorites),
("serviceTokens.create", crate::dto::rpc::service_tokens::ServiceTokensCreateParams, crate::dto::service_tokens::CreateServiceTokenResponse, Mutation, service_tokens::create),
("serviceTokens.list", crate::dto::rpc::service_tokens::ServiceTokensListParams, crate::dto::service_tokens::ListServiceTokensResponse, Read, service_tokens::list),
("serviceTokens.delete", crate::dto::rpc::service_tokens::ServiceTokensDeleteParams, (), Mutation, service_tokens::delete),
("serviceTokens.rotate", crate::dto::rpc::service_tokens::ServiceTokensRotateParams, crate::dto::service_tokens::RotateServiceTokenResponse, Mutation, service_tokens::rotate),
("sessions.listClients", crate::dto::rpc::sessions::SessionsListClientsParams, Vec<crate::dto::ws::OnlineClientConnectionResponse>, Read, sessions::list_clients),
}

/// Dispatch decoded requests without any transport, socket, or HTTP dependency.
/// Ordinary application operations acquire/drop their connections inside a blocking
/// worker; mixed async/DB operations run through the runtime handle in that worker.
pub async fn dispatch_call(
    context: &RpcCallContext,
    call: RpcCall,
    services: &RpcServices,
) -> (Option<RpcResponse>, Option<RpcErrorCode>) {
    let RpcCall { id, method, params } = call;
    let class = method_class(&method);
    let registered_method = registered_name(&method);
    let span = tracing::debug_span!(
        "rpc_request",
        connection_id = context.connection_id,
        rpc_id = ?id,
        method = registered_method
    );
    let result = async {
        if context.session.is_none()
            && method != "session.open"
            && method != "auth.createDevSession"
        {
            return Err(RpcError::with_message(
                RpcErrorCode::Unauthorized,
                "Authentication required",
            ));
        }
        match class {
            Some(ExecutionClass::Session | ExecutionClass::Control) => {
                dispatch_registered(context, services, &method, params).await
            }
            Some(ExecutionClass::Read | ExecutionClass::Mutation) => {
                let context = context.clone();
                let services = services.clone();
                let runtime = tokio::runtime::Handle::current();
                let queue =
                    services
                        .metrics
                        .api
                        .start_stage("rpc", registered_method, "blocking_queue");
                tokio::task::spawn_blocking(move || {
                    drop(queue);
                    let stages = services.metrics.api.stages("rpc", registered_method);
                    let authentication = stages.start("authentication");
                    let session = context.verified_session().map_err(RpcError::from)?;
                    if let Err(failure) =
                        crate::services::authentication::check_session_generation_cause(
                            session,
                            &services.token_generation,
                            &services.db,
                        )
                    {
                        let failure = RpcLifecycleFailure::from(failure);
                        if context.rpc_id.is_none() {
                            if let Some(guard_failures) = &context.guard_failures {
                                let _ = guard_failures.send(failure);
                            }
                        }
                        return Err(RpcError::from(failure));
                    }
                    drop(authentication);
                    let activity = stages.start("activity");
                    services
                        .client_tracking
                        .record_activity(session.uid, &session.client_id, None)
                        .map_err(RpcError::from)?;
                    drop(activity);
                    let _handler = stages.start("handler");
                    runtime.block_on(dispatch_registered(&context, &services, &method, params))
                })
                .await
                .map_err(|error| {
                    tracing::error!(?error, "RPC dispatcher worker failed");
                    RpcError::new(RpcErrorCode::DispatcherInternal)
                })?
            }
            None => Err(RpcError::new(RpcErrorCode::MethodNotFound)),
        }
    }
    .instrument(span)
    .await;
    let error_code = result.as_ref().err().map(|error| error.code);
    (
        id.map(|id| match result {
            Ok(value) => RpcResponse::success(id, value),
            Err(error) => RpcResponse::error(id, error),
        }),
        error_code,
    )
}
