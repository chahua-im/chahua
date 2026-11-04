/** Generated from OpenRPC by scripts/api-codegen.ts. */
import type { JsonCodec } from './json-codecs';
import type * as Shared from './models';
import type {
  AttachmentsCreateUploadUrlParams,
  AttachmentsGetConfigParams,
  AttachmentsListForChatParams,
  AuthCreateDevSessionParams,
  AuthRefreshParams,
  BlocksCreateParams,
  BlocksDeleteParams,
  BlocksListParams,
  ChatsAcknowledgeReactionsParams,
  ChatsArchiveParams,
  ChatsGetReadReceiptParams,
  ChatsGetTotalUnreadCountParams,
  ChatsGetUnreadCountParams,
  ChatsListMentionsParams,
  ChatsListParams,
  ChatsListUnreadReactionsParams,
  ChatsMarkAsReadParams,
  ChatsMarkAsUnreadParams,
  ChatsUnarchiveParams,
  ClearExceptionsQuery,
  ConversationsWatchStatesParams,
  ConversationsWatchUnreadParams,
  CreateStickerFromMessageBody,
  ExceptionsQuery,
  FriendsAcceptRequestParams,
  FriendsArchiveRequestParams,
  FriendsCreateRequestParams,
  FriendsGetAddInfoParams,
  FriendsGetPendingRequestCountParams,
  FriendsGetPresenceSettingsParams,
  FriendsGetReadReceiptSettingsParams,
  FriendsGetRelationshipParams,
  FriendsGetSettingsParams,
  FriendsListParams,
  FriendsListRequestsParams,
  FriendsRejectRequestParams,
  FriendsRemoveParams,
  FriendsUpdatePresenceSettingsParams,
  FriendsUpdateReadReceiptSettingsParams,
  FriendsUpdateSettingsParams,
  GetInviteByCodeQuery,
  GroupsAddMemberParams,
  GroupsCreateAvatarUploadUrlParams,
  GroupsCreateParams,
  GroupsGetParams,
  GroupsListMembersParams,
  GroupsListParams,
  GroupsMuteParams,
  GroupsRemoveMemberParams,
  GroupsUnmuteParams,
  GroupsUpdateMemberParams,
  GroupsUpdateMemberSpeakingModeParams,
  GroupsUpdateNotificationSettingParams,
  GroupsUpdateParams,
  GroupsUpdateSpeakingModeParams,
  InvitesCreateParams,
  InvitesDeleteParams,
  InvitesGetByCodeParams,
  InvitesGetParams,
  InvitesListParams,
  InvitesRedeemParams,
  InvitesSendParams,
  InvitesUpdateParams,
  ListChatAttachmentsQuery,
  ListChatThreadsQuery,
  ListChatsQuery,
  ListFriendRequestsQuery,
  ListGroupsQuery,
  ListInvitesQuery,
  ListMembersQuery,
  ListMessagesQuery,
  ListSavedMessagesQuery,
  ListThreadParticipantsQuery,
  ListThreadsQuery,
  MessagesDeleteManyParams,
  MessagesDeleteParams,
  MessagesEditParams,
  MessagesForwardOneParams,
  MessagesForwardParams,
  MessagesGetParams,
  MessagesListForwardedBundleMessagesParams,
  MessagesListForwardedMessagesParams,
  MessagesListParams,
  MessagesSearchParams,
  MessagesSendInThreadParams,
  MessagesSendParams,
  PinsCreateForThreadParams,
  PinsCreateParams,
  PinsDeleteForThreadParams,
  PinsDeleteParams,
  PinsListForThreadParams,
  PinsListParams,
  PresenceWatchParams,
  PrivacyClearExceptionsParams,
  PrivacyExceptionsQuery,
  PrivacyGetPresenceSettingsParams,
  PrivacyGetReadReceiptSettingsParams,
  PrivacyListExceptionsParams,
  PrivacyUpdatePresenceSettingsParams,
  PrivacyUpdateReadReceiptSettingsParams,
  PushGetSubscriptionStatusParams,
  PushGetVapidPublicKeyParams,
  PushSubscribeParams,
  PushUnsubscribeParams,
  ReactionsAddParams,
  ReactionsListParams,
  ReactionsRemoveParams,
  ReadReceiptQuery,
  RemoveMemberQuery,
  SavedMessagesDeleteByMessageParams,
  SavedMessagesDeleteParams,
  SavedMessagesListForChatParams,
  SavedMessagesListForwardedBundleMessagesParams,
  SavedMessagesListForwardedMessagesParams,
  SavedMessagesListParams,
  SavedMessagesSaveParams,
  SearchMessagesQuery,
  SearchUsersQuery,
  ServiceTokensCreateParams,
  ServiceTokensDeleteParams,
  ServiceTokensListParams,
  ServiceTokensRotateParams,
  SessionInvalidatedNotification,
  SessionInvalidatedReason,
  SessionOpenParams,
  SessionOpenResult,
  SessionPingParams,
  SessionSetAppStateParams,
  SessionUnavailableNotification,
  SessionUnavailableReason,
  SessionsListClientsParams,
  StickerPackDiscoveryQuery,
  StickersAddToPackParams,
  StickersCreateFromMessageParams,
  StickersCreatePackParams,
  StickersDeletePackParams,
  StickersFavoriteParams,
  StickersGetPackParams,
  StickersGetParams,
  StickersListFavoritesParams,
  StickersListOwnedPacksParams,
  StickersListPacksParams,
  StickersListSubscribedPacksParams,
  StickersRemoveFromPackParams,
  StickersSubscribeToPackParams,
  StickersUnfavoriteParams,
  StickersUnsubscribeFromPackParams,
  StickersUpdatePackParams,
  SubscriptionStatusQuery,
  ThreadsArchiveParams,
  ThreadsGetReadStateParams,
  ThreadsGetSubscriptionStatusParams,
  ThreadsGetUnreadCountParams,
  ThreadsListForChatParams,
  ThreadsListParams,
  ThreadsListParticipantsParams,
  ThreadsMarkAsReadParams,
  ThreadsSubscribeParams,
  ThreadsUnarchiveParams,
  ThreadsUnsubscribeParams,
  UnreadMentionsQuery,
  UsersClearNotificationExceptionsParams,
  UsersGetMeParams,
  UsersGetNotificationSettingsParams,
  UsersListNotificationExceptionsParams,
  UsersSearchParams,
  UsersUpdateChatSettingsParams,
  UsersUpdateNotificationSettingsParams,
  UsersUpdateStickerPackOrderParams,
} from './rpc-models';

export type RpcMethodClass = 'read' | 'mutation' | 'session' | 'control';
export type RpcMethodCodec = { params?: JsonCodec; result?: JsonCodec };
export const rpcSchemas: Record<string, JsonCodec> = {
  AcknowledgeReactionsBody: {
    threadId: 1,
  },
  AddMemberBody: {
    role: 'GroupRole',
  },
  AttachmentResponse: {
    id: 1,
  },
  AttachmentsCreateUploadUrlParams: {
    purpose: 'AttachmentUploadPurpose',
  },
  AttachmentsListForChatParams: {
    after: 1,
    before: 1,
    chatId: 1,
    kind: 'ChatAttachmentKindFilter',
  },
  AvatarUploadUrlResponse: {
    imageId: 1,
  },
  BlockResponse: {
    user: 'MemberSummary',
  },
  BulkDeleteMessagesBody: {
    messageIds: [1],
  },
  BulkDeletedPayload: {
    chatId: 1,
    messageIds: [1],
    threadRootIds: [1],
  },
  ChatArchiveStateChangedPayload: {
    chatId: 1,
  },
  ChatAttachmentResponse: {
    id: 1,
    messageId: 1,
    sender: 'User',
  },
  ChatListItem: {
    id: 1,
    kind: 'GroupKind',
    lastMessage: 'MessagePreview',
    lastReadMessageId: 1,
    membershipMessagePolicy: 'MembershipMessagePolicy',
    peer: 'MemberSummary',
    peerLastReadMessageId: 1,
  },
  ChatMembershipChangedPayload: {
    chatId: 1,
  },
  ChatNotificationSettingResponse: {
    chatId: 1,
    kind: 'GroupKind',
  },
  ChatsAcknowledgeReactionsParams: {
    chatId: 1,
    threadId: 1,
  },
  ChatsArchiveParams: {
    chatId: 1,
  },
  ChatsGetReadReceiptParams: {
    chatId: 1,
    threadId: 1,
  },
  ChatsGetUnreadCountParams: {
    chatId: 1,
  },
  ChatsListMentionsParams: {
    chatId: 1,
    threadId: 1,
  },
  ChatsListParams: {
    after: 1,
    chatId: 1,
  },
  ChatsListUnreadReactionsParams: {
    chatId: 1,
    threadId: 1,
  },
  ChatsMarkAsReadParams: {
    chatId: 1,
    messageId: 1,
  },
  ChatsMarkAsUnreadParams: {
    chatId: 1,
    messageId: 1,
  },
  ChatsUnarchiveParams: {
    chatId: 1,
  },
  ClearExceptionsQuery: {
    kind: 'GroupKind',
  },
  ConversationRef: {
    chatId: 1,
    threadId: 1,
  },
  ConversationSelector: {
    categories: ['ConversationCategory'],
    exclude: ['ConversationRef'],
    include: ['ConversationRef'],
  },
  ConversationState: {
    chatId: 1,
    lastReadMessageId: 1,
    threadId: 1,
  },
  ConversationStatesPayload: {
    states: ['ConversationState'],
  },
  ConversationUnreadPayload: {
    summaries: ['ConversationUnreadSummary'],
  },
  ConversationView: {
    selector: 'ConversationSelector',
  },
  ConversationsWatchStatesParams: {
    conversations: ['ConversationRef'],
  },
  ConversationsWatchUnreadParams: {
    views: ['ConversationView'],
  },
  CreateChatResponse: {
    id: 1,
  },
  CreateInviteBody: {
    chatId: 1,
    inviteType: 'InviteType',
    requiredChatId: 1,
  },
  CreateMessageBody: {
    attachmentIds: [1],
    messageType: 'MessageType',
    replyToId: 1,
    stickerId: 1,
  },
  CreatePinBody: {
    messageId: 1,
  },
  CreateServiceTokenResponse: {
    serviceToken: 'ServiceTokenResponse',
  },
  CreateStickerFromMessageBody: {
    chatId: 1,
    messageId: 1,
  },
  ExceptionsQuery: {
    after: 1,
    kind: 'GroupKind',
  },
  ExternalCreateInviteRequest: {
    chatId: 1,
  },
  ExternalCreateInviteResponse: {
    chat: 'ExternalInviteChatResponse',
    invite: 'InviteResponse',
    membership: 'ExternalInviteMembershipResponse',
    status: 'ExternalInviteStatus',
  },
  ExternalInviteChatResponse: {
    avatarImageId: 1,
    id: 1,
    visibility: 'GroupVisibility',
  },
  ExternalInviteMembershipResponse: {
    role: 'GroupRole',
  },
  FavoriteStickerListResponse: {
    stickers: ['StickerSummary'],
  },
  ForwardMessageBody: {
    sourceChatId: 1,
    threadId: 1,
  },
  ForwardMessagesBody: {
    messageIds: [1],
    sourceChatId: 1,
    threadId: 1,
  },
  ForwardedFromInfo: {
    originalChatId: 1,
    originalMessageId: 1,
    originalReplyTo: 'MessagePreview',
    sender: 'User',
  },
  ForwardedMessagePreviewResponse: {
    attachments: ['MessagePreviewAttachment'],
    mentions: ['MentionInfo'],
    messageType: 'MessageType',
    originalChatId: 1,
    originalMessageId: 1,
    sender: 'User',
    sticker: 'MessagePreviewSticker',
  },
  ForwardedMessageResponse: {
    attachments: ['AttachmentResponse'],
    forwardedBundleId: 1,
    forwardedPreview: 'ForwardedMessagesPreviewResponse',
    mentions: ['MentionInfo'],
    messageType: 'MessageType',
    originalChatId: 1,
    originalMessageId: 1,
    reply: 'ForwardedReplyResponse',
    sender: 'User',
    sticker: 'MessageStickerResponse',
  },
  ForwardedMessagesPreviewResponse: {
    messages: ['ForwardedMessagePreviewResponse'],
  },
  ForwardedMessagesResponse: {
    messages: ['ForwardedMessageResponse'],
  },
  ForwardedReplyResponse: {
    originalMessageId: 1,
    preview: 'ForwardedMessagePreviewResponse',
  },
  FriendAddInfoResponse: {
    mode: 'FriendAddVerificationMode',
  },
  FriendPresenceSettingsResponse: {
    override: 'FriendPresenceOverride',
  },
  FriendReadReceiptSettingsResponse: {
    override: 'FriendReadReceiptOverride',
  },
  FriendRelationshipResponse: {
    dmChatId: 1,
  },
  FriendRequestHistoryEntry: {
    direction: 'FriendRequestDirection',
    from: 'MemberSummary',
    id: 1,
    status: 'FriendRequestStatus',
    to: 'MemberSummary',
  },
  FriendRequestResolvedPayload: {
    requestId: 1,
    status: 'FriendRequestStatus',
  },
  FriendRequestResponse: {
    from: 'MemberSummary',
    id: 1,
    status: 'FriendRequestStatus',
    to: 'MemberSummary',
  },
  FriendResponse: {
    user: 'MemberSummary',
  },
  FriendSettingsResponse: {
    mode: 'FriendAddVerificationMode',
  },
  FriendsAcceptRequestParams: {
    requestId: 1,
  },
  FriendsArchiveRequestParams: {
    requestId: 1,
  },
  FriendsRejectRequestParams: {
    requestId: 1,
  },
  FriendsUpdatePresenceSettingsParams: {
    override: 'FriendPresenceOverride',
  },
  FriendsUpdateReadReceiptSettingsParams: {
    override: 'FriendReadReceiptOverride',
  },
  FriendsUpdateSettingsParams: {
    mode: 'FriendAddVerificationMode',
  },
  GroupInfoResponse: {
    avatarImageId: 1,
    effectiveSpeakingMode: 'SpeakingMode',
    id: 1,
    kind: 'GroupKind',
    membershipMessagePolicy: 'MembershipMessagePolicy',
    myRole: 'GroupRole',
    mySpeakingMode: 'SpeakingMode',
    peer: 'MemberSummary',
    speakingMode: 'SpeakingMode',
    visibility: 'GroupVisibility',
  },
  GroupPresenceResponse: {
    chatId: 1,
  },
  GroupSelectorItem: {
    id: 1,
    role: 'GroupRole',
    visibility: 'GroupVisibility',
  },
  GroupSpeakingModeResponse: {
    chatId: 1,
    speakingMode: 'SpeakingMode',
  },
  GroupsAddMemberParams: {
    chatId: 1,
    role: 'GroupRole',
  },
  GroupsCreateAvatarUploadUrlParams: {
    chatId: 1,
  },
  GroupsGetParams: {
    chatId: 1,
  },
  GroupsListMembersParams: {
    chatId: 1,
    mode: 'UserSearchMode',
  },
  GroupsListParams: {
    after: 1,
    mode: 'GroupSearchMode',
    scope: 'GroupSelectorScope',
  },
  GroupsMuteParams: {
    chatId: 1,
  },
  GroupsRemoveMemberParams: {
    chatId: 1,
  },
  GroupsUnmuteParams: {
    chatId: 1,
  },
  GroupsUpdateMemberParams: {
    chatId: 1,
    role: 'GroupRole',
  },
  GroupsUpdateMemberSpeakingModeParams: {
    chatId: 1,
    speakingMode: 'SpeakingMode',
  },
  GroupsUpdateNotificationSettingParams: {
    chatId: 1,
    mode: 'NotificationSettingMode',
  },
  GroupsUpdateParams: {
    avatarImageId: 1,
    chatId: 1,
    membershipMessageVisibility: 'MembershipMessageVisibility',
    visibility: 'GroupVisibility',
  },
  GroupsUpdateSpeakingModeParams: {
    chatId: 1,
    speakingMode: 'SpeakingMode',
  },
  InvitePreviewResponse: {
    chat: 'GroupInfoResponse',
    invite: 'InviteResponse',
  },
  InviteResponse: {
    chatId: 1,
    id: 1,
    inviteType: 'InviteType',
    requiredChatId: 1,
  },
  InvitesCreateParams: {
    chatId: 1,
    inviteType: 'InviteType',
    requiredChatId: 1,
  },
  InvitesDeleteParams: {
    inviteId: 1,
  },
  InvitesGetParams: {
    inviteId: 1,
  },
  InvitesListParams: {
    groupId: 1,
  },
  InvitesSendParams: {
    destinationChatId: 1,
    inviteId: 1,
    sourceChatId: 1,
  },
  InvitesUpdateParams: {
    inviteId: 1,
  },
  ListBlocksResponse: {
    blocks: ['BlockResponse'],
  },
  ListChatAttachmentsQuery: {
    after: 1,
    before: 1,
    kind: 'ChatAttachmentKindFilter',
  },
  ListChatAttachmentsResponse: {
    attachments: ['ChatAttachmentResponse'],
    newerCursor: 1,
    olderCursor: 1,
  },
  ListChatThreadsQuery: {
    cursor: 1,
    order: 'ThreadOrder',
  },
  ListChatThreadsResponse: {
    nextCursor: 1,
    threads: ['MessageResponse'],
  },
  ListChatsQuery: {
    after: 1,
    chatId: 1,
  },
  ListChatsResponse: {
    chatSettings: 'ChatSettings',
    chats: ['ChatListItem'],
    nextCursor: 1,
  },
  ListFriendRequestHistoryResponse: {
    requests: ['FriendRequestHistoryEntry'],
  },
  ListFriendsResponse: {
    friends: ['FriendResponse'],
  },
  ListGroupsQuery: {
    after: 1,
    mode: 'GroupSearchMode',
    scope: 'GroupSelectorScope',
  },
  ListGroupsResponse: {
    groups: ['GroupSelectorItem'],
    nextCursor: 1,
  },
  ListInvitesQuery: {
    groupId: 1,
  },
  ListInvitesResponse: {
    invites: ['InviteResponse'],
  },
  ListMembersQuery: {
    mode: 'UserSearchMode',
  },
  ListMembersResponse: {
    members: ['MemberResponse'],
  },
  ListMessagesQuery: {
    after: 1,
    around: 1,
    before: 1,
    threadId: 1,
  },
  ListMessagesResponse: {
    chatSettings: 'ChatSettings',
    membershipMessagePolicy: 'MembershipMessagePolicy',
    messages: ['MessageResponse'],
    newerCursor: 1,
    nextCursor: 1,
    olderCursor: 1,
    prevCursor: 1,
  },
  ListPinsResponse: {
    pins: ['PinResponse'],
  },
  ListSavedMessagesQuery: {
    before: 1,
  },
  ListSavedMessagesResponse: {
    nextCursor: 1,
    savedMessages: ['SavedMessageResponse'],
  },
  ListServiceTokensResponse: {
    serviceTokens: ['ServiceTokenResponse'],
  },
  ListThreadParticipantsResponse: {
    participants: ['User'],
  },
  ListThreadsQuery: {
    rootId: 1,
  },
  ListThreadsResponse: {
    threads: ['ThreadListItem'],
  },
  MarkAsReadBody: {
    messageId: 1,
  },
  MarkAsUnreadBody: {
    messageId: 1,
  },
  MarkChatReadStateResponse: {
    lastReadMessageId: 1,
  },
  MarkThreadReadBody: {
    messageId: 1,
  },
  MarkThreadReadResponse: {
    lastReadMessageId: 1,
  },
  MeResponse: {
    stickerPackOrder: ['StickerPackOrderItem'],
    userGroup: 'UserGroupTagInfo',
  },
  MemberResponse: {
    role: 'GroupRole',
    speakingMode: 'SpeakingMode',
    userGroup: 'UserGroupTagInfo',
  },
  MemberSpeakingModeResponse: {
    chatId: 1,
    effectiveSpeakingMode: 'SpeakingMode',
    groupSpeakingMode: 'SpeakingMode',
    role: 'GroupRole',
    speakingMode: 'SpeakingMode',
  },
  MemberSummary: {
    userGroup: 'UserGroupTagInfo',
  },
  MembershipMessagePolicy: {
    visibility: 'MembershipMessageVisibility',
  },
  MembershipMessagePolicyChanged: {
    chatId: 1,
  },
  MentionInfo: {
    userGroup: 'UserGroupTagInfo',
  },
  MessagePreview: {
    attachments: ['MessagePreviewAttachment'],
    id: 1,
    mentions: ['MentionInfo'],
    messageType: 'MessageType',
    sender: 'User',
    sticker: 'MessagePreviewSticker',
    systemKind: 'SystemMessageKind',
    systemLinks: 'SystemMessageLinks',
  },
  MessageResponse: {
    attachments: ['AttachmentResponse'],
    chatId: 1,
    forwardedBundleId: 1,
    forwardedFrom: 'ForwardedFromInfo',
    forwardedPreview: 'ForwardedMessagesPreviewResponse',
    id: 1,
    mentions: ['MentionInfo'],
    messageType: 'MessageType',
    reactions: ['ReactionSummary'],
    replyRootId: 1,
    replyToMessage: 'MessagePreview',
    sender: 'User',
    sticker: 'MessageStickerResponse',
    systemKind: 'SystemMessageKind',
    systemLinks: 'SystemMessageLinks',
    threadInfo: 'ThreadInfo',
  },
  MessageStickerMediaResponse: {
    id: 1,
  },
  MessageStickerResponse: {
    id: 1,
    media: 'MessageStickerMediaResponse',
  },
  MessagesDeleteManyParams: {
    chatId: 1,
    messageIds: [1],
  },
  MessagesDeleteParams: {
    chatId: 1,
    messageId: 1,
  },
  MessagesEditParams: {
    attachmentIds: [1],
    chatId: 1,
    messageId: 1,
  },
  MessagesForwardOneParams: {
    chatId: 1,
    messageId: 1,
    sourceChatId: 1,
    threadId: 1,
  },
  MessagesForwardParams: {
    chatId: 1,
    messageIds: [1],
    sourceChatId: 1,
    threadId: 1,
  },
  MessagesGetParams: {
    chatId: 1,
    messageId: 1,
  },
  MessagesListForwardedBundleMessagesParams: {
    bundleId: 1,
    chatId: 1,
    messageId: 1,
  },
  MessagesListForwardedMessagesParams: {
    chatId: 1,
    messageId: 1,
  },
  MessagesListParams: {
    after: 1,
    around: 1,
    before: 1,
    chatId: 1,
    threadId: 1,
  },
  MessagesSearchParams: {
    chatId: 1,
    sort: 'MessageSearchSort',
  },
  MessagesSendInThreadParams: {
    attachmentIds: [1],
    chatId: 1,
    messageType: 'MessageType',
    replyToId: 1,
    stickerId: 1,
    threadId: 1,
  },
  MessagesSendParams: {
    attachmentIds: [1],
    chatId: 1,
    messageType: 'MessageType',
    replyToId: 1,
    stickerId: 1,
  },
  NotificationException: {
    chatId: 1,
    kind: 'GroupKind',
    peer: 'MemberSummary',
  },
  NotificationExceptionsCleared: {
    chatIds: [1],
    kind: 'GroupKind',
  },
  NotificationExceptionsResponse: {
    exceptions: ['NotificationException'],
    nextCursor: 1,
  },
  NotificationPayload: {
    chatId: 1,
    messageId: 1,
    notificationType: 'NotificationType',
    threadRootId: 1,
  },
  OnlineClientConnectionResponse: {
    status: 'OnlineClientStatus',
  },
  PinResponse: {
    chatId: 1,
    id: 1,
    message: 'MessageResponse',
    threadRootId: 1,
  },
  PinUpdatePayload: {
    chatId: 1,
    messageId: 1,
    pin: 'PinResponse',
    pinId: 1,
    threadRootId: 1,
  },
  PinsCreateForThreadParams: {
    chatId: 1,
    messageId: 1,
    threadRootId: 1,
  },
  PinsCreateParams: {
    chatId: 1,
    messageId: 1,
  },
  PinsDeleteForThreadParams: {
    chatId: 1,
    pinId: 1,
    threadRootId: 1,
  },
  PinsDeleteParams: {
    chatId: 1,
    pinId: 1,
  },
  PinsListForThreadParams: {
    chatId: 1,
    threadRootId: 1,
  },
  PinsListParams: {
    chatId: 1,
  },
  PresenceSettingsResponse: {
    visibility: 'PresenceVisibility',
  },
  PresenceSnapshotPayload: {
    groups: ['GroupPresenceResponse'],
    users: ['UserPresenceResponse'],
  },
  PresenceWatchParams: {
    chatIds: [1],
  },
  PrivacyClearExceptionsParams: {
    kind: 'PrivacyExceptionKind',
  },
  PrivacyException: {
    user: 'MemberSummary',
  },
  PrivacyExceptionsQuery: {
    kind: 'PrivacyExceptionKind',
  },
  PrivacyExceptionsResponse: {
    exceptions: ['PrivacyException'],
  },
  PrivacyListExceptionsParams: {
    kind: 'PrivacyExceptionKind',
  },
  PrivacyUpdatePresenceSettingsParams: {
    visibility: 'PresenceVisibility',
  },
  PrivacyUpdateReadReceiptSettingsParams: {
    visibility: 'ReadReceiptVisibility',
  },
  PushGetSubscriptionStatusParams: {
    environment: 'PushEnvironment',
    provider: 'ApiPushProvider',
  },
  PushSubscribeParams: {
    environment: 'PushEnvironment',
    keys: 'SubscribeKeys',
    provider: 'ApiPushProvider',
  },
  PushUnsubscribeParams: {
    environment: 'PushEnvironment',
    provider: 'ApiPushProvider',
  },
  ReactionDetailGroup: {
    reactors: ['ReactionReactor'],
  },
  ReactionDetailResponse: {
    reactions: ['ReactionDetailGroup'],
  },
  ReactionSummary: {
    reactors: ['ReactionReactor'],
  },
  ReactionUpdatePayload: {
    chatId: 1,
    messageId: 1,
    reactions: ['ReactionSummary'],
  },
  ReactionsAddParams: {
    chatId: 1,
    messageId: 1,
  },
  ReactionsListParams: {
    chatId: 1,
    messageId: 1,
  },
  ReactionsRemoveParams: {
    chatId: 1,
    messageId: 1,
  },
  ReadReceiptChangedPayload: {
    chatId: 1,
    threadRootId: 1,
  },
  ReadReceiptQuery: {
    threadId: 1,
  },
  ReadReceiptResponse: {
    lastReadMessageId: 1,
  },
  ReadReceiptSettingsResponse: {
    visibility: 'ReadReceiptVisibility',
  },
  RedeemInviteResponse: {
    chat: 'GroupInfoResponse',
  },
  RelationshipPendingRequest: {
    direction: 'RelationshipRequestDirection',
    id: 1,
  },
  RelationshipQueryResponse: {
    relationships: ['RelationshipStatus'],
  },
  RelationshipStatus: {
    dmChatId: 1,
    pendingRequest: 'RelationshipPendingRequest',
  },
  RotateServiceTokenResponse: {
    serviceToken: 'ServiceTokenResponse',
  },
  SavedAttachmentSnapshot: {
    id: 1,
  },
  SavedChatSnapshot: {
    id: 1,
  },
  SavedMessageResponse: {
    attachments: ['SavedAttachmentSnapshot'],
    chat: 'SavedChatSnapshot',
    forwardedBundleId: 1,
    id: 1,
    mentions: ['MentionInfo'],
    messageType: 'MessageType',
    originalChatId: 1,
    originalMessageId: 1,
    originalReplyToMessageId: 1,
    originalThreadRootId: 1,
    sender: 'SavedSenderSnapshot',
    sticker: 'SavedStickerSnapshot',
  },
  SavedMessagesDeleteByMessageParams: {
    messageId: 1,
  },
  SavedMessagesDeleteParams: {
    savedMessageId: 1,
  },
  SavedMessagesListForChatParams: {
    before: 1,
    chatId: 1,
  },
  SavedMessagesListForwardedBundleMessagesParams: {
    bundleId: 1,
    savedMessageId: 1,
  },
  SavedMessagesListForwardedMessagesParams: {
    savedMessageId: 1,
  },
  SavedMessagesListParams: {
    before: 1,
  },
  SavedMessagesSaveParams: {
    messageId: 1,
  },
  SavedSenderSnapshot: {
    userGroup: 'UserGroupTagInfo',
  },
  SavedStickerSnapshot: {
    id: 1,
  },
  SearchMessagesQuery: {
    sort: 'MessageSearchSort',
  },
  SearchMessagesResponse: {
    messages: ['MessageResponse'],
  },
  SearchUsersQuery: {
    excludeMemberOf: 1,
  },
  SearchUsersResponse: {
    excluded: ['MemberSummary'],
    members: ['MemberSummary'],
  },
  SendInviteMessageBody: {
    destinationChatId: 1,
    inviteId: 1,
    sourceChatId: 1,
  },
  SendInviteMessageResponse: {
    invite: 'InviteResponse',
    message: 'MessageResponse',
  },
  ServiceTokenResponse: {
    id: 1,
  },
  ServiceTokensDeleteParams: {
    id: 1,
  },
  ServiceTokensRotateParams: {
    id: 1,
  },
  SessionInvalidatedNotification: {
    reason: 'SessionInvalidatedReason',
  },
  SessionPingParams: {
    state: 'OnlineClientStatus',
  },
  SessionSetAppStateParams: {
    state: 'OnlineClientStatus',
  },
  SessionUnavailableNotification: {
    reason: 'SessionUnavailableReason',
  },
  SpeakingRestrictedResponse: {
    effectiveSpeakingMode: 'SpeakingMode',
  },
  StickerDetailResponse: {
    id: 1,
    media: 'StickersStickerMediaResponse',
    packs: ['StickerPackSummary'],
  },
  StickerPackDetailResponse: {
    id: 1,
    previewSticker: 'StickerPackPreviewSticker',
    stickers: ['StickerSummary'],
    visibility: 'StickerPackVisibility',
  },
  StickerPackDiscoveryItem: {
    id: 1,
    previewSticker: 'StickerPackPreviewSticker',
    previewStickers: ['StickerPackPreviewSticker'],
    visibility: 'StickerPackVisibility',
  },
  StickerPackDiscoveryQuery: {
    sort: 'StickerPackSort',
  },
  StickerPackDiscoveryResponse: {
    packs: ['StickerPackDiscoveryItem'],
  },
  StickerPackListResponse: {
    packs: ['StickerPackSummary'],
  },
  StickerPackOrderItem: {
    stickerPackId: 1,
  },
  StickerPackOrderUpdatePayload: {
    order: ['StickerPackOrderItem'],
  },
  StickerPackPreviewSticker: {
    id: 1,
    media: 'StickersStickerMediaResponse',
  },
  StickerPackSummary: {
    id: 1,
    previewSticker: 'StickerPackPreviewSticker',
    visibility: 'StickerPackVisibility',
  },
  StickerSummary: {
    id: 1,
    media: 'StickersStickerMediaResponse',
  },
  StickersAddToPackParams: {
    packId: 1,
    stickerId: 1,
  },
  StickersCreateFromMessageParams: {
    chatId: 1,
    messageId: 1,
    packId: 1,
  },
  StickersDeletePackParams: {
    packId: 1,
  },
  StickersFavoriteParams: {
    stickerId: 1,
  },
  StickersGetPackParams: {
    packId: 1,
  },
  StickersGetParams: {
    stickerId: 1,
  },
  StickersListPacksParams: {
    sort: 'StickerPackSort',
  },
  StickersRemoveFromPackParams: {
    packId: 1,
    stickerId: 1,
  },
  StickersStickerMediaResponse: {
    id: 1,
  },
  StickersSubscribeToPackParams: {
    packId: 1,
  },
  StickersUnfavoriteParams: {
    stickerId: 1,
  },
  StickersUnsubscribeFromPackParams: {
    packId: 1,
  },
  StickersUpdatePackParams: {
    packId: 1,
    visibility: 'StickerPackVisibility',
  },
  SubscribeBody: {
    environment: 'PushEnvironment',
    keys: 'SubscribeKeys',
    provider: 'ApiPushProvider',
  },
  SubscriptionStatusQuery: {
    environment: 'PushEnvironment',
    provider: 'ApiPushProvider',
  },
  SystemMessageLinks: {
    messageId: 1,
  },
  ThreadListItem: {
    chatId: 1,
    chatKind: 'GroupKind',
    lastReadMessageId: 1,
    lastReply: 'MessagePreview',
    peer: 'MemberSummary',
    peerLastReadMessageId: 1,
    threadRootMessage: 'MessagePreview',
  },
  ThreadMembershipChangedPayload: {
    chatId: 1,
    status: 'ThreadSubscriptionStatusResponse',
    threadRootId: 1,
  },
  ThreadReadStateResponse: {
    lastReadMessageId: 1,
  },
  ThreadUpdatePayload: {
    chatId: 1,
    threadRootId: 1,
  },
  ThreadsArchiveParams: {
    chatId: 1,
    threadRootId: 1,
  },
  ThreadsGetReadStateParams: {
    chatId: 1,
    threadRootId: 1,
  },
  ThreadsGetSubscriptionStatusParams: {
    chatId: 1,
    threadRootId: 1,
  },
  ThreadsListForChatParams: {
    chatId: 1,
    cursor: 1,
    order: 'ThreadOrder',
  },
  ThreadsListParams: {
    rootId: 1,
  },
  ThreadsListParticipantsParams: {
    chatId: 1,
    threadRootId: 1,
  },
  ThreadsMarkAsReadParams: {
    chatId: 1,
    messageId: 1,
    threadRootId: 1,
  },
  ThreadsSubscribeParams: {
    chatId: 1,
    threadRootId: 1,
  },
  ThreadsUnarchiveParams: {
    chatId: 1,
    threadRootId: 1,
  },
  ThreadsUnsubscribeParams: {
    chatId: 1,
    threadRootId: 1,
  },
  UnreadCountResponse: {
    archivedMentionBadges: 'MentionBadges',
    mentionBadges: 'MentionBadges',
  },
  UnreadMentionIdsResponse: {
    messageIds: [1],
  },
  UnreadMentionsQuery: {
    threadId: 1,
  },
  UnreadReactionIdsResponse: {
    messageIds: [1],
  },
  UnsubscribeBody: {
    environment: 'PushEnvironment',
    provider: 'ApiPushProvider',
  },
  UpdateChatBody: {
    avatarImageId: 1,
    membershipMessageVisibility: 'MembershipMessageVisibility',
    visibility: 'GroupVisibility',
  },
  UpdateFriendPresenceSettingsBody: {
    override: 'FriendPresenceOverride',
  },
  UpdateFriendReadReceiptSettingsBody: {
    override: 'FriendReadReceiptOverride',
  },
  UpdateFriendSettingsBody: {
    mode: 'FriendAddVerificationMode',
  },
  UpdateMemberBody: {
    role: 'GroupRole',
  },
  UpdateMessageBody: {
    attachmentIds: [1],
  },
  UpdateNotificationSettingRequest: {
    mode: 'NotificationSettingMode',
  },
  UpdatePresenceSettingsBody: {
    visibility: 'PresenceVisibility',
  },
  UpdateReadReceiptSettingsBody: {
    visibility: 'ReadReceiptVisibility',
  },
  UpdateSpeakingModeRequest: {
    speakingMode: 'SpeakingMode',
  },
  UpdateStickerPackBody: {
    visibility: 'StickerPackVisibility',
  },
  UpdateStickerPackOrderItem: {
    stickerPackId: 1,
  },
  UpdateStickerPackOrderRequest: {
    order: ['UpdateStickerPackOrderItem'],
  },
  UploadUrlRequest: {
    purpose: 'AttachmentUploadPurpose',
  },
  UploadUrlResponse: {
    attachmentId: 1,
  },
  User: {
    userGroup: 'UserGroupTagInfo',
  },
  UserPresenceResponse: {
    lastSeenBucket: 'LastSeenBucket',
  },
  UsersClearNotificationExceptionsParams: {
    kind: 'GroupKind',
  },
  UsersListNotificationExceptionsParams: {
    after: 1,
    kind: 'GroupKind',
  },
  UsersSearchParams: {
    excludeMemberOf: 1,
  },
  UsersUpdateStickerPackOrderParams: {
    order: ['UpdateStickerPackOrderItem'],
  },
};
export const rpcMethods: Record<string, RpcMethodCodec> = {
  'session.open': {
    params: 'SessionOpenParams',
    result: 'SessionOpenResult',
  },
  'auth.createDevSession': {
    params: 'AuthCreateDevSessionParams',
    result: 'AuthTokenResponse',
  },
  'auth.refresh': {
    params: 'AuthRefreshParams',
    result: 'AuthTokenResponse',
  },
  'session.ping': {
    params: 'SessionPingParams',
  },
  'session.setAppState': {
    params: 'SessionSetAppStateParams',
  },
  'presence.watch': {
    params: 'PresenceWatchParams',
  },
  'conversations.watchUnread': {
    params: 'ConversationsWatchUnreadParams',
  },
  'conversations.watchStates': {
    params: 'ConversationsWatchStatesParams',
  },
  'messages.list': {
    params: 'MessagesListParams',
    result: 'ListMessagesResponse',
  },
  'messages.send': {
    params: 'MessagesSendParams',
    result: 'MessageResponse',
  },
  'messages.search': {
    params: 'MessagesSearchParams',
    result: 'SearchMessagesResponse',
  },
  'messages.get': {
    params: 'MessagesGetParams',
    result: 'MessageResponse',
  },
  'messages.edit': {
    params: 'MessagesEditParams',
    result: 'MessageResponse',
  },
  'messages.delete': {
    params: 'MessagesDeleteParams',
  },
  'messages.deleteMany': {
    params: 'MessagesDeleteManyParams',
    result: 'BulkDeletedPayload',
  },
  'messages.forward': {
    params: 'MessagesForwardParams',
    result: 'MessageResponse',
  },
  'messages.forwardOne': {
    params: 'MessagesForwardOneParams',
    result: 'MessageResponse',
  },
  'messages.listForwardedMessages': {
    params: 'MessagesListForwardedMessagesParams',
    result: 'ForwardedMessagesResponse',
  },
  'messages.listForwardedBundleMessages': {
    params: 'MessagesListForwardedBundleMessagesParams',
    result: 'ForwardedMessagesResponse',
  },
  'messages.sendInThread': {
    params: 'MessagesSendInThreadParams',
    result: 'MessageResponse',
  },
  'reactions.list': {
    params: 'ReactionsListParams',
    result: 'ReactionDetailResponse',
  },
  'reactions.add': {
    params: 'ReactionsAddParams',
  },
  'reactions.remove': {
    params: 'ReactionsRemoveParams',
  },
  'pins.list': {
    params: 'PinsListParams',
    result: 'ListPinsResponse',
  },
  'pins.create': {
    params: 'PinsCreateParams',
    result: 'PinResponse',
  },
  'pins.delete': {
    params: 'PinsDeleteParams',
  },
  'pins.listForThread': {
    params: 'PinsListForThreadParams',
    result: 'ListPinsResponse',
  },
  'pins.createForThread': {
    params: 'PinsCreateForThreadParams',
    result: 'PinResponse',
  },
  'pins.deleteForThread': {
    params: 'PinsDeleteForThreadParams',
  },
  'savedMessages.listForChat': {
    params: 'SavedMessagesListForChatParams',
    result: 'ListSavedMessagesResponse',
  },
  'savedMessages.list': {
    params: 'SavedMessagesListParams',
    result: 'ListSavedMessagesResponse',
  },
  'savedMessages.save': {
    params: 'SavedMessagesSaveParams',
    result: 'SavedMessageResponse',
  },
  'savedMessages.deleteByMessage': {
    params: 'SavedMessagesDeleteByMessageParams',
  },
  'savedMessages.delete': {
    params: 'SavedMessagesDeleteParams',
  },
  'savedMessages.listForwardedMessages': {
    params: 'SavedMessagesListForwardedMessagesParams',
    result: 'ForwardedMessagesResponse',
  },
  'savedMessages.listForwardedBundleMessages': {
    params: 'SavedMessagesListForwardedBundleMessagesParams',
    result: 'ForwardedMessagesResponse',
  },
  'chats.list': {
    params: 'ChatsListParams',
    result: 'ListChatsResponse',
  },
  'chats.getTotalUnreadCount': {
    params: 'ChatsGetTotalUnreadCountParams',
    result: 'UnreadCountResponse',
  },
  'chats.archive': {
    params: 'ChatsArchiveParams',
  },
  'chats.unarchive': {
    params: 'ChatsUnarchiveParams',
  },
  'chats.markAsRead': {
    params: 'ChatsMarkAsReadParams',
    result: 'MarkChatReadStateResponse',
  },
  'chats.markAsUnread': {
    params: 'ChatsMarkAsUnreadParams',
    result: 'MarkChatReadStateResponse',
  },
  'chats.getUnreadCount': {
    params: 'ChatsGetUnreadCountParams',
    result: 'MarkChatReadStateResponse',
  },
  'chats.getReadReceipt': {
    params: 'ChatsGetReadReceiptParams',
    result: 'ReadReceiptResponse',
  },
  'chats.listMentions': {
    params: 'ChatsListMentionsParams',
    result: 'UnreadMentionIdsResponse',
  },
  'chats.listUnreadReactions': {
    params: 'ChatsListUnreadReactionsParams',
    result: 'UnreadReactionIdsResponse',
  },
  'chats.acknowledgeReactions': {
    params: 'ChatsAcknowledgeReactionsParams',
    result: 'UnreadReactionsAckResponse',
  },
  'threads.list': {
    params: 'ThreadsListParams',
    result: 'ListThreadsResponse',
  },
  'threads.getUnreadCount': {
    params: 'ThreadsGetUnreadCountParams',
    result: 'UnreadThreadCountResponse',
  },
  'threads.listForChat': {
    params: 'ThreadsListForChatParams',
    result: 'ListChatThreadsResponse',
  },
  'threads.listParticipants': {
    params: 'ThreadsListParticipantsParams',
    result: 'ListThreadParticipantsResponse',
  },
  'threads.markAsRead': {
    params: 'ThreadsMarkAsReadParams',
    result: 'MarkThreadReadResponse',
  },
  'threads.getReadState': {
    params: 'ThreadsGetReadStateParams',
    result: 'ThreadReadStateResponse',
  },
  'threads.getSubscriptionStatus': {
    params: 'ThreadsGetSubscriptionStatusParams',
    result: 'ThreadSubscriptionStatusResponse',
  },
  'threads.subscribe': {
    params: 'ThreadsSubscribeParams',
  },
  'threads.unsubscribe': {
    params: 'ThreadsUnsubscribeParams',
  },
  'threads.archive': {
    params: 'ThreadsArchiveParams',
  },
  'threads.unarchive': {
    params: 'ThreadsUnarchiveParams',
  },
  'attachments.listForChat': {
    params: 'AttachmentsListForChatParams',
    result: 'ListChatAttachmentsResponse',
  },
  'attachments.createUploadUrl': {
    params: 'AttachmentsCreateUploadUrlParams',
    result: 'UploadUrlResponse',
  },
  'attachments.getConfig': {
    params: 'AttachmentsGetConfigParams',
    result: 'AttachmentConfigResponse',
  },
  'groups.list': {
    params: 'GroupsListParams',
    result: 'ListGroupsResponse',
  },
  'groups.create': {
    params: 'GroupsCreateParams',
    result: 'CreateChatResponse',
  },
  'groups.get': {
    params: 'GroupsGetParams',
    result: 'GroupInfoResponse',
  },
  'groups.update': {
    params: 'GroupsUpdateParams',
    result: 'GroupInfoResponse',
  },
  'groups.createAvatarUploadUrl': {
    params: 'GroupsCreateAvatarUploadUrlParams',
    result: 'AvatarUploadUrlResponse',
  },
  'groups.mute': {
    params: 'GroupsMuteParams',
    result: 'MuteResponse',
  },
  'groups.unmute': {
    params: 'GroupsUnmuteParams',
  },
  'groups.updateNotificationSetting': {
    params: 'GroupsUpdateNotificationSettingParams',
    result: 'ChatNotificationSettingResponse',
  },
  'groups.updateSpeakingMode': {
    params: 'GroupsUpdateSpeakingModeParams',
    result: 'GroupSpeakingModeResponse',
  },
  'groups.listMembers': {
    params: 'GroupsListMembersParams',
    result: 'ListMembersResponse',
  },
  'groups.addMember': {
    params: 'GroupsAddMemberParams',
    result: 'MemberResponse',
  },
  'groups.removeMember': {
    params: 'GroupsRemoveMemberParams',
  },
  'groups.updateMember': {
    params: 'GroupsUpdateMemberParams',
    result: 'MemberResponse',
  },
  'groups.updateMemberSpeakingMode': {
    params: 'GroupsUpdateMemberSpeakingModeParams',
    result: 'MemberSpeakingModeResponse',
  },
  'invites.list': {
    params: 'InvitesListParams',
    result: 'ListInvitesResponse',
  },
  'invites.create': {
    params: 'InvitesCreateParams',
    result: 'InviteResponse',
  },
  'invites.send': {
    params: 'InvitesSendParams',
    result: 'SendInviteMessageResponse',
  },
  'invites.get': {
    params: 'InvitesGetParams',
    result: 'InviteResponse',
  },
  'invites.getByCode': {
    params: 'InvitesGetByCodeParams',
    result: 'InvitePreviewResponse',
  },
  'invites.update': {
    params: 'InvitesUpdateParams',
    result: 'InviteResponse',
  },
  'invites.delete': {
    params: 'InvitesDeleteParams',
  },
  'invites.redeem': {
    params: 'InvitesRedeemParams',
    result: 'RedeemInviteResponse',
  },
  'friends.list': {
    params: 'FriendsListParams',
    result: 'ListFriendsResponse',
  },
  'friends.getRelationship': {
    params: 'FriendsGetRelationshipParams',
    result: 'FriendRelationshipResponse',
  },
  'friends.remove': {
    params: 'FriendsRemoveParams',
  },
  'friends.createRequest': {
    params: 'FriendsCreateRequestParams',
    result: 'FriendRequestResponse',
  },
  'friends.listRequests': {
    params: 'FriendsListRequestsParams',
    result: 'ListFriendRequestHistoryResponse',
  },
  'friends.getPendingRequestCount': {
    params: 'FriendsGetPendingRequestCountParams',
    result: 'PendingFriendRequestCountResponse',
  },
  'friends.acceptRequest': {
    params: 'FriendsAcceptRequestParams',
    result: 'FriendRequestResponse',
  },
  'friends.rejectRequest': {
    params: 'FriendsRejectRequestParams',
    result: 'FriendRequestResponse',
  },
  'friends.archiveRequest': {
    params: 'FriendsArchiveRequestParams',
  },
  'friends.getSettings': {
    params: 'FriendsGetSettingsParams',
    result: 'FriendSettingsResponse',
  },
  'friends.updateSettings': {
    params: 'FriendsUpdateSettingsParams',
    result: 'FriendSettingsResponse',
  },
  'friends.getAddInfo': {
    params: 'FriendsGetAddInfoParams',
    result: 'FriendAddInfoResponse',
  },
  'friends.getPresenceSettings': {
    params: 'FriendsGetPresenceSettingsParams',
    result: 'FriendPresenceSettingsResponse',
  },
  'friends.updatePresenceSettings': {
    params: 'FriendsUpdatePresenceSettingsParams',
    result: 'FriendPresenceSettingsResponse',
  },
  'friends.getReadReceiptSettings': {
    params: 'FriendsGetReadReceiptSettingsParams',
    result: 'FriendReadReceiptSettingsResponse',
  },
  'friends.updateReadReceiptSettings': {
    params: 'FriendsUpdateReadReceiptSettingsParams',
    result: 'FriendReadReceiptSettingsResponse',
  },
  'privacy.getPresenceSettings': {
    params: 'PrivacyGetPresenceSettingsParams',
    result: 'PresenceSettingsResponse',
  },
  'privacy.updatePresenceSettings': {
    params: 'PrivacyUpdatePresenceSettingsParams',
    result: 'PresenceSettingsResponse',
  },
  'privacy.getReadReceiptSettings': {
    params: 'PrivacyGetReadReceiptSettingsParams',
    result: 'ReadReceiptSettingsResponse',
  },
  'privacy.updateReadReceiptSettings': {
    params: 'PrivacyUpdateReadReceiptSettingsParams',
    result: 'ReadReceiptSettingsResponse',
  },
  'privacy.listExceptions': {
    params: 'PrivacyListExceptionsParams',
    result: 'PrivacyExceptionsResponse',
  },
  'privacy.clearExceptions': {
    params: 'PrivacyClearExceptionsParams',
  },
  'blocks.list': {
    params: 'BlocksListParams',
    result: 'ListBlocksResponse',
  },
  'blocks.create': {
    params: 'BlocksCreateParams',
  },
  'blocks.delete': {
    params: 'BlocksDeleteParams',
  },
  'users.getMe': {
    params: 'UsersGetMeParams',
    result: 'MeResponse',
  },
  'users.updateStickerPackOrder': {
    params: 'UsersUpdateStickerPackOrderParams',
  },
  'users.updateChatSettings': {
    params: 'UsersUpdateChatSettingsParams',
    result: 'ChatSettings',
  },
  'users.search': {
    params: 'UsersSearchParams',
    result: 'SearchUsersResponse',
  },
  'users.getNotificationSettings': {
    params: 'UsersGetNotificationSettingsParams',
    result: 'NotificationSettingsResponse',
  },
  'users.updateNotificationSettings': {
    params: 'UsersUpdateNotificationSettingsParams',
    result: 'NotificationSettingsResponse',
  },
  'users.listNotificationExceptions': {
    params: 'UsersListNotificationExceptionsParams',
    result: 'NotificationExceptionsResponse',
  },
  'users.clearNotificationExceptions': {
    params: 'UsersClearNotificationExceptionsParams',
    result: 'NotificationExceptionsCleared',
  },
  'push.getVapidPublicKey': {
    params: 'PushGetVapidPublicKeyParams',
    result: 'VapidPublicKeyResponse',
  },
  'push.getSubscriptionStatus': {
    params: 'PushGetSubscriptionStatusParams',
    result: 'SubscriptionStatusResponse',
  },
  'push.subscribe': {
    params: 'PushSubscribeParams',
  },
  'push.unsubscribe': {
    params: 'PushUnsubscribeParams',
  },
  'stickers.listPacks': {
    params: 'StickersListPacksParams',
    result: 'StickerPackDiscoveryResponse',
  },
  'stickers.createFromMessage': {
    params: 'StickersCreateFromMessageParams',
    result: 'StickerSummary',
  },
  'stickers.createPack': {
    params: 'StickersCreatePackParams',
    result: 'StickerPackSummary',
  },
  'stickers.getPack': {
    params: 'StickersGetPackParams',
    result: 'StickerPackDetailResponse',
  },
  'stickers.updatePack': {
    params: 'StickersUpdatePackParams',
    result: 'StickerPackSummary',
  },
  'stickers.deletePack': {
    params: 'StickersDeletePackParams',
  },
  'stickers.listSubscribedPacks': {
    params: 'StickersListSubscribedPacksParams',
    result: 'StickerPackListResponse',
  },
  'stickers.listOwnedPacks': {
    params: 'StickersListOwnedPacksParams',
    result: 'StickerPackListResponse',
  },
  'stickers.subscribeToPack': {
    params: 'StickersSubscribeToPackParams',
  },
  'stickers.unsubscribeFromPack': {
    params: 'StickersUnsubscribeFromPackParams',
  },
  'stickers.addToPack': {
    params: 'StickersAddToPackParams',
  },
  'stickers.removeFromPack': {
    params: 'StickersRemoveFromPackParams',
  },
  'stickers.get': {
    params: 'StickersGetParams',
    result: 'StickerDetailResponse',
  },
  'stickers.favorite': {
    params: 'StickersFavoriteParams',
  },
  'stickers.unfavorite': {
    params: 'StickersUnfavoriteParams',
  },
  'stickers.listFavorites': {
    params: 'StickersListFavoritesParams',
    result: 'FavoriteStickerListResponse',
  },
  'serviceTokens.create': {
    params: 'ServiceTokensCreateParams',
    result: 'CreateServiceTokenResponse',
  },
  'serviceTokens.list': {
    params: 'ServiceTokensListParams',
    result: 'ListServiceTokensResponse',
  },
  'serviceTokens.delete': {
    params: 'ServiceTokensDeleteParams',
  },
  'serviceTokens.rotate': {
    params: 'ServiceTokensRotateParams',
    result: 'RotateServiceTokenResponse',
  },
  'sessions.listClients': {
    params: 'SessionsListClientsParams',
    result: [
      {
        status: 'OnlineClientStatus',
      },
    ],
  },
};
export const rpcMethodClasses: Record<string, RpcMethodClass> = {
  'session.open': 'session',
  'auth.createDevSession': 'session',
  'auth.refresh': 'session',
  'session.ping': 'control',
  'session.setAppState': 'control',
  'presence.watch': 'control',
  'conversations.watchUnread': 'control',
  'conversations.watchStates': 'control',
  'messages.list': 'read',
  'messages.send': 'mutation',
  'messages.search': 'read',
  'messages.get': 'read',
  'messages.edit': 'mutation',
  'messages.delete': 'mutation',
  'messages.deleteMany': 'mutation',
  'messages.forward': 'mutation',
  'messages.forwardOne': 'mutation',
  'messages.listForwardedMessages': 'read',
  'messages.listForwardedBundleMessages': 'read',
  'messages.sendInThread': 'mutation',
  'reactions.list': 'read',
  'reactions.add': 'mutation',
  'reactions.remove': 'mutation',
  'pins.list': 'read',
  'pins.create': 'mutation',
  'pins.delete': 'mutation',
  'pins.listForThread': 'read',
  'pins.createForThread': 'mutation',
  'pins.deleteForThread': 'mutation',
  'savedMessages.listForChat': 'read',
  'savedMessages.list': 'read',
  'savedMessages.save': 'mutation',
  'savedMessages.deleteByMessage': 'mutation',
  'savedMessages.delete': 'mutation',
  'savedMessages.listForwardedMessages': 'read',
  'savedMessages.listForwardedBundleMessages': 'read',
  'chats.list': 'read',
  'chats.getTotalUnreadCount': 'read',
  'chats.archive': 'mutation',
  'chats.unarchive': 'mutation',
  'chats.markAsRead': 'mutation',
  'chats.markAsUnread': 'mutation',
  'chats.getUnreadCount': 'read',
  'chats.getReadReceipt': 'read',
  'chats.listMentions': 'read',
  'chats.listUnreadReactions': 'read',
  'chats.acknowledgeReactions': 'mutation',
  'threads.list': 'read',
  'threads.getUnreadCount': 'read',
  'threads.listForChat': 'read',
  'threads.listParticipants': 'read',
  'threads.markAsRead': 'mutation',
  'threads.getReadState': 'read',
  'threads.getSubscriptionStatus': 'read',
  'threads.subscribe': 'mutation',
  'threads.unsubscribe': 'mutation',
  'threads.archive': 'mutation',
  'threads.unarchive': 'mutation',
  'attachments.listForChat': 'read',
  'attachments.createUploadUrl': 'mutation',
  'attachments.getConfig': 'read',
  'groups.list': 'read',
  'groups.create': 'mutation',
  'groups.get': 'read',
  'groups.update': 'mutation',
  'groups.createAvatarUploadUrl': 'mutation',
  'groups.mute': 'mutation',
  'groups.unmute': 'mutation',
  'groups.updateNotificationSetting': 'mutation',
  'groups.updateSpeakingMode': 'mutation',
  'groups.listMembers': 'read',
  'groups.addMember': 'mutation',
  'groups.removeMember': 'mutation',
  'groups.updateMember': 'mutation',
  'groups.updateMemberSpeakingMode': 'mutation',
  'invites.list': 'read',
  'invites.create': 'mutation',
  'invites.send': 'mutation',
  'invites.get': 'read',
  'invites.getByCode': 'read',
  'invites.update': 'mutation',
  'invites.delete': 'mutation',
  'invites.redeem': 'mutation',
  'friends.list': 'read',
  'friends.getRelationship': 'read',
  'friends.remove': 'mutation',
  'friends.createRequest': 'mutation',
  'friends.listRequests': 'read',
  'friends.getPendingRequestCount': 'read',
  'friends.acceptRequest': 'mutation',
  'friends.rejectRequest': 'mutation',
  'friends.archiveRequest': 'mutation',
  'friends.getSettings': 'read',
  'friends.updateSettings': 'mutation',
  'friends.getAddInfo': 'read',
  'friends.getPresenceSettings': 'read',
  'friends.updatePresenceSettings': 'mutation',
  'friends.getReadReceiptSettings': 'read',
  'friends.updateReadReceiptSettings': 'mutation',
  'privacy.getPresenceSettings': 'read',
  'privacy.updatePresenceSettings': 'mutation',
  'privacy.getReadReceiptSettings': 'read',
  'privacy.updateReadReceiptSettings': 'mutation',
  'privacy.listExceptions': 'read',
  'privacy.clearExceptions': 'mutation',
  'blocks.list': 'read',
  'blocks.create': 'mutation',
  'blocks.delete': 'mutation',
  'users.getMe': 'read',
  'users.updateStickerPackOrder': 'mutation',
  'users.updateChatSettings': 'mutation',
  'users.search': 'read',
  'users.getNotificationSettings': 'read',
  'users.updateNotificationSettings': 'mutation',
  'users.listNotificationExceptions': 'read',
  'users.clearNotificationExceptions': 'mutation',
  'push.getVapidPublicKey': 'read',
  'push.getSubscriptionStatus': 'read',
  'push.subscribe': 'mutation',
  'push.unsubscribe': 'mutation',
  'stickers.listPacks': 'read',
  'stickers.createFromMessage': 'mutation',
  'stickers.createPack': 'mutation',
  'stickers.getPack': 'read',
  'stickers.updatePack': 'mutation',
  'stickers.deletePack': 'mutation',
  'stickers.listSubscribedPacks': 'read',
  'stickers.listOwnedPacks': 'read',
  'stickers.subscribeToPack': 'mutation',
  'stickers.unsubscribeFromPack': 'mutation',
  'stickers.addToPack': 'mutation',
  'stickers.removeFromPack': 'mutation',
  'stickers.get': 'read',
  'stickers.favorite': 'mutation',
  'stickers.unfavorite': 'mutation',
  'stickers.listFavorites': 'read',
  'serviceTokens.create': 'mutation',
  'serviceTokens.list': 'read',
  'serviceTokens.delete': 'mutation',
  'serviceTokens.rotate': 'mutation',
  'sessions.listClients': 'read',
};
export const rpcEvents: Record<string, JsonCodec> = {
  'events.chatMembershipChanged': 'ChatMembershipChangedPayload',
  'events.membershipMessagePolicyChanged': 'MembershipMessagePolicyChanged',
  'events.message': 'MessageResponse',
  'events.messageUpdated': 'MessageResponse',
  'events.messageDeleted': 'MessageResponse',
  'events.messagesBulkDeleted': 'BulkDeletedPayload',
  'events.reactionUpdated': 'ReactionUpdatePayload',
  'events.presenceUpdate': 'PresenceUpdatePayload',
  'events.presenceSnapshot': 'PresenceSnapshotPayload',
  'events.conversationUnread': 'ConversationUnreadPayload',
  'events.conversationStates': 'ConversationStatesPayload',
  'events.conversationStatesError': 'ConversationUnreadErrorPayload',
  'events.conversationUnreadError': 'ConversationUnreadErrorPayload',
  'events.threadUpdate': 'ThreadUpdatePayload',
  'events.threadMembershipChanged': 'ThreadMembershipChangedPayload',
  'events.chatArchiveStateChanged': 'ChatArchiveStateChangedPayload',
  'events.notificationExceptionsCleared': 'NotificationExceptionsCleared',
  'events.notificationSettingsChanged': 'NotificationSettingsResponse',
  'events.chatNotificationSettingChanged': 'ChatNotificationSettingResponse',
  'events.groupSpeakingModeChanged': 'GroupSpeakingModeResponse',
  'events.memberSpeakingModeChanged': 'MemberSpeakingModeResponse',
  'events.readReceiptChanged': 'ReadReceiptChangedPayload',
  'events.pinAdded': 'PinUpdatePayload',
  'events.threadPinAdded': 'PinUpdatePayload',
  'events.pinRemoved': 'PinUpdatePayload',
  'events.threadPinRemoved': 'PinUpdatePayload',
  'events.stickerPackOrderUpdated': 'StickerPackOrderUpdatePayload',
  'events.friendRequestReceived': 'FriendRequestReceivedPayload',
  'events.friendRequestResolved': 'FriendRequestResolvedPayload',
  'events.friendshipRemoved': 'FriendshipRemovedPayload',
  'events.notification': 'NotificationPayload',
  'session.invalidated': 'SessionInvalidatedNotification',
  'session.unavailable': 'SessionUnavailableNotification',
};
export interface RpcEventMap {
  'events.chatMembershipChanged': Shared.ChatMembershipChangedPayload;
  'events.membershipMessagePolicyChanged': Shared.MembershipMessagePolicyChanged;
  'events.message': Shared.MessageResponse;
  'events.messageUpdated': Shared.MessageResponse;
  'events.messageDeleted': Shared.MessageResponse;
  'events.messagesBulkDeleted': Shared.BulkDeletedPayload;
  'events.reactionUpdated': Shared.ReactionUpdatePayload;
  'events.presenceUpdate': Shared.PresenceUpdatePayload;
  'events.presenceSnapshot': Shared.PresenceSnapshotPayload;
  'events.conversationUnread': Shared.ConversationUnreadPayload;
  'events.conversationStates': Shared.ConversationStatesPayload;
  'events.conversationStatesError': Shared.ConversationUnreadErrorPayload;
  'events.conversationUnreadError': Shared.ConversationUnreadErrorPayload;
  'events.threadUpdate': Shared.ThreadUpdatePayload;
  'events.threadMembershipChanged': Shared.ThreadMembershipChangedPayload;
  'events.chatArchiveStateChanged': Shared.ChatArchiveStateChangedPayload;
  'events.notificationExceptionsCleared': Shared.NotificationExceptionsCleared;
  'events.notificationSettingsChanged': Shared.NotificationSettingsResponse;
  'events.chatNotificationSettingChanged': Shared.ChatNotificationSettingResponse;
  'events.groupSpeakingModeChanged': Shared.GroupSpeakingModeResponse;
  'events.memberSpeakingModeChanged': Shared.MemberSpeakingModeResponse;
  'events.readReceiptChanged': Shared.ReadReceiptChangedPayload;
  'events.pinAdded': Shared.PinUpdatePayload;
  'events.threadPinAdded': Shared.PinUpdatePayload;
  'events.pinRemoved': Shared.PinUpdatePayload;
  'events.threadPinRemoved': Shared.PinUpdatePayload;
  'events.stickerPackOrderUpdated': Shared.StickerPackOrderUpdatePayload;
  'events.friendRequestReceived': Shared.FriendRequestReceivedPayload;
  'events.friendRequestResolved': Shared.FriendRequestResolvedPayload;
  'events.friendshipRemoved': Shared.FriendshipRemovedPayload;
  'events.notification': Shared.NotificationPayload;
  'session.invalidated': SessionInvalidatedNotification;
  'session.unavailable': SessionUnavailableNotification;
}
