/** Generated from OpenRPC by scripts/api-codegen.ts. */
import type * as Shared from '../models';

export type { SnowflakeID } from '../models';
export { RpcErrorCode } from './rpc-error-code';
export type {
  AcknowledgeReactionsBody,
  AddMemberBody,
  ApiPushProvider,
  AttachmentConfigResponse,
  AttachmentResponse,
  AttachmentUploadPurpose,
  AuthTokenResponse,
  AvatarUploadUrlRequest,
  AvatarUploadUrlResponse,
  BlockRequestBody,
  BlockResponse,
  BulkDeleteMessagesBody,
  BulkDeletedPayload,
  ChatArchiveStateChangedPayload,
  ChatAttachmentKindFilter,
  ChatAttachmentResponse,
  ChatListItem,
  ChatMembershipChangedPayload,
  ChatNotificationSettingResponse,
  ChatSettings,
  ConversationCategory,
  ConversationRef,
  ConversationSelector,
  ConversationState,
  ConversationStatesPayload,
  ConversationUnreadErrorPayload,
  ConversationUnreadPayload,
  ConversationUnreadSummary,
  ConversationView,
  CreateChatBody,
  CreateChatResponse,
  CreateFriendRequestBody,
  CreateInviteBody,
  CreateMessageBody,
  CreatePinBody,
  CreateServiceTokenRequest,
  CreateServiceTokenResponse,
  CreateStickerPackBody,
  DevSessionRequest,
  ExternalCreateInviteRequest,
  ExternalCreateInviteResponse,
  ExternalInviteChatResponse,
  ExternalInviteMembershipResponse,
  ExternalInviteStatus,
  FavoriteStickerListResponse,
  ForwardMessageBody,
  ForwardMessagesBody,
  ForwardedFromInfo,
  ForwardedMessagePreviewResponse,
  ForwardedMessageResponse,
  ForwardedMessagesPreviewResponse,
  ForwardedMessagesResponse,
  ForwardedReplyResponse,
  FriendAddInfoResponse,
  FriendAddVerificationMode,
  FriendPresenceOverride,
  FriendPresenceSettingsResponse,
  FriendReadReceiptOverride,
  FriendReadReceiptSettingsResponse,
  FriendRelationshipResponse,
  FriendRequestDirection,
  FriendRequestHistoryEntry,
  FriendRequestReceivedPayload,
  FriendRequestResolvedPayload,
  FriendRequestResponse,
  FriendRequestStatus,
  FriendResponse,
  FriendSettingsResponse,
  FriendshipRemovedPayload,
  GroupInfoResponse,
  GroupKind,
  GroupPresenceResponse,
  GroupRole,
  GroupSearchMode,
  GroupSelectorItem,
  GroupSelectorScope,
  GroupSpeakingModeResponse,
  GroupVisibility,
  InvitePreviewResponse,
  InviteResponse,
  InviteType,
  LastSeenBucket,
  ListBlocksResponse,
  ListChatAttachmentsResponse,
  ListChatThreadsResponse,
  ListChatsResponse,
  ListFriendRequestHistoryResponse,
  ListFriendsResponse,
  ListGroupsResponse,
  ListInvitesResponse,
  ListMembersResponse,
  ListMessagesResponse,
  ListPinsResponse,
  ListSavedMessagesResponse,
  ListServiceTokensResponse,
  ListThreadParticipantsResponse,
  ListThreadsResponse,
  MarkAsReadBody,
  MarkAsUnreadBody,
  MarkChatReadStateResponse,
  MarkThreadReadBody,
  MarkThreadReadResponse,
  MeResponse,
  MemberResponse,
  MemberSpeakingModeResponse,
  MemberSummary,
  MembershipMessagePolicy,
  MembershipMessagePolicyChanged,
  MembershipMessageVisibility,
  MentionBadges,
  MentionInfo,
  MessagePreview,
  MessagePreviewAttachment,
  MessagePreviewSticker,
  MessageResponse,
  MessageSearchSort,
  MessageStickerMediaResponse,
  MessageStickerResponse,
  MessageType,
  MuteBody,
  MuteResponse,
  NotificationException,
  NotificationExceptionsCleared,
  NotificationExceptionsResponse,
  NotificationPayload,
  NotificationSettingMode,
  NotificationSettingsResponse,
  NotificationType,
  OnlineClientConnectionResponse,
  OnlineClientStatus,
  PatchInviteBody,
  PendingFriendRequestCountResponse,
  PinResponse,
  PinUpdatePayload,
  PostStickerMultipart,
  PresenceSettingsResponse,
  PresenceSnapshotPayload,
  PresenceUpdatePayload,
  PresenceVisibility,
  PrivacyException,
  PrivacyExceptionKind,
  PrivacyExceptionsResponse,
  PushEnvironment,
  ReactionDetailGroup,
  ReactionDetailResponse,
  ReactionReactor,
  ReactionSummary,
  ReactionUpdatePayload,
  ReadReceiptChangedPayload,
  ReadReceiptResponse,
  ReadReceiptSettingsResponse,
  ReadReceiptVisibility,
  RedeemInviteBody,
  RedeemInviteResponse,
  RelationshipPendingRequest,
  RelationshipQueryRequest,
  RelationshipQueryResponse,
  RelationshipRequestDirection,
  RelationshipStatus,
  RotateServiceTokenResponse,
  SavedAttachmentSnapshot,
  SavedChatSnapshot,
  SavedMessageResponse,
  SavedSenderSnapshot,
  SavedStickerSnapshot,
  SearchMessagesResponse,
  SearchUsersResponse,
  SendInviteMessageBody,
  SendInviteMessageResponse,
  ServerWsMessage,
  ServiceTokenResponse,
  SessionGenerationResponse,
  SpeakingMode,
  SpeakingRestrictedResponse,
  StickerDetailResponse,
  StickerPackDetailResponse,
  StickerPackDiscoveryItem,
  StickerPackDiscoveryResponse,
  StickerPackListResponse,
  StickerPackOrderItem,
  StickerPackOrderUpdatePayload,
  StickerPackPreviewSticker,
  StickerPackSort,
  StickerPackSummary,
  StickerPackVisibility,
  StickerSummary,
  StickersStickerMediaResponse,
  SubscribeBody,
  SubscribeKeys,
  SubscriptionStatusResponse,
  SystemMessageKind,
  SystemMessageLinks,
  ThreadInfo,
  ThreadListItem,
  ThreadMembershipChangedPayload,
  ThreadOrder,
  ThreadReadStateResponse,
  ThreadSubscriptionStatusResponse,
  ThreadUpdatePayload,
  TicketResponse,
  UnreadCountResponse,
  UnreadMentionIdsResponse,
  UnreadReactionIdsResponse,
  UnreadReactionsAckResponse,
  UnreadThreadCountResponse,
  UnsubscribeBody,
  UpdateChatBody,
  UpdateChatSettings,
  UpdateFriendPresenceSettingsBody,
  UpdateFriendReadReceiptSettingsBody,
  UpdateFriendSettingsBody,
  UpdateMemberBody,
  UpdateMessageBody,
  UpdateNotificationSettingRequest,
  UpdateNotificationSettingsRequest,
  UpdatePresenceSettingsBody,
  UpdateReadReceiptSettingsBody,
  UpdateSpeakingModeRequest,
  UpdateStickerPackBody,
  UpdateStickerPackOrderItem,
  UpdateStickerPackOrderRequest,
  UploadUrlRequest,
  UploadUrlResponse,
  User,
  UserGroupTagInfo,
  UserPresenceResponse,
  UserSearchMode,
  VapidPublicKeyResponse,
} from '../models';

export type AttachmentsCreateUploadUrlParams = {
  contentType: string;
  filename: string;
  height?: number;
  order?: number;
  purpose?: Shared.AttachmentUploadPurpose;
  size: number;
  width?: number;
};
export type AttachmentsGetConfigParams = {};
export type AttachmentsListForChatParams = {
  after?: Shared.SnowflakeID;
  before?: Shared.SnowflakeID;
  chatId: Shared.SnowflakeID;
  kind: Shared.ChatAttachmentKindFilter;
  limit?: number;
};
export type AuthCreateDevSessionParams = { clientId?: string; uid: number };
export type AuthRefreshParams = {};
export type BlocksCreateParams = { uid: number };
export type BlocksDeleteParams = { uid: number };
export type BlocksListParams = {};
export type ChatsAcknowledgeReactionsParams = {
  chatId: Shared.SnowflakeID;
  readThrough?: string;
  threadId?: Shared.SnowflakeID;
};
export type ChatsArchiveParams = { chatId: Shared.SnowflakeID };
export type ChatsGetReadReceiptParams = { chatId: Shared.SnowflakeID; threadId?: Shared.SnowflakeID };
export type ChatsGetTotalUnreadCountParams = {};
export type ChatsGetUnreadCountParams = { chatId: Shared.SnowflakeID };
export type ChatsListMentionsParams = { chatId: Shared.SnowflakeID; max?: number; threadId?: Shared.SnowflakeID };
export type ChatsListParams = {
  after?: Shared.SnowflakeID;
  archived?: boolean;
  chatId?: Shared.SnowflakeID;
  limit?: number;
};
export type ChatsListUnreadReactionsParams = {
  chatId: Shared.SnowflakeID;
  max?: number;
  threadId?: Shared.SnowflakeID;
};
export type ChatsMarkAsReadParams = { chatId: Shared.SnowflakeID; messageId: Shared.SnowflakeID };
export type ChatsMarkAsUnreadParams = { chatId: Shared.SnowflakeID; messageId?: Shared.SnowflakeID };
export type ChatsUnarchiveParams = { chatId: Shared.SnowflakeID };
export type ClearExceptionsQuery = { kind: Shared.GroupKind };
export type ConversationsWatchStatesParams = { conversations: Array<Shared.ConversationRef>; requestId: number };
export type ConversationsWatchUnreadParams = {
  appBadge?: boolean;
  requestId: number;
  views: Array<Shared.ConversationView>;
};
export type CreateStickerFromMessageBody = {
  chatId: Shared.SnowflakeID;
  description?: string;
  emoji: string;
  messageId: Shared.SnowflakeID;
  name?: string;
};
export type ExceptionsQuery = { after?: Shared.SnowflakeID; kind: Shared.GroupKind; limit?: number };
export type FriendsAcceptRequestParams = { requestId: Shared.SnowflakeID };
export type FriendsArchiveRequestParams = { requestId: Shared.SnowflakeID };
export type FriendsCreateRequestParams = { message?: string; toUid: number };
export type FriendsGetAddInfoParams = { uid: number };
export type FriendsGetPendingRequestCountParams = {};
export type FriendsGetPresenceSettingsParams = { uid: number };
export type FriendsGetReadReceiptSettingsParams = { uid: number };
export type FriendsGetRelationshipParams = { uid: number };
export type FriendsGetSettingsParams = {};
export type FriendsListParams = {};
export type FriendsListRequestsParams = { archived?: boolean };
export type FriendsRejectRequestParams = { requestId: Shared.SnowflakeID };
export type FriendsRemoveParams = { uid: number };
export type FriendsUpdatePresenceSettingsParams = { override: Shared.FriendPresenceOverride; uid: number };
export type FriendsUpdateReadReceiptSettingsParams = { override: Shared.FriendReadReceiptOverride; uid: number };
export type FriendsUpdateSettingsParams = { mode: Shared.FriendAddVerificationMode; question?: string };
export type GetInviteByCodeQuery = { inviteCode: string };
export type GroupsAddMemberParams = { chatId: Shared.SnowflakeID; role?: Shared.GroupRole; uid: number };
export type GroupsCreateAvatarUploadUrlParams = {
  chatId: Shared.SnowflakeID;
  contentType: string;
  filename: string;
  height?: number;
  size: number;
  width?: number;
};
export type GroupsCreateParams = { name?: string };
export type GroupsGetParams = { chatId: Shared.SnowflakeID };
export type GroupsListMembersParams = {
  after?: number;
  chatId: Shared.SnowflakeID;
  limit?: number;
  mode?: Shared.UserSearchMode;
  q?: string;
};
export type GroupsListParams = {
  after?: Shared.SnowflakeID;
  limit?: number;
  mode?: Shared.GroupSearchMode;
  q?: string;
  scope?: Shared.GroupSelectorScope;
};
export type GroupsMuteParams = { chatId: Shared.SnowflakeID; durationSeconds?: number };
export type GroupsRemoveMemberParams = { chatId: Shared.SnowflakeID; deleteMessages?: string; uid: number };
export type GroupsUnmuteParams = { chatId: Shared.SnowflakeID };
export type GroupsUpdateMemberParams = { chatId: Shared.SnowflakeID; role: Shared.GroupRole; uid: number };
export type GroupsUpdateMemberSpeakingModeParams = {
  chatId: Shared.SnowflakeID;
  speakingMode: Shared.SpeakingMode;
  uid: number;
};
export type GroupsUpdateNotificationSettingParams = {
  chatId: Shared.SnowflakeID;
  durationSeconds?: number;
  mode: Shared.NotificationSettingMode;
};
export type GroupsUpdateParams = {
  avatarImageId?: Shared.SnowflakeID | null;
  chatId: Shared.SnowflakeID;
  description?: string;
  membershipMessageVisibility?: Shared.MembershipMessageVisibility;
  name?: string;
  visibility?: Shared.GroupVisibility;
};
export type GroupsUpdateSpeakingModeParams = { chatId: Shared.SnowflakeID; speakingMode: Shared.SpeakingMode };
export type InvitesCreateParams = {
  chatId: Shared.SnowflakeID;
  expiresAt?: string;
  inviteType: Shared.InviteType;
  requiredChatId?: Shared.SnowflakeID;
  targetUid?: number;
};
export type InvitesDeleteParams = { inviteId: Shared.SnowflakeID };
export type InvitesGetByCodeParams = { inviteCode: string };
export type InvitesGetParams = { inviteId: Shared.SnowflakeID };
export type InvitesListParams = { groupId?: Shared.SnowflakeID; limit?: number };
export type InvitesRedeemParams = { code: string };
export type InvitesSendParams = {
  clientGeneratedId: string;
  destinationChatId: Shared.SnowflakeID;
  expiresAt?: string;
  inviteId?: Shared.SnowflakeID;
  sourceChatId: Shared.SnowflakeID;
};
export type InvitesUpdateParams = { expiresAt?: string | null; inviteId: Shared.SnowflakeID };
export type ListChatAttachmentsQuery = {
  after?: Shared.SnowflakeID;
  before?: Shared.SnowflakeID;
  kind: Shared.ChatAttachmentKindFilter;
  limit?: number;
};
export type ListChatThreadsQuery = { cursor?: Shared.SnowflakeID; limit?: number; order?: Shared.ThreadOrder };
export type ListChatsQuery = {
  after?: Shared.SnowflakeID;
  archived?: boolean;
  chatId?: Shared.SnowflakeID;
  limit?: number;
};
export type ListFriendRequestsQuery = { archived?: boolean };
export type ListGroupsQuery = {
  after?: Shared.SnowflakeID;
  limit?: number;
  mode?: Shared.GroupSearchMode;
  q?: string;
  scope?: Shared.GroupSelectorScope;
};
export type ListInvitesQuery = { groupId?: Shared.SnowflakeID; limit?: number };
export type ListMembersQuery = { after?: number; limit?: number; mode?: Shared.UserSearchMode; q?: string };
export type ListMessagesQuery = {
  after?: Shared.SnowflakeID;
  around?: Shared.SnowflakeID;
  before?: Shared.SnowflakeID;
  max?: number;
  threadId?: Shared.SnowflakeID;
};
export type ListSavedMessagesQuery = { before?: Shared.SnowflakeID; limit?: number };
export type ListThreadParticipantsQuery = { cursor?: number; limit?: number };
export type ListThreadsQuery = { archived?: boolean; before?: string; limit?: number; rootId?: Shared.SnowflakeID };
export type MessagesDeleteManyParams = { chatId: Shared.SnowflakeID; messageIds: Array<Shared.SnowflakeID> };
export type MessagesDeleteParams = { chatId: Shared.SnowflakeID; messageId: Shared.SnowflakeID };
export type MessagesEditParams = {
  attachmentIds?: Array<Shared.SnowflakeID>;
  chatId: Shared.SnowflakeID;
  message: string;
  messageId: Shared.SnowflakeID;
};
export type MessagesForwardOneParams = {
  allowPlaceholders?: boolean;
  chatId: Shared.SnowflakeID;
  clientGeneratedId: string;
  messageId: Shared.SnowflakeID;
  sourceChatId: Shared.SnowflakeID;
  threadId?: Shared.SnowflakeID;
};
export type MessagesForwardParams = {
  allowPlaceholders?: boolean;
  chatId: Shared.SnowflakeID;
  clientGeneratedId: string;
  messageIds: Array<Shared.SnowflakeID>;
  sourceChatId: Shared.SnowflakeID;
  threadId?: Shared.SnowflakeID;
};
export type MessagesGetParams = { chatId: Shared.SnowflakeID; messageId: Shared.SnowflakeID };
export type MessagesListForwardedBundleMessagesParams = {
  bundleId: Shared.SnowflakeID;
  chatId: Shared.SnowflakeID;
  messageId: Shared.SnowflakeID;
};
export type MessagesListForwardedMessagesParams = { chatId: Shared.SnowflakeID; messageId: Shared.SnowflakeID };
export type MessagesListParams = {
  after?: Shared.SnowflakeID;
  around?: Shared.SnowflakeID;
  before?: Shared.SnowflakeID;
  chatId: Shared.SnowflakeID;
  max?: number;
  threadId?: Shared.SnowflakeID;
};
export type MessagesSearchParams = {
  chatId: Shared.SnowflakeID;
  limit?: number;
  offset?: number;
  q: string;
  sort?: Shared.MessageSearchSort;
};
export type MessagesSendInThreadParams = {
  attachmentIds?: Array<Shared.SnowflakeID>;
  chatId: Shared.SnowflakeID;
  clientGeneratedId: string;
  message?: string;
  messageType: Shared.MessageType;
  replyToId?: Shared.SnowflakeID;
  stickerId?: Shared.SnowflakeID;
  threadId: Shared.SnowflakeID;
};
export type MessagesSendParams = {
  attachmentIds?: Array<Shared.SnowflakeID>;
  chatId: Shared.SnowflakeID;
  clientGeneratedId: string;
  message?: string;
  messageType: Shared.MessageType;
  replyToId?: Shared.SnowflakeID;
  stickerId?: Shared.SnowflakeID;
};
export type PinsCreateForThreadParams = {
  chatId: Shared.SnowflakeID;
  messageId: Shared.SnowflakeID;
  threadRootId: Shared.SnowflakeID;
};
export type PinsCreateParams = { chatId: Shared.SnowflakeID; messageId: Shared.SnowflakeID };
export type PinsDeleteForThreadParams = {
  chatId: Shared.SnowflakeID;
  pinId: Shared.SnowflakeID;
  threadRootId: Shared.SnowflakeID;
};
export type PinsDeleteParams = { chatId: Shared.SnowflakeID; pinId: Shared.SnowflakeID };
export type PinsListForThreadParams = { chatId: Shared.SnowflakeID; threadRootId: Shared.SnowflakeID };
export type PinsListParams = { chatId: Shared.SnowflakeID };
export type PresenceWatchParams = { chatIds?: Array<Shared.SnowflakeID>; requestId?: number; userIds?: Array<number> };
export type PrivacyClearExceptionsParams = { kind: Shared.PrivacyExceptionKind };
export type PrivacyExceptionsQuery = { kind: Shared.PrivacyExceptionKind };
export type PrivacyGetPresenceSettingsParams = {};
export type PrivacyGetReadReceiptSettingsParams = {};
export type PrivacyListExceptionsParams = { kind: Shared.PrivacyExceptionKind };
export type PrivacyUpdatePresenceSettingsParams = { visibility: Shared.PresenceVisibility };
export type PrivacyUpdateReadReceiptSettingsParams = { visibility: Shared.ReadReceiptVisibility };
export type PushGetSubscriptionStatusParams = {
  deviceToken?: string;
  endpoint?: string;
  environment?: Shared.PushEnvironment;
  provider?: Shared.ApiPushProvider;
};
export type PushGetVapidPublicKeyParams = {};
export type PushSubscribeParams = {
  deviceToken?: string;
  endpoint?: string;
  environment?: Shared.PushEnvironment;
  keys?: Shared.SubscribeKeys;
  provider?: Shared.ApiPushProvider;
};
export type PushUnsubscribeParams = {
  deviceToken?: string;
  endpoint?: string;
  environment?: Shared.PushEnvironment;
  provider?: Shared.ApiPushProvider;
};
export type ReactionsAddParams = { chatId: Shared.SnowflakeID; emoji: string; messageId: Shared.SnowflakeID };
export type ReactionsListParams = { chatId: Shared.SnowflakeID; messageId: Shared.SnowflakeID };
export type ReactionsRemoveParams = { chatId: Shared.SnowflakeID; emoji: string; messageId: Shared.SnowflakeID };
export type ReadReceiptQuery = { threadId?: Shared.SnowflakeID };
export type RemoveMemberQuery = { deleteMessages?: string };
export type SavedMessagesDeleteByMessageParams = { messageId: Shared.SnowflakeID };
export type SavedMessagesDeleteParams = { savedMessageId: Shared.SnowflakeID };
export type SavedMessagesListForChatParams = {
  before?: Shared.SnowflakeID;
  chatId: Shared.SnowflakeID;
  limit?: number;
};
export type SavedMessagesListForwardedBundleMessagesParams = {
  bundleId: Shared.SnowflakeID;
  savedMessageId: Shared.SnowflakeID;
};
export type SavedMessagesListForwardedMessagesParams = { savedMessageId: Shared.SnowflakeID };
export type SavedMessagesListParams = { before?: Shared.SnowflakeID; limit?: number };
export type SavedMessagesSaveParams = { messageId: Shared.SnowflakeID };
export type SearchMessagesQuery = { limit?: number; offset?: number; q: string; sort?: Shared.MessageSearchSort };
export type SearchUsersQuery = { excludeMemberOf?: Shared.SnowflakeID; limit?: number; q?: string };
export type ServiceTokensCreateParams = { name: string; policyIds?: Array<string> };
export type ServiceTokensDeleteParams = { id: Shared.SnowflakeID };
export type ServiceTokensListParams = {};
export type ServiceTokensRotateParams = { id: Shared.SnowflakeID };
export type SessionInvalidatedNotification = { reason: SessionInvalidatedReason };
export type SessionInvalidatedReason = 'revoked';
export type SessionOpenParams = { appVersion?: string; protocolVersion: number; token?: string };
export type SessionOpenResult =
  | { authenticated: true; clientId: string; protocolVersion: 1; uid: number }
  | { authenticated: false; protocolVersion: 1 };
export type SessionPingParams = { state?: Shared.OnlineClientStatus };
export type SessionSetAppStateParams = { state?: Shared.OnlineClientStatus };
export type SessionUnavailableNotification = { reason: SessionUnavailableReason };
export type SessionUnavailableReason = 'authLookupUnavailable';
export type SessionsListClientsParams = {};
export type StickerPackDiscoveryQuery = { limit?: number; offset?: number; q?: string; sort?: Shared.StickerPackSort };
export type StickersAddToPackParams = { packId: Shared.SnowflakeID; stickerId: Shared.SnowflakeID };
export type StickersCreateFromMessageParams = {
  chatId: Shared.SnowflakeID;
  description?: string;
  emoji: string;
  messageId: Shared.SnowflakeID;
  name?: string;
  packId: Shared.SnowflakeID;
};
export type StickersCreatePackParams = {
  description?: string;
  name: string;
  visibility?: Shared.StickerPackVisibility;
};
export type StickersDeletePackParams = { packId: Shared.SnowflakeID };
export type StickersFavoriteParams = { stickerId: Shared.SnowflakeID };
export type StickersGetPackParams = { packId: Shared.SnowflakeID };
export type StickersGetParams = { stickerId: Shared.SnowflakeID };
export type StickersListFavoritesParams = {};
export type StickersListOwnedPacksParams = {};
export type StickersListPacksParams = { limit?: number; offset?: number; q?: string; sort?: Shared.StickerPackSort };
export type StickersListSubscribedPacksParams = {};
export type StickersRemoveFromPackParams = { packId: Shared.SnowflakeID; stickerId: Shared.SnowflakeID };
export type StickersSubscribeToPackParams = { packId: Shared.SnowflakeID };
export type StickersUnfavoriteParams = { stickerId: Shared.SnowflakeID };
export type StickersUnsubscribeFromPackParams = { packId: Shared.SnowflakeID };
export type StickersUpdatePackParams = {
  description?: string;
  name?: string;
  packId: Shared.SnowflakeID;
  visibility?: Shared.StickerPackVisibility;
};
export type SubscriptionStatusQuery = {
  deviceToken?: string;
  endpoint?: string;
  environment?: Shared.PushEnvironment;
  provider?: Shared.ApiPushProvider;
};
export type ThreadsArchiveParams = { chatId: Shared.SnowflakeID; threadRootId: Shared.SnowflakeID };
export type ThreadsGetReadStateParams = { chatId: Shared.SnowflakeID; threadRootId: Shared.SnowflakeID };
export type ThreadsGetSubscriptionStatusParams = { chatId: Shared.SnowflakeID; threadRootId: Shared.SnowflakeID };
export type ThreadsGetUnreadCountParams = {};
export type ThreadsListForChatParams = {
  chatId: Shared.SnowflakeID;
  cursor?: Shared.SnowflakeID;
  limit?: number;
  order?: Shared.ThreadOrder;
};
export type ThreadsListParams = { archived?: boolean; before?: string; limit?: number; rootId?: Shared.SnowflakeID };
export type ThreadsListParticipantsParams = {
  chatId: Shared.SnowflakeID;
  cursor?: number;
  limit?: number;
  threadRootId: Shared.SnowflakeID;
};
export type ThreadsMarkAsReadParams = {
  chatId: Shared.SnowflakeID;
  messageId: Shared.SnowflakeID;
  threadRootId: Shared.SnowflakeID;
};
export type ThreadsSubscribeParams = { chatId: Shared.SnowflakeID; threadRootId: Shared.SnowflakeID };
export type ThreadsUnarchiveParams = { chatId: Shared.SnowflakeID; threadRootId: Shared.SnowflakeID };
export type ThreadsUnsubscribeParams = { chatId: Shared.SnowflakeID; threadRootId: Shared.SnowflakeID };
export type UnreadMentionsQuery = { max?: number; threadId?: Shared.SnowflakeID };
export type UsersClearNotificationExceptionsParams = { kind: Shared.GroupKind };
export type UsersGetMeParams = {};
export type UsersGetNotificationSettingsParams = {};
export type UsersListNotificationExceptionsParams = {
  after?: Shared.SnowflakeID;
  kind: Shared.GroupKind;
  limit?: number;
};
export type UsersSearchParams = { excludeMemberOf?: Shared.SnowflakeID; limit?: number; q?: string };
export type UsersUpdateChatSettingsParams = { showMembershipMessages: boolean };
export type UsersUpdateNotificationSettingsParams = {
  muteDirectChatsByDefault?: boolean;
  muteGroupChatsByDefault?: boolean;
};
export type UsersUpdateStickerPackOrderParams = { order: Array<Shared.UpdateStickerPackOrderItem> };
