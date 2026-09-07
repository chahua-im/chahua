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
  AttachmentResponse: {
    id: 1,
  },
  AvatarUploadUrlResponse: {
    imageId: 1,
  },
  BulkDeletedPayload: {
    chatId: 1,
    messageIds: [1],
  },
  ChatArchiveStateChangedPayload: {
    chatId: 1,
  },
  ChatAttachmentResponse: {
    id: 1,
    messageId: 1,
  },
  ChatListItem: {
    id: 1,
    lastMessage: 'MessagePreview',
    lastReadMessageId: 1,
  },
  CreateChatResponse: {
    id: 1,
  },
  CreateInviteBody: {
    chatId: 1,
    requiredChatId: 1,
  },
  CreateMessageBody: {
    attachmentIds: [1],
    replyToId: 1,
    stickerId: 1,
  },
  CreatePinBody: {
    messageId: 1,
  },
  ExternalCreateInviteRequest: {
    chatId: 1,
  },
  ExternalCreateInviteResponse: {
    chat: 'ExternalInviteChatResponse',
    invite: 'InviteResponse',
  },
  ExternalInviteChatResponse: {
    avatarImageId: 1,
    id: 1,
  },
  FavoriteStickerListResponse: {
    stickers: ['StickerSummary'],
  },
  FriendRelationshipResponse: {
    dmChatId: 1,
  },
  FriendRequestHistoryEntry: {
    id: 1,
  },
  FriendRequestResolvedPayload: {
    requestId: 1,
  },
  FriendRequestResponse: {
    id: 1,
  },
  GroupInfoResponse: {
    avatarImageId: 1,
    id: 1,
  },
  GroupSelectorItem: {
    id: 1,
  },
  InvitePreviewResponse: {
    chat: 'GroupInfoResponse',
    invite: 'InviteResponse',
  },
  InviteResponse: {
    chatId: 1,
    id: 1,
    requiredChatId: 1,
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
  ListGroupsResponse: {
    groups: ['GroupSelectorItem'],
    nextCursor: 1,
  },
  ListInvitesResponse: {
    invites: ['InviteResponse'],
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
  },
  MessagePreview: {
    id: 1,
  },
  MessageResponse: {
    attachments: ['AttachmentResponse'],
    chatId: 1,
    id: 1,
    replyRootId: 1,
    replyToMessage: 'MessagePreview',
    sticker: 'MessageStickerResponse',
  },
  MessageStickerMediaResponse: {
    id: 1,
  },
  MessageStickerResponse: {
    id: 1,
    media: 'MessageStickerMediaResponse',
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
  ReactionUpdatePayload: {
    chatId: 1,
    messageId: 1,
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
    pendingRequest: 'RelationshipPendingRequest',
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
    id: 1,
    originalChatId: 1,
    originalMessageId: 1,
    originalReplyToMessageId: 1,
    originalThreadRootId: 1,
    sticker: 'SavedStickerSnapshot',
  },
  SavedStickerSnapshot: {
    id: 1,
  },
  SearchMessagesResponse: {
    messages: ['MessageResponse'],
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
  StickerDetailResponse: {
    id: 1,
    media: 'StickersStickerMediaResponse',
    packs: ['StickerPackSummary'],
  },
  StickerPackDetailResponse: {
    id: 1,
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
    id: 1,
    previewSticker: 'StickerPackPreviewSticker',
  },
  StickerSummary: {
    id: 1,
    media: 'StickersStickerMediaResponse',
  },
  StickersStickerMediaResponse: {
    id: 1,
  },
  ThreadListItem: {
    chatId: 1,
    lastReadMessageId: 1,
    lastReply: 'MessagePreview',
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
  UpdateChatBody: {
    avatarImageId: 1,
  },
  UpdateMessageBody: {
    attachmentIds: [1],
  },
  UpdateStickerPackOrderItem: {
    stickerPackId: 1,
  },
  UpdateStickerPackOrderRequest: {
    order: ['UpdateStickerPackOrderItem'],
  },
  UploadUrlResponse: {
    attachmentId: 1,
  },
};
export const jsonOperations: JsonOperationCodec[] = [
  {
    method: 'POST',
    path: '/attachments/upload-url',
    response: 'UploadUrlResponse',
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
    method: 'POST',
    path: '/external/social/relationships',
    response: 'RelationshipQueryResponse',
  },
  {
    method: 'GET',
    path: '/friends/requests',
    response: 'ListFriendRequestHistoryResponse',
  },
  {
    method: 'POST',
    path: '/friends/requests',
    response: 'FriendRequestResponse',
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
    response: 'AvatarUploadUrlResponse',
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
    response: 'InviteResponse',
  },
  {
    method: 'POST',
    path: '/invites/redeem',
    response: 'RedeemInviteResponse',
  },
  {
    method: 'POST',
    path: '/invites/send',
    body: 'SendInviteMessageBody',
    response: 'SendInviteMessageResponse',
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
    path: '/stickers/mine/favorites',
    response: 'FavoriteStickerListResponse',
  },
  {
    method: 'POST',
    path: '/stickers/packs',
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
    query: {
      excludeMemberOf: 1,
    },
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
