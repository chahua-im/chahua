/** Generated from the API contract by scripts/api-codegen.ts. */
export type JsonCodec = 0 | 1 | string | [JsonCodec] | { [field: string]: JsonCodec };
export interface JsonOperationCodec {
  method: string;
  path: string;
  body?: JsonCodec;
  response?: JsonCodec;
  query?: Record<string, JsonCodec>;
}
export const jsonSchemas: Record<string, JsonCodec> = {
  AddMemberBody: {
    role: 'GroupRole',
  },
  AttachmentResponse: {
    height: 0,
    id: 1,
    width: 0,
  },
  AttachmentUploadPurpose: 0,
  AvatarUploadUrlRequest: {
    height: 0,
    width: 0,
  },
  AvatarUploadUrlResponse: {
    imageId: 1,
  },
  BlockResponse: {
    user: 'MemberSummary',
  },
  BulkDeletedPayload: {
    chatId: 1,
    messageIds: [1],
  },
  ChatArchiveStateChangedPayload: {
    chatId: 1,
    mutedUntil: 0,
  },
  ChatAttachmentResponse: {
    height: 0,
    id: 1,
    messageId: 1,
    sender: 'User',
    width: 0,
  },
  ChatListItem: {
    avatar: 0,
    id: 1,
    lastMessage: 'MessagePreview',
    lastMessageAt: 0,
    lastReadMessageId: 1,
    mutedUntil: 0,
    name: 0,
    peer: 'MemberSummary',
  },
  CreateChatBody: {
    name: 0,
  },
  CreateChatResponse: {
    id: 1,
    name: 0,
  },
  CreateFriendRequestBody: {
    message: 0,
  },
  CreateInviteBody: {
    chatId: 1,
    expiresAt: 0,
    requiredChatId: 1,
    targetUid: 0,
  },
  CreateMessageBody: {
    attachmentIds: [1],
    message: 0,
    replyToId: 1,
    stickerId: 1,
  },
  CreatePinBody: {
    messageId: 1,
  },
  CreateServiceTokenResponse: {
    serviceToken: 'ServiceTokenResponse',
  },
  CreateStickerPackBody: {
    description: 0,
  },
  ExternalCreateInviteRequest: {
    chatId: 1,
    expiresAt: 0,
  },
  ExternalCreateInviteResponse: {
    chat: 'ExternalInviteChatResponse',
    invite: 'InviteResponse',
    membership: 'ExternalInviteMembershipResponse',
  },
  ExternalInviteChatResponse: {
    avatarImageId: 1,
    description: 0,
    id: 1,
    visibility: 'GroupVisibility',
  },
  ExternalInviteMembershipResponse: {
    role: 'GroupRole',
  },
  FavoriteStickerListResponse: {
    stickers: ['StickerSummary'],
  },
  FriendAddInfoResponse: {
    question: 0,
  },
  FriendRelationshipResponse: {
    dmChatId: 1,
  },
  FriendRequestHistoryEntry: {
    decidedAt: 0,
    from: 'MemberSummary',
    id: 1,
    message: 0,
    question: 0,
    to: 'MemberSummary',
  },
  FriendRequestResolvedPayload: {
    requestId: 1,
  },
  FriendRequestResponse: {
    decidedAt: 0,
    from: 'MemberSummary',
    id: 1,
    message: 0,
    question: 0,
    to: 'MemberSummary',
  },
  FriendResponse: {
    user: 'MemberSummary',
  },
  FriendSettingsResponse: {
    question: 0,
  },
  GroupInfoResponse: {
    avatar: 0,
    avatarImageId: 1,
    description: 0,
    id: 1,
    mutedUntil: 0,
    myRole: 'GroupRole',
    peer: 'MemberSummary',
    visibility: 'GroupVisibility',
  },
  GroupRole: 0,
  GroupSelectorItem: {
    avatar: 0,
    description: 0,
    id: 1,
    role: 'GroupRole',
    visibility: 'GroupVisibility',
  },
  GroupVisibility: 0,
  InvitePreviewResponse: {
    chat: 'GroupInfoResponse',
    invite: 'InviteResponse',
  },
  InviteResponse: {
    chatId: 1,
    creatorUid: 0,
    expiresAt: 0,
    id: 1,
    requiredChatId: 1,
    revokedAt: 0,
    targetUid: 0,
    usedAt: 0,
  },
  ListBlocksResponse: {
    blocks: ['BlockResponse'],
  },
  ListChatAttachmentsResponse: {
    attachments: ['ChatAttachmentResponse'],
    newerCursor: 1,
    olderCursor: 1,
  },
  ListChatsResponse: {
    chats: ['ChatListItem'],
    nextCursor: 1,
  },
  ListFriendRequestHistoryResponse: {
    requests: ['FriendRequestHistoryEntry'],
  },
  ListFriendsResponse: {
    friends: ['FriendResponse'],
  },
  ListGroupsResponse: {
    groups: ['GroupSelectorItem'],
    nextCursor: 1,
  },
  ListInvitesResponse: {
    invites: ['InviteResponse'],
  },
  ListMembersResponse: {
    members: ['MemberResponse'],
    nextCursor: 0,
  },
  ListMessagesResponse: {
    messages: ['MessageResponse'],
    newerCursor: 1,
    nextCursor: 1,
    olderCursor: 1,
    prevCursor: 1,
  },
  ListPinsResponse: {
    pins: ['PinResponse'],
  },
  ListSavedMessagesResponse: {
    nextCursor: 1,
    savedMessages: ['SavedMessageResponse'],
  },
  ListServiceTokensResponse: {
    serviceTokens: ['ServiceTokenResponse'],
  },
  ListThreadsResponse: {
    nextCursor: 0,
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
    avatarUrl: 0,
    stickerPackOrder: ['StickerPackOrderItem'],
  },
  MemberResponse: {
    avatarUrl: 0,
    role: 'GroupRole',
    userGroup: 'UserGroupTagInfo',
    username: 0,
  },
  MemberSummary: {
    avatarUrl: 0,
    userGroup: 'UserGroupTagInfo',
    username: 0,
  },
  MentionInfo: {
    avatarUrl: 0,
    userGroup: 'UserGroupTagInfo',
    username: 0,
  },
  MessagePreview: {
    id: 1,
    mentions: ['MentionInfo'],
    message: 0,
    sender: 'User',
    sticker: 'MessagePreviewSticker',
  },
  MessagePreviewSticker: 0,
  MessageResponse: {
    attachments: ['AttachmentResponse'],
    chatId: 1,
    id: 1,
    mentions: ['MentionInfo'],
    message: 0,
    reactions: ['ReactionSummary'],
    replyRootId: 1,
    replyToMessage: 'MessagePreview',
    sender: 'User',
    sticker: 'MessageStickerResponse',
    threadInfo: 'ThreadInfo',
  },
  MessageStickerMediaResponse: {
    height: 0,
    id: 1,
    width: 0,
  },
  MessageStickerResponse: {
    description: 0,
    id: 1,
    media: 'MessageStickerMediaResponse',
    name: 0,
  },
  MuteBody: {
    durationSeconds: 0,
  },
  PatchInviteBody: {
    expiresAt: 0,
  },
  PinResponse: {
    chatId: 1,
    expiresAt: 0,
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
  PostStickerMultipart: {
    description: 0,
    name: 0,
  },
  PushEnvironment: 0,
  ReactionDetailGroup: {
    reactors: ['ReactionReactor'],
  },
  ReactionDetailResponse: {
    reactions: ['ReactionDetailGroup'],
  },
  ReactionReactor: {
    avatarUrl: 0,
    name: 0,
    sortIndex: 0,
  },
  ReactionSummary: {
    reactedByMe: 0,
    reactors: ['ReactionReactor'],
  },
  ReactionUpdatePayload: {
    chatId: 1,
    messageId: 1,
    reactions: ['ReactionSummary'],
  },
  RedeemInviteResponse: {
    chat: 'GroupInfoResponse',
  },
  RelationshipPendingRequest: {
    id: 1,
  },
  RelationshipQueryResponse: {
    relationships: ['RelationshipStatus'],
  },
  RelationshipStatus: {
    dmChatId: 1,
    friendsSince: 0,
    pendingRequest: 'RelationshipPendingRequest',
  },
  RotateServiceTokenResponse: {
    serviceToken: 'ServiceTokenResponse',
  },
  SavedAttachmentSnapshot: {
    height: 0,
    id: 1,
    width: 0,
  },
  SavedChatSnapshot: {
    avatarUrl: 0,
    id: 1,
  },
  SavedMessageResponse: {
    attachments: ['SavedAttachmentSnapshot'],
    chat: 'SavedChatSnapshot',
    id: 1,
    mentions: ['MentionInfo'],
    message: 0,
    originalChatId: 1,
    originalMessageId: 1,
    originalReplyToMessageId: 1,
    originalThreadRootId: 1,
    sender: 'SavedSenderSnapshot',
    sticker: 'SavedStickerSnapshot',
  },
  SavedSenderSnapshot: {
    avatarUrl: 0,
    name: 0,
    userGroup: 'UserGroupTagInfo',
  },
  SavedStickerSnapshot: {
    id: 1,
    name: 0,
  },
  SearchMessagesResponse: {
    messages: ['MessageResponse'],
    nextOffset: 0,
  },
  SearchUsersResponse: {
    excluded: ['MemberSummary'],
    members: ['MemberSummary'],
  },
  SendInviteMessageBody: {
    destinationChatId: 1,
    expiresAt: 0,
    inviteId: 1,
    sourceChatId: 1,
  },
  SendInviteMessageResponse: {
    invite: 'InviteResponse',
    message: 'MessageResponse',
  },
  ServiceTokenResponse: {
    lastUsedAt: 0,
    revokedAt: 0,
  },
  StickerDetailResponse: {
    description: 0,
    id: 1,
    media: 'StickersStickerMediaResponse',
    name: 0,
    packs: ['StickerPackSummary'],
  },
  StickerPackDetailResponse: {
    description: 0,
    id: 1,
    ownerName: 0,
    previewSticker: 'StickerPackPreviewSticker',
    stickers: ['StickerSummary'],
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
    description: 0,
    id: 1,
    ownerName: 0,
    previewSticker: 'StickerPackPreviewSticker',
  },
  StickerSummary: {
    description: 0,
    id: 1,
    media: 'StickersStickerMediaResponse',
    name: 0,
  },
  StickersStickerMediaResponse: {
    height: 0,
    id: 1,
    width: 0,
  },
  SubscribeBody: {
    deviceToken: 0,
    endpoint: 0,
    environment: 'PushEnvironment',
    keys: 'SubscribeKeys',
  },
  SubscribeKeys: 0,
  SubscriptionStatusResponse: {
    hasMatchingEndpoint: 0,
    hasMatchingSubscription: 0,
  },
  ThreadInfo: 0,
  ThreadListItem: {
    chatAvatar: 0,
    chatId: 1,
    lastReadMessageId: 1,
    lastReply: 'MessagePreview',
    participants: ['User'],
    threadRootMessage: 'MessagePreview',
  },
  ThreadMembershipChangedPayload: {
    chatId: 1,
    threadRootId: 1,
  },
  ThreadReadStateResponse: {
    lastReadMessageId: 1,
  },
  ThreadUpdatePayload: {
    chatId: 1,
    threadRootId: 1,
  },
  UnsubscribeBody: {
    deviceToken: 0,
    endpoint: 0,
    environment: 'PushEnvironment',
  },
  UpdateChatBody: {
    avatarImageId: 1,
    description: 0,
    name: 0,
    visibility: 'GroupVisibility',
  },
  UpdateFriendSettingsBody: {
    question: 0,
  },
  UpdateMemberBody: {
    role: 'GroupRole',
  },
  UpdateMessageBody: {
    attachmentIds: [1],
  },
  UpdateStickerPackBody: {
    description: 0,
    name: 0,
  },
  UpdateStickerPackOrderItem: {
    isAutoSort: 0,
    stickerPackId: 1,
  },
  UpdateStickerPackOrderRequest: {
    order: ['UpdateStickerPackOrderItem'],
  },
  UploadUrlRequest: {
    height: 0,
    order: 0,
    purpose: 'AttachmentUploadPurpose',
    width: 0,
  },
  UploadUrlResponse: {
    attachmentId: 1,
  },
  User: {
    avatarUrl: 0,
    name: 0,
    userGroup: 'UserGroupTagInfo',
  },
  UserGroupTagInfo: {
    chatGroupColor: 0,
    chatGroupColorDark: 0,
    name: 0,
  },
};
export const jsonOperations: JsonOperationCodec[] = [
  {
    method: 'GET',
    path: '/attachments/config',
    response: 0,
  },
  {
    method: 'POST',
    path: '/attachments/upload-url',
    body: 'UploadUrlRequest',
    response: 'UploadUrlResponse',
  },
  {
    method: 'POST',
    path: '/auth/dev-session',
    body: 0,
    response: 0,
  },
  {
    method: 'POST',
    path: '/auth/refresh',
    response: 0,
  },
  {
    method: 'GET',
    path: '/blocks',
    response: 'ListBlocksResponse',
  },
  {
    method: 'POST',
    path: '/blocks',
    body: 0,
  },
  {
    method: 'GET',
    path: '/chats',
    response: 'ListChatsResponse',
    query: {
      after: 1,
    },
  },
  {
    method: 'GET',
    path: '/chats/unread',
    response: 0,
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/attachments',
    response: 'ListChatAttachmentsResponse',
    query: {
      before: 1,
      after: 1,
    },
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/messages',
    response: 'ListMessagesResponse',
    query: {
      before: 1,
      around: 1,
      after: 1,
      threadId: 1,
    },
  },
  {
    method: 'POST',
    path: '/chats/{chat_id}/messages',
    body: 'CreateMessageBody',
    response: 'MessageResponse',
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/messages/search',
    response: 'SearchMessagesResponse',
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/messages/{message_id}',
    response: 'MessageResponse',
  },
  {
    method: 'PATCH',
    path: '/chats/{chat_id}/messages/{message_id}',
    body: 'UpdateMessageBody',
    response: 'MessageResponse',
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/messages/{message_id}/reactions',
    response: 'ReactionDetailResponse',
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/pins',
    response: 'ListPinsResponse',
  },
  {
    method: 'POST',
    path: '/chats/{chat_id}/pins',
    body: 'CreatePinBody',
    response: 'PinResponse',
  },
  {
    method: 'POST',
    path: '/chats/{chat_id}/read',
    body: 'MarkAsReadBody',
    response: 'MarkChatReadStateResponse',
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/saved-messages',
    response: 'ListSavedMessagesResponse',
    query: {
      before: 1,
    },
  },
  {
    method: 'POST',
    path: '/chats/{chat_id}/threads/{thread_id}/messages',
    body: 'CreateMessageBody',
    response: 'MessageResponse',
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/threads/{thread_root_id}/pins',
    response: 'ListPinsResponse',
  },
  {
    method: 'POST',
    path: '/chats/{chat_id}/threads/{thread_root_id}/pins',
    body: 'CreatePinBody',
    response: 'PinResponse',
  },
  {
    method: 'POST',
    path: '/chats/{chat_id}/threads/{thread_root_id}/read',
    body: 'MarkThreadReadBody',
    response: 'MarkThreadReadResponse',
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/threads/{thread_root_id}/read-state',
    response: 'ThreadReadStateResponse',
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/threads/{thread_root_id}/subscribe',
    response: 0,
  },
  {
    method: 'GET',
    path: '/chats/{chat_id}/unread',
    response: 'MarkChatReadStateResponse',
  },
  {
    method: 'POST',
    path: '/chats/{chat_id}/unread',
    body: 'MarkAsUnreadBody',
    response: 'MarkChatReadStateResponse',
  },
  {
    method: 'POST',
    path: '/external/invites',
    body: 'ExternalCreateInviteRequest',
    response: 'ExternalCreateInviteResponse',
  },
  {
    method: 'GET',
    path: '/external/sessions/{uid}',
    response: 0,
  },
  {
    method: 'POST',
    path: '/external/sessions/{uid}/revoke',
    response: 0,
  },
  {
    method: 'POST',
    path: '/external/social/relationships',
    body: 0,
    response: 'RelationshipQueryResponse',
  },
  {
    method: 'GET',
    path: '/friends',
    response: 'ListFriendsResponse',
  },
  {
    method: 'GET',
    path: '/friends/add-info/{uid}',
    response: 'FriendAddInfoResponse',
  },
  {
    method: 'GET',
    path: '/friends/me/settings',
    response: 'FriendSettingsResponse',
  },
  {
    method: 'PUT',
    path: '/friends/me/settings',
    body: 'UpdateFriendSettingsBody',
    response: 'FriendSettingsResponse',
  },
  {
    method: 'GET',
    path: '/friends/requests',
    response: 'ListFriendRequestHistoryResponse',
  },
  {
    method: 'POST',
    path: '/friends/requests',
    body: 'CreateFriendRequestBody',
    response: 'FriendRequestResponse',
  },
  {
    method: 'GET',
    path: '/friends/requests/pending/count',
    response: 0,
  },
  {
    method: 'POST',
    path: '/friends/requests/{request_id}/accept',
    response: 'FriendRequestResponse',
  },
  {
    method: 'POST',
    path: '/friends/requests/{request_id}/reject',
    response: 'FriendRequestResponse',
  },
  {
    method: 'GET',
    path: '/friends/{uid}',
    response: 'FriendRelationshipResponse',
  },
  {
    method: 'GET',
    path: '/group',
    response: 'ListGroupsResponse',
    query: {
      after: 1,
    },
  },
  {
    method: 'POST',
    path: '/group',
    body: 'CreateChatBody',
    response: 'CreateChatResponse',
  },
  {
    method: 'GET',
    path: '/group/{chat_id}',
    response: 'GroupInfoResponse',
  },
  {
    method: 'PATCH',
    path: '/group/{chat_id}',
    body: 'UpdateChatBody',
    response: 'GroupInfoResponse',
  },
  {
    method: 'POST',
    path: '/group/{chat_id}/avatar/upload-url',
    body: 'AvatarUploadUrlRequest',
    response: 'AvatarUploadUrlResponse',
  },
  {
    method: 'GET',
    path: '/group/{chat_id}/members',
    response: 'ListMembersResponse',
  },
  {
    method: 'POST',
    path: '/group/{chat_id}/members',
    body: 'AddMemberBody',
    response: 'MemberResponse',
  },
  {
    method: 'PATCH',
    path: '/group/{chat_id}/members/{uid}',
    body: 'UpdateMemberBody',
    response: 'MemberResponse',
  },
  {
    method: 'PUT',
    path: '/group/{chat_id}/mute',
    body: 'MuteBody',
    response: 0,
  },
  {
    method: 'GET',
    path: '/invites',
    response: 'ListInvitesResponse',
    query: {
      groupId: 1,
    },
  },
  {
    method: 'POST',
    path: '/invites',
    body: 'CreateInviteBody',
    response: 'InviteResponse',
  },
  {
    method: 'GET',
    path: '/invites/invite',
    response: 'InvitePreviewResponse',
  },
  {
    method: 'GET',
    path: '/invites/invite/{invite_id}',
    response: 'InviteResponse',
  },
  {
    method: 'PATCH',
    path: '/invites/invite/{invite_id}',
    body: 'PatchInviteBody',
    response: 'InviteResponse',
  },
  {
    method: 'POST',
    path: '/invites/redeem',
    body: 0,
    response: 'RedeemInviteResponse',
  },
  {
    method: 'POST',
    path: '/invites/send',
    body: 'SendInviteMessageBody',
    response: 'SendInviteMessageResponse',
  },
  {
    method: 'POST',
    path: '/push/subscribe',
    body: 'SubscribeBody',
  },
  {
    method: 'GET',
    path: '/push/subscription-status',
    response: 'SubscriptionStatusResponse',
  },
  {
    method: 'POST',
    path: '/push/unsubscribe',
    body: 'UnsubscribeBody',
  },
  {
    method: 'GET',
    path: '/push/vapid-public-key',
    response: 0,
  },
  {
    method: 'GET',
    path: '/saved-messages',
    response: 'ListSavedMessagesResponse',
    query: {
      before: 1,
    },
  },
  {
    method: 'PUT',
    path: '/saved-messages/{message_id}',
    response: 'SavedMessageResponse',
  },
  {
    method: 'GET',
    path: '/service-tokens',
    response: 'ListServiceTokensResponse',
  },
  {
    method: 'POST',
    path: '/service-tokens',
    body: 0,
    response: 'CreateServiceTokenResponse',
  },
  {
    method: 'POST',
    path: '/service-tokens/{id}/rotate',
    response: 'RotateServiceTokenResponse',
  },
  {
    method: 'GET',
    path: '/stickers/mine/favorites',
    response: 'FavoriteStickerListResponse',
  },
  {
    method: 'POST',
    path: '/stickers/packs',
    body: 'CreateStickerPackBody',
    response: 'StickerPackDetailResponse',
  },
  {
    method: 'GET',
    path: '/stickers/packs/mine/owned',
    response: 'StickerPackListResponse',
  },
  {
    method: 'GET',
    path: '/stickers/packs/mine/subscribed',
    response: 'StickerPackListResponse',
  },
  {
    method: 'GET',
    path: '/stickers/packs/{pack_id}',
    response: 'StickerPackDetailResponse',
  },
  {
    method: 'PATCH',
    path: '/stickers/packs/{pack_id}',
    body: 'UpdateStickerPackBody',
    response: 'StickerPackDetailResponse',
  },
  {
    method: 'POST',
    path: '/stickers/packs/{pack_id}/stickers',
    response: 'StickerSummary',
  },
  {
    method: 'GET',
    path: '/stickers/{sticker_id}',
    response: 'StickerDetailResponse',
  },
  {
    method: 'GET',
    path: '/threads',
    response: 'ListThreadsResponse',
  },
  {
    method: 'GET',
    path: '/threads/unread',
    response: 0,
  },
  {
    method: 'POST',
    path: '/threads/{thread_root_id}/read',
    body: 'MarkThreadReadBody',
    response: 'MarkThreadReadResponse',
  },
  {
    method: 'GET',
    path: '/threads/{thread_root_id}/read-state',
    response: 'ThreadReadStateResponse',
  },
  {
    method: 'GET',
    path: '/users/auth-token',
    response: 0,
  },
  {
    method: 'GET',
    path: '/users/me',
    response: 'MeResponse',
  },
  {
    method: 'PUT',
    path: '/users/me/stickerpack-order',
    body: 'UpdateStickerPackOrderRequest',
  },
  {
    method: 'GET',
    path: '/users/search',
    response: 'SearchUsersResponse',
    query: {
      excludeMemberOf: 1,
    },
  },
  {
    method: 'GET',
    path: '/ws/ticket',
    response: 0,
  },
];
export const wsPayloadCodecs: Record<string, JsonCodec> = {
  message: 'MessageResponse',
  messageUpdated: 'MessageResponse',
  messageDeleted: 'MessageResponse',
  messagesBulkDeleted: 'BulkDeletedPayload',
  reactionUpdated: 'ReactionUpdatePayload',
  presenceUpdate: 0,
  threadUpdate: 'ThreadUpdatePayload',
  threadMembershipChanged: 'ThreadMembershipChangedPayload',
  chatArchiveStateChanged: 'ChatArchiveStateChangedPayload',
  pinAdded: 'PinUpdatePayload',
  threadPinAdded: 'PinUpdatePayload',
  pinRemoved: 'PinUpdatePayload',
  threadPinRemoved: 'PinUpdatePayload',
  stickerPackOrderUpdated: 'StickerPackOrderUpdatePayload',
  friendRequestReceived: 0,
  friendRequestResolved: 'FriendRequestResolvedPayload',
  friendshipRemoved: 0,
};
