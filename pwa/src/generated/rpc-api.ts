/** Generated from OpenRPC by scripts/api-codegen.ts. */
import { Service, inject } from '@angular/core';
import { Subject, defer, map, tap, type Observable } from 'rxjs';
import { RpcTransport } from '../app/api/rpc-transport';
import { decodeJsonIds, encodeJsonIds } from '../app/api/json-ids';
import { rpcMethods, rpcSchemas } from './rpc-codecs';
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

@Service()
export class RpcApi {
  readonly #transport = inject(RpcTransport);
  readonly #results = new Subject<{ method: string; result: unknown }>();
  readonly results$ = this.#results.asObservable();

  readonly session = {
    open: (params: SessionOpenParams) => this.#call<SessionOpenResult>('session.open', params),
    ping: (params: SessionPingParams = {}) => this.#call<null>('session.ping', params),
    setAppState: (params: SessionSetAppStateParams = {}) => this.#call<null>('session.setAppState', params),
  } as const;

  readonly auth = {
    createDevSession: (params: AuthCreateDevSessionParams) =>
      this.#call<Shared.AuthTokenResponse>('auth.createDevSession', params),
    refresh: (params: AuthRefreshParams = {}) => this.#call<Shared.AuthTokenResponse>('auth.refresh', params),
  } as const;

  readonly presence = {
    watch: (params: PresenceWatchParams = {}) => this.#call<null>('presence.watch', params),
  } as const;

  readonly conversations = {
    watchUnread: (params: ConversationsWatchUnreadParams) => this.#call<null>('conversations.watchUnread', params),
    watchStates: (params: ConversationsWatchStatesParams) => this.#call<null>('conversations.watchStates', params),
  } as const;

  readonly messages = {
    list: (params: MessagesListParams) => this.#call<Shared.ListMessagesResponse>('messages.list', params),
    send: (params: MessagesSendParams) => this.#call<Shared.MessageResponse>('messages.send', params),
    search: (params: MessagesSearchParams) => this.#call<Shared.SearchMessagesResponse>('messages.search', params),
    get: (params: MessagesGetParams) => this.#call<Shared.MessageResponse>('messages.get', params),
    edit: (params: MessagesEditParams) => this.#call<Shared.MessageResponse>('messages.edit', params),
    delete: (params: MessagesDeleteParams) => this.#call<null>('messages.delete', params),
    deleteMany: (params: MessagesDeleteManyParams) =>
      this.#call<Shared.BulkDeletedPayload>('messages.deleteMany', params),
    forward: (params: MessagesForwardParams) => this.#call<Shared.MessageResponse>('messages.forward', params),
    forwardOne: (params: MessagesForwardOneParams) => this.#call<Shared.MessageResponse>('messages.forwardOne', params),
    listForwardedMessages: (params: MessagesListForwardedMessagesParams) =>
      this.#call<Shared.ForwardedMessagesResponse>('messages.listForwardedMessages', params),
    listForwardedBundleMessages: (params: MessagesListForwardedBundleMessagesParams) =>
      this.#call<Shared.ForwardedMessagesResponse>('messages.listForwardedBundleMessages', params),
    sendInThread: (params: MessagesSendInThreadParams) =>
      this.#call<Shared.MessageResponse>('messages.sendInThread', params),
  } as const;

  readonly reactions = {
    list: (params: ReactionsListParams) => this.#call<Shared.ReactionDetailResponse>('reactions.list', params),
    add: (params: ReactionsAddParams) => this.#call<null>('reactions.add', params),
    remove: (params: ReactionsRemoveParams) => this.#call<null>('reactions.remove', params),
  } as const;

  readonly pins = {
    list: (params: PinsListParams) => this.#call<Shared.ListPinsResponse>('pins.list', params),
    create: (params: PinsCreateParams) => this.#call<Shared.PinResponse>('pins.create', params),
    delete: (params: PinsDeleteParams) => this.#call<null>('pins.delete', params),
    listForThread: (params: PinsListForThreadParams) =>
      this.#call<Shared.ListPinsResponse>('pins.listForThread', params),
    createForThread: (params: PinsCreateForThreadParams) =>
      this.#call<Shared.PinResponse>('pins.createForThread', params),
    deleteForThread: (params: PinsDeleteForThreadParams) => this.#call<null>('pins.deleteForThread', params),
  } as const;

  readonly savedMessages = {
    listForChat: (params: SavedMessagesListForChatParams) =>
      this.#call<Shared.ListSavedMessagesResponse>('savedMessages.listForChat', params),
    list: (params: SavedMessagesListParams = {}) =>
      this.#call<Shared.ListSavedMessagesResponse>('savedMessages.list', params),
    save: (params: SavedMessagesSaveParams) => this.#call<Shared.SavedMessageResponse>('savedMessages.save', params),
    deleteByMessage: (params: SavedMessagesDeleteByMessageParams) =>
      this.#call<null>('savedMessages.deleteByMessage', params),
    delete: (params: SavedMessagesDeleteParams) => this.#call<null>('savedMessages.delete', params),
    listForwardedMessages: (params: SavedMessagesListForwardedMessagesParams) =>
      this.#call<Shared.ForwardedMessagesResponse>('savedMessages.listForwardedMessages', params),
    listForwardedBundleMessages: (params: SavedMessagesListForwardedBundleMessagesParams) =>
      this.#call<Shared.ForwardedMessagesResponse>('savedMessages.listForwardedBundleMessages', params),
  } as const;

  readonly chats = {
    list: (params: ChatsListParams = {}) => this.#call<Shared.ListChatsResponse>('chats.list', params),
    getTotalUnreadCount: (params: ChatsGetTotalUnreadCountParams = {}) =>
      this.#call<Shared.UnreadCountResponse>('chats.getTotalUnreadCount', params),
    archive: (params: ChatsArchiveParams) => this.#call<null>('chats.archive', params),
    unarchive: (params: ChatsUnarchiveParams) => this.#call<null>('chats.unarchive', params),
    markAsRead: (params: ChatsMarkAsReadParams) =>
      this.#call<Shared.MarkChatReadStateResponse>('chats.markAsRead', params),
    markAsUnread: (params: ChatsMarkAsUnreadParams) =>
      this.#call<Shared.MarkChatReadStateResponse>('chats.markAsUnread', params),
    getUnreadCount: (params: ChatsGetUnreadCountParams) =>
      this.#call<Shared.MarkChatReadStateResponse>('chats.getUnreadCount', params),
    getReadReceipt: (params: ChatsGetReadReceiptParams) =>
      this.#call<Shared.ReadReceiptResponse>('chats.getReadReceipt', params),
    listMentions: (params: ChatsListMentionsParams) =>
      this.#call<Shared.UnreadMentionIdsResponse>('chats.listMentions', params),
    listUnreadReactions: (params: ChatsListUnreadReactionsParams) =>
      this.#call<Shared.UnreadReactionIdsResponse>('chats.listUnreadReactions', params),
    acknowledgeReactions: (params: ChatsAcknowledgeReactionsParams) =>
      this.#call<Shared.UnreadReactionsAckResponse>('chats.acknowledgeReactions', params),
  } as const;

  readonly threads = {
    list: (params: ThreadsListParams = {}) => this.#call<Shared.ListThreadsResponse>('threads.list', params),
    getUnreadCount: (params: ThreadsGetUnreadCountParams = {}) =>
      this.#call<Shared.UnreadThreadCountResponse>('threads.getUnreadCount', params),
    listForChat: (params: ThreadsListForChatParams) =>
      this.#call<Shared.ListChatThreadsResponse>('threads.listForChat', params),
    listParticipants: (params: ThreadsListParticipantsParams) =>
      this.#call<Shared.ListThreadParticipantsResponse>('threads.listParticipants', params),
    markAsRead: (params: ThreadsMarkAsReadParams) =>
      this.#call<Shared.MarkThreadReadResponse>('threads.markAsRead', params),
    getReadState: (params: ThreadsGetReadStateParams) =>
      this.#call<Shared.ThreadReadStateResponse>('threads.getReadState', params),
    getSubscriptionStatus: (params: ThreadsGetSubscriptionStatusParams) =>
      this.#call<Shared.ThreadSubscriptionStatusResponse>('threads.getSubscriptionStatus', params),
    subscribe: (params: ThreadsSubscribeParams) => this.#call<null>('threads.subscribe', params),
    unsubscribe: (params: ThreadsUnsubscribeParams) => this.#call<null>('threads.unsubscribe', params),
    archive: (params: ThreadsArchiveParams) => this.#call<null>('threads.archive', params),
    unarchive: (params: ThreadsUnarchiveParams) => this.#call<null>('threads.unarchive', params),
  } as const;

  readonly attachments = {
    listForChat: (params: AttachmentsListForChatParams) =>
      this.#call<Shared.ListChatAttachmentsResponse>('attachments.listForChat', params),
    createUploadUrl: (params: AttachmentsCreateUploadUrlParams) =>
      this.#call<Shared.UploadUrlResponse>('attachments.createUploadUrl', params),
    getConfig: (params: AttachmentsGetConfigParams = {}) =>
      this.#call<Shared.AttachmentConfigResponse>('attachments.getConfig', params),
  } as const;

  readonly groups = {
    list: (params: GroupsListParams = {}) => this.#call<Shared.ListGroupsResponse>('groups.list', params),
    create: (params: GroupsCreateParams = {}) => this.#call<Shared.CreateChatResponse>('groups.create', params),
    get: (params: GroupsGetParams) => this.#call<Shared.GroupInfoResponse>('groups.get', params),
    update: (params: GroupsUpdateParams) => this.#call<Shared.GroupInfoResponse>('groups.update', params),
    createAvatarUploadUrl: (params: GroupsCreateAvatarUploadUrlParams) =>
      this.#call<Shared.AvatarUploadUrlResponse>('groups.createAvatarUploadUrl', params),
    mute: (params: GroupsMuteParams) => this.#call<Shared.MuteResponse>('groups.mute', params),
    unmute: (params: GroupsUnmuteParams) => this.#call<null>('groups.unmute', params),
    updateNotificationSetting: (params: GroupsUpdateNotificationSettingParams) =>
      this.#call<Shared.ChatNotificationSettingResponse>('groups.updateNotificationSetting', params),
    updateSpeakingMode: (params: GroupsUpdateSpeakingModeParams) =>
      this.#call<Shared.GroupSpeakingModeResponse>('groups.updateSpeakingMode', params),
    listMembers: (params: GroupsListMembersParams) =>
      this.#call<Shared.ListMembersResponse>('groups.listMembers', params),
    addMember: (params: GroupsAddMemberParams) => this.#call<Shared.MemberResponse>('groups.addMember', params),
    removeMember: (params: GroupsRemoveMemberParams) => this.#call<null>('groups.removeMember', params),
    updateMember: (params: GroupsUpdateMemberParams) =>
      this.#call<Shared.MemberResponse>('groups.updateMember', params),
    updateMemberSpeakingMode: (params: GroupsUpdateMemberSpeakingModeParams) =>
      this.#call<Shared.MemberSpeakingModeResponse>('groups.updateMemberSpeakingMode', params),
  } as const;

  readonly invites = {
    list: (params: InvitesListParams = {}) => this.#call<Shared.ListInvitesResponse>('invites.list', params),
    create: (params: InvitesCreateParams) => this.#call<Shared.InviteResponse>('invites.create', params),
    send: (params: InvitesSendParams) => this.#call<Shared.SendInviteMessageResponse>('invites.send', params),
    get: (params: InvitesGetParams) => this.#call<Shared.InviteResponse>('invites.get', params),
    getByCode: (params: InvitesGetByCodeParams) =>
      this.#call<Shared.InvitePreviewResponse>('invites.getByCode', params),
    update: (params: InvitesUpdateParams) => this.#call<Shared.InviteResponse>('invites.update', params),
    delete: (params: InvitesDeleteParams) => this.#call<null>('invites.delete', params),
    redeem: (params: InvitesRedeemParams) => this.#call<Shared.RedeemInviteResponse>('invites.redeem', params),
  } as const;

  readonly friends = {
    list: (params: FriendsListParams = {}) => this.#call<Shared.ListFriendsResponse>('friends.list', params),
    getRelationship: (params: FriendsGetRelationshipParams) =>
      this.#call<Shared.FriendRelationshipResponse>('friends.getRelationship', params),
    remove: (params: FriendsRemoveParams) => this.#call<null>('friends.remove', params),
    createRequest: (params: FriendsCreateRequestParams) =>
      this.#call<Shared.FriendRequestResponse>('friends.createRequest', params),
    listRequests: (params: FriendsListRequestsParams = {}) =>
      this.#call<Shared.ListFriendRequestHistoryResponse>('friends.listRequests', params),
    getPendingRequestCount: (params: FriendsGetPendingRequestCountParams = {}) =>
      this.#call<Shared.PendingFriendRequestCountResponse>('friends.getPendingRequestCount', params),
    acceptRequest: (params: FriendsAcceptRequestParams) =>
      this.#call<Shared.FriendRequestResponse>('friends.acceptRequest', params),
    rejectRequest: (params: FriendsRejectRequestParams) =>
      this.#call<Shared.FriendRequestResponse>('friends.rejectRequest', params),
    archiveRequest: (params: FriendsArchiveRequestParams) => this.#call<null>('friends.archiveRequest', params),
    getSettings: (params: FriendsGetSettingsParams = {}) =>
      this.#call<Shared.FriendSettingsResponse>('friends.getSettings', params),
    updateSettings: (params: FriendsUpdateSettingsParams) =>
      this.#call<Shared.FriendSettingsResponse>('friends.updateSettings', params),
    getAddInfo: (params: FriendsGetAddInfoParams) =>
      this.#call<Shared.FriendAddInfoResponse>('friends.getAddInfo', params),
    getPresenceSettings: (params: FriendsGetPresenceSettingsParams) =>
      this.#call<Shared.FriendPresenceSettingsResponse>('friends.getPresenceSettings', params),
    updatePresenceSettings: (params: FriendsUpdatePresenceSettingsParams) =>
      this.#call<Shared.FriendPresenceSettingsResponse>('friends.updatePresenceSettings', params),
    getReadReceiptSettings: (params: FriendsGetReadReceiptSettingsParams) =>
      this.#call<Shared.FriendReadReceiptSettingsResponse>('friends.getReadReceiptSettings', params),
    updateReadReceiptSettings: (params: FriendsUpdateReadReceiptSettingsParams) =>
      this.#call<Shared.FriendReadReceiptSettingsResponse>('friends.updateReadReceiptSettings', params),
  } as const;

  readonly privacy = {
    getPresenceSettings: (params: PrivacyGetPresenceSettingsParams = {}) =>
      this.#call<Shared.PresenceSettingsResponse>('privacy.getPresenceSettings', params),
    updatePresenceSettings: (params: PrivacyUpdatePresenceSettingsParams) =>
      this.#call<Shared.PresenceSettingsResponse>('privacy.updatePresenceSettings', params),
    getReadReceiptSettings: (params: PrivacyGetReadReceiptSettingsParams = {}) =>
      this.#call<Shared.ReadReceiptSettingsResponse>('privacy.getReadReceiptSettings', params),
    updateReadReceiptSettings: (params: PrivacyUpdateReadReceiptSettingsParams) =>
      this.#call<Shared.ReadReceiptSettingsResponse>('privacy.updateReadReceiptSettings', params),
    listExceptions: (params: PrivacyListExceptionsParams) =>
      this.#call<Shared.PrivacyExceptionsResponse>('privacy.listExceptions', params),
    clearExceptions: (params: PrivacyClearExceptionsParams) => this.#call<null>('privacy.clearExceptions', params),
  } as const;

  readonly blocks = {
    list: (params: BlocksListParams = {}) => this.#call<Shared.ListBlocksResponse>('blocks.list', params),
    create: (params: BlocksCreateParams) => this.#call<null>('blocks.create', params),
    delete: (params: BlocksDeleteParams) => this.#call<null>('blocks.delete', params),
  } as const;

  readonly users = {
    getMe: (params: UsersGetMeParams = {}) => this.#call<Shared.MeResponse>('users.getMe', params),
    updateStickerPackOrder: (params: UsersUpdateStickerPackOrderParams) =>
      this.#call<null>('users.updateStickerPackOrder', params),
    updateChatSettings: (params: UsersUpdateChatSettingsParams) =>
      this.#call<Shared.ChatSettings>('users.updateChatSettings', params),
    search: (params: UsersSearchParams = {}) => this.#call<Shared.SearchUsersResponse>('users.search', params),
    getNotificationSettings: (params: UsersGetNotificationSettingsParams = {}) =>
      this.#call<Shared.NotificationSettingsResponse>('users.getNotificationSettings', params),
    updateNotificationSettings: (params: UsersUpdateNotificationSettingsParams = {}) =>
      this.#call<Shared.NotificationSettingsResponse>('users.updateNotificationSettings', params),
    listNotificationExceptions: (params: UsersListNotificationExceptionsParams) =>
      this.#call<Shared.NotificationExceptionsResponse>('users.listNotificationExceptions', params),
    clearNotificationExceptions: (params: UsersClearNotificationExceptionsParams) =>
      this.#call<Shared.NotificationExceptionsCleared>('users.clearNotificationExceptions', params),
  } as const;

  readonly push = {
    getVapidPublicKey: (params: PushGetVapidPublicKeyParams = {}) =>
      this.#call<Shared.VapidPublicKeyResponse>('push.getVapidPublicKey', params),
    getSubscriptionStatus: (params: PushGetSubscriptionStatusParams = {}) =>
      this.#call<Shared.SubscriptionStatusResponse>('push.getSubscriptionStatus', params),
    subscribe: (params: PushSubscribeParams = {}) => this.#call<null>('push.subscribe', params),
    unsubscribe: (params: PushUnsubscribeParams = {}) => this.#call<null>('push.unsubscribe', params),
  } as const;

  readonly stickers = {
    listPacks: (params: StickersListPacksParams = {}) =>
      this.#call<Shared.StickerPackDiscoveryResponse>('stickers.listPacks', params),
    createFromMessage: (params: StickersCreateFromMessageParams) =>
      this.#call<Shared.StickerSummary>('stickers.createFromMessage', params),
    createPack: (params: StickersCreatePackParams) =>
      this.#call<Shared.StickerPackSummary>('stickers.createPack', params),
    getPack: (params: StickersGetPackParams) =>
      this.#call<Shared.StickerPackDetailResponse>('stickers.getPack', params),
    updatePack: (params: StickersUpdatePackParams) =>
      this.#call<Shared.StickerPackSummary>('stickers.updatePack', params),
    deletePack: (params: StickersDeletePackParams) => this.#call<null>('stickers.deletePack', params),
    listSubscribedPacks: (params: StickersListSubscribedPacksParams = {}) =>
      this.#call<Shared.StickerPackListResponse>('stickers.listSubscribedPacks', params),
    listOwnedPacks: (params: StickersListOwnedPacksParams = {}) =>
      this.#call<Shared.StickerPackListResponse>('stickers.listOwnedPacks', params),
    subscribeToPack: (params: StickersSubscribeToPackParams) => this.#call<null>('stickers.subscribeToPack', params),
    unsubscribeFromPack: (params: StickersUnsubscribeFromPackParams) =>
      this.#call<null>('stickers.unsubscribeFromPack', params),
    addToPack: (params: StickersAddToPackParams) => this.#call<null>('stickers.addToPack', params),
    removeFromPack: (params: StickersRemoveFromPackParams) => this.#call<null>('stickers.removeFromPack', params),
    get: (params: StickersGetParams) => this.#call<Shared.StickerDetailResponse>('stickers.get', params),
    favorite: (params: StickersFavoriteParams) => this.#call<null>('stickers.favorite', params),
    unfavorite: (params: StickersUnfavoriteParams) => this.#call<null>('stickers.unfavorite', params),
    listFavorites: (params: StickersListFavoritesParams = {}) =>
      this.#call<Shared.FavoriteStickerListResponse>('stickers.listFavorites', params),
  } as const;

  readonly serviceTokens = {
    create: (params: ServiceTokensCreateParams) =>
      this.#call<Shared.CreateServiceTokenResponse>('serviceTokens.create', params),
    list: (params: ServiceTokensListParams = {}) =>
      this.#call<Shared.ListServiceTokensResponse>('serviceTokens.list', params),
    delete: (params: ServiceTokensDeleteParams) => this.#call<null>('serviceTokens.delete', params),
    rotate: (params: ServiceTokensRotateParams) =>
      this.#call<Shared.RotateServiceTokenResponse>('serviceTokens.rotate', params),
  } as const;

  readonly sessions = {
    listClients: (params: SessionsListClientsParams = {}) =>
      this.#call<
        Array<{ clientId: string; connectionId: number; lastAppVersion?: string; status: Shared.OnlineClientStatus }>
      >('sessions.listClients', params),
  } as const;

  #call<Result>(method: string, params: object): Observable<Result> {
    return defer(() => {
      const codecs = rpcMethods[method];
      const request = decodeJsonIds(params, codecs?.params, rpcSchemas) as object;
      return this.#transport.call<unknown>(method, request).pipe(
        map((result) => encodeJsonIds(result, codecs?.result, rpcSchemas) as Result),
        tap((result) => this.#results.next({ method, result })),
      );
    });
  }
}
