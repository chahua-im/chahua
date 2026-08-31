import type { PayloadAction } from '@reduxjs/toolkit';
import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { RootState } from './index';
import { toMessagePreview, type MessagePreview, type MessageResponse } from '@/api/messages';
import type { ChatListEntry } from '@/api/chats';
import type { GroupKind } from '@/api/chats';
import type { MemberSummary } from '@/api/users';
import type { GroupRole } from '@/api/group';
import { UNREAD_BADGE_COUNT_CAP } from '@/utils/unreadBadge';
import { compareMessageOrder, isSameMessage } from './messageProjection';
import { prependMentionId, type MentionIdCacheStatus } from './mentionIdCache';

export interface ChatMeta {
  name: string | null;
  description?: string | null;
  avatar?: string | null;
  avatarImageId?: string | null;
  visibility?: string;
  createdAt?: string;
  myRole?: GroupRole | null;
  /** 'dm' for 1:1 conversations; absent/'group' for normal group chats. */
  kind?: GroupKind;
  /** For DM chats, the other participant. */
  peer?: MemberSummary | null;
}

interface ChatListMeta {
  lastMessageAt?: string | null;
  unreadCount?: number;
  unreadMentions?: number;
  unreadMentionIds?: string[];
  unreadMentionIdsStatus?: MentionIdCacheStatus;
  lastReadMessageId?: string | null;
  lastMessage?: MessagePreview | null;
  inList?: boolean;
  mutedUntil?: string | null;
  archived?: boolean;
}

interface ChatStateEntry {
  details: ChatMeta;
  listSnapshot?: ChatListMeta;
  liveProjection?: ChatListMeta;
}

export interface ChatListBucketState {
  nextCursor: string | null;
  isLoaded: boolean;
  isLoading: boolean;
  pageDepth: number;
}

export interface ChatsState {
  byId: Record<string, ChatStateEntry>;
  buckets: Record<'active' | 'archived', ChatListBucketState>;
}

const initialState: ChatsState = {
  byId: {},
  buckets: {
    active: { nextCursor: null, isLoaded: false, isLoading: false, pageDepth: 0 },
    archived: { nextCursor: null, isLoaded: false, isLoading: false, pageDepth: 0 },
  },
};

function getChatEntry(state: ChatsState, chatId: string): ChatStateEntry {
  const existing = state.byId[chatId];
  if (existing) return existing;

  const created: ChatStateEntry = {
    details: { name: null },
  };
  state.byId[chatId] = created;
  return created;
}

function chooseEffectiveLatest(snapshot?: ChatListMeta, live?: ChatListMeta): MessagePreview | null {
  const liveOverridesLatest = !!live && Object.prototype.hasOwnProperty.call(live, 'lastMessage');
  const snapshotMessage = snapshot?.lastMessage ?? null;
  const liveMessage = live?.lastMessage ?? null;

  if (liveOverridesLatest && liveMessage === null) return null;
  if (!liveMessage) return snapshotMessage;
  if (!snapshotMessage) return liveMessage;
  if (isSameMessage(liveMessage, snapshotMessage)) return liveMessage;

  return compareMessageOrder(liveMessage, snapshotMessage) >= 0 ? liveMessage : snapshotMessage;
}

function resolveMutedUntil(snapshot?: ChatListMeta, live?: ChatListMeta): string | null {
  if (live && Object.prototype.hasOwnProperty.call(live, 'mutedUntil')) {
    return live.mutedUntil ?? null;
  }

  return snapshot?.mutedUntil ?? null;
}

function getEffectiveListMeta(entry?: ChatStateEntry): ChatListMeta {
  const snapshot = entry?.listSnapshot;
  const live = entry?.liveProjection;
  const latest = chooseEffectiveLatest(snapshot, live);

  return {
    inList: live?.inList ?? snapshot?.inList ?? false,
    unreadCount: live?.unreadCount ?? snapshot?.unreadCount ?? 0,
    unreadMentions: live?.unreadMentions ?? snapshot?.unreadMentions ?? 0,
    unreadMentionIds: live?.unreadMentionIds ?? snapshot?.unreadMentionIds,
    unreadMentionIdsStatus: live?.unreadMentionIdsStatus ?? snapshot?.unreadMentionIdsStatus ?? 'idle',
    lastReadMessageId: live?.lastReadMessageId ?? snapshot?.lastReadMessageId ?? null,
    lastMessage: latest,
    lastMessageAt: latest?.createdAt ?? snapshot?.lastMessageAt ?? null,
    archived: live?.archived ?? snapshot?.archived ?? false,
  };
}

function reconcileAuthoritativeListFields(
  entry: ChatStateEntry,
  snapshotUnreadCount: number,
  snapshotUnreadMentions: number,
): void {
  if (!entry.liveProjection) return;

  const liveUnreadCount = entry.liveProjection.unreadCount;
  // Chat list counts are capped for badge queries; keep exact per-chat counts while they are fresher.
  if (
    liveUnreadCount == null ||
    snapshotUnreadCount < UNREAD_BADGE_COUNT_CAP ||
    liveUnreadCount <= snapshotUnreadCount
  ) {
    delete entry.liveProjection.unreadCount;
  }

  const liveUnreadMentions = entry.liveProjection.unreadMentions;
  if (
    liveUnreadMentions == null ||
    snapshotUnreadMentions < UNREAD_BADGE_COUNT_CAP ||
    liveUnreadMentions <= snapshotUnreadMentions
  ) {
    delete entry.liveProjection.unreadMentions;
    // The live mention id list was computed against the superseded count; drop it
    // so the jumper refetches against the authoritative snapshot instead of
    // cycling ids that may already be read on another device (matches threadsSlice).
    delete entry.liveProjection.unreadMentionIds;
    entry.liveProjection.unreadMentionIdsStatus = 'idle';
  }
  delete entry.liveProjection.lastReadMessageId;
}

const chatsSlice = createSlice({
  name: 'chats',
  initialState,
  reducers: {
    setChatMeta(state, action: PayloadAction<{ chatId: string; meta: Partial<ChatMeta> }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      entry.details = { ...entry.details, ...action.payload.meta };
    },
    setChatsMeta(state, action: PayloadAction<Record<string, Partial<ChatMeta>>>) {
      for (const [chatId, meta] of Object.entries(action.payload)) {
        const entry = getChatEntry(state, chatId);
        entry.details = { ...entry.details, ...meta };
      }
    },
    setChatsList(
      state,
      action: PayloadAction<{
        chats: ChatListEntry[];
        nextCursor: string | null;
        archived?: boolean;
        pageDepth?: number;
      }>,
    ) {
      const archived = action.payload.archived ?? false;
      const key = archived ? 'archived' : 'active';
      const nextIds = new Set(action.payload.chats.map((chat) => chat.id));

      for (const [chatId, entry] of Object.entries(state.byId)) {
        const snapshotArchived = entry.listSnapshot?.archived ?? false;
        if (snapshotArchived !== archived || nextIds.has(chatId)) continue;

        entry.listSnapshot = {
          ...entry.listSnapshot,
          inList: false,
          archived,
        };
      }

      const seenIds = new Set<string>();
      for (const chat of action.payload.chats) {
        if (seenIds.has(chat.id)) continue;
        seenIds.add(chat.id);
        const entry = getChatEntry(state, chat.id);
        entry.details = {
          ...entry.details,
          name: chat.name ?? entry.details.name,
          avatar: chat.avatar ?? entry.details.avatar ?? null,
          kind: chat.kind ?? entry.details.kind,
          peer: chat.peer ?? entry.details.peer ?? null,
        };
        entry.listSnapshot = {
          lastMessage: chat.lastMessage,
          lastMessageAt: chat.lastMessageAt,
          unreadCount: chat.unreadCount,
          unreadMentions: chat.unreadMentions,
          lastReadMessageId: chat.lastReadMessageId,
          inList: true,
          mutedUntil: chat.mutedUntil,
          archived: chat.archived ?? archived,
        };
        reconcileAuthoritativeListFields(entry, chat.unreadCount, chat.unreadMentions);
      }
      state.buckets[key] = {
        nextCursor: action.payload.nextCursor,
        isLoaded: true,
        isLoading: state.buckets[key].isLoading,
        pageDepth: action.payload.pageDepth ?? 1,
      };
    },
    appendChatsList(
      state,
      action: PayloadAction<{ chats: ChatListEntry[]; nextCursor: string | null; archived?: boolean }>,
    ) {
      const archived = action.payload.archived ?? false;
      const key = archived ? 'archived' : 'active';
      const existingIds = new Set(
        Object.entries(state.byId)
          .filter(([, entry]) => entry.listSnapshot?.inList && entry.listSnapshot.archived === archived)
          .map(([chatId]) => chatId),
      );

      for (const chat of action.payload.chats) {
        if (existingIds.has(chat.id)) continue;
        existingIds.add(chat.id);
        const entry = getChatEntry(state, chat.id);
        entry.details = {
          ...entry.details,
          name: chat.name ?? entry.details.name,
          avatar: chat.avatar ?? entry.details.avatar ?? null,
          kind: chat.kind ?? entry.details.kind,
          peer: chat.peer ?? entry.details.peer ?? null,
        };
        entry.listSnapshot = {
          lastMessage: chat.lastMessage,
          lastMessageAt: chat.lastMessageAt,
          unreadCount: chat.unreadCount,
          unreadMentions: chat.unreadMentions,
          lastReadMessageId: chat.lastReadMessageId,
          inList: true,
          mutedUntil: chat.mutedUntil,
          archived: chat.archived ?? archived,
        };
        reconcileAuthoritativeListFields(entry, chat.unreadCount, chat.unreadMentions);
      }
      state.buckets[key].nextCursor = action.payload.nextCursor;
      state.buckets[key].isLoaded = true;
      state.buckets[key].pageDepth += 1;
    },
    setChatsListLoading(state, action: PayloadAction<{ archived?: boolean; isLoading: boolean }>) {
      state.buckets[action.payload.archived ? 'archived' : 'active'].isLoading = action.payload.isLoading;
    },
    setChatMutedUntil(state, action: PayloadAction<{ chatId: string; mutedUntil: string | null }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      entry.liveProjection = {
        ...entry.liveProjection,
        mutedUntil: action.payload.mutedUntil,
      };
    },
    setChatInList(state, action: PayloadAction<{ chatId: string; inList: boolean }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      entry.liveProjection = {
        ...entry.liveProjection,
        inList: action.payload.inList,
      };
    },
    setChatArchived(state, action: PayloadAction<{ chatId: string; archived: boolean }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      entry.liveProjection = {
        ...entry.liveProjection,
        archived: action.payload.archived,
      };
    },
    projectChatMessageAdded(
      state,
      action: PayloadAction<{ chatId: string; message: MessageResponse; incrementUnread: boolean }>,
    ) {
      const { chatId, message, incrementUnread } = action.payload;
      const entry = getChatEntry(state, chatId);
      const current = getEffectiveListMeta(entry);
      entry.liveProjection = {
        ...entry.liveProjection,
        inList: true,
        unreadCount: (entry.liveProjection?.unreadCount ?? current.unreadCount ?? 0) + (incrementUnread ? 1 : 0),
      };

      if (message.replyRootId || message.isDeleted) {
        return;
      }

      const currentLatest = current.lastMessage;
      if (!currentLatest || compareMessageOrder(message, currentLatest) >= 0) {
        entry.liveProjection.lastMessage = toMessagePreview(message);
        entry.liveProjection.lastMessageAt = message.createdAt;
      }
    },
    projectChatMessageConfirmed(
      state,
      action: PayloadAction<{ chatId: string; clientGeneratedId: string; message: MessageResponse }>,
    ) {
      const { chatId, clientGeneratedId, message } = action.payload;
      const entry = getChatEntry(state, chatId);
      const current = getEffectiveListMeta(entry);
      entry.liveProjection = {
        ...entry.liveProjection,
        inList: true,
      };

      if (message.replyRootId || message.isDeleted) {
        return;
      }

      const currentLatest = current.lastMessage;
      const isConfirmingCurrent =
        !!currentLatest &&
        (currentLatest.clientGeneratedId === clientGeneratedId || currentLatest.id === clientGeneratedId);

      if (isConfirmingCurrent || !currentLatest || compareMessageOrder(message, currentLatest) >= 0) {
        entry.liveProjection.lastMessage = toMessagePreview(message);
        entry.liveProjection.lastMessageAt = message.createdAt;
      }
    },
    setChatUnreadCount(state, action: PayloadAction<{ chatId: string; unreadCount: number }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      entry.liveProjection = {
        ...entry.liveProjection,
        unreadCount: action.payload.unreadCount,
        inList: true,
      };
    },
    setChatUnreadMentions(state, action: PayloadAction<{ chatId: string; unreadMentions: number }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      // Server count is authoritative; the cached id list may no longer match, so invalidate.
      // useMentionJumper's eager-fetch repopulates when the badge is still > 0.
      entry.liveProjection = {
        ...entry.liveProjection,
        unreadMentions: action.payload.unreadMentions,
        unreadMentionIds: [],
        unreadMentionIdsStatus: 'idle',
        inList: true,
      };
    },
    incrementChatUnreadMentions(state, action: PayloadAction<{ chatId: string; messageId?: string }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      const current = getEffectiveListMeta(entry);
      // If the id cache is loaded, prepend the new mention id (deduped, newest-first) so live
      // mentions are jumpable without a refetch. Otherwise leave the cache invalid; the eager-fetch
      // will include this mention since it is still unread.
      const existingIds = current.unreadMentionIds ?? [];
      const nextIds =
        action.payload.messageId && current.unreadMentionIdsStatus === 'ready'
          ? prependMentionId(current.unreadMentionIds, action.payload.messageId)
          : existingIds;
      const nextLive = {
        ...entry.liveProjection,
        unreadMentions: (current.unreadMentions ?? 0) + 1,
        unreadMentionIds: nextIds,
        inList: true,
      };
      // A fetch was in flight when this mention arrived: its response predates the mention,
      // so invalidate the cache — the resolution must not claim it is fresh.
      if (current.unreadMentionIdsStatus === 'loading') {
        nextLive.unreadMentionIdsStatus = 'idle';
      }
      entry.liveProjection = nextLive;
    },
    setChatUnreadMentionIds(state, action: PayloadAction<{ chatId: string; ids: string[] }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      // Only claim the cache is fresh if this response is still the acknowledged fetch: a
      // mention that arrived mid-flight resets the status to 'idle', and caching the
      // pre-mention list as 'ready' would strand that mention until the next invalidation.
      if (entry.liveProjection?.unreadMentionIdsStatus !== 'loading') {
        entry.liveProjection = {
          ...entry.liveProjection,
          unreadMentionIdsStatus: 'idle',
          inList: true,
        };
        return;
      }
      entry.liveProjection = {
        ...entry.liveProjection,
        unreadMentionIds: action.payload.ids,
        unreadMentionIdsStatus: 'ready',
        inList: true,
      };
    },
    setChatUnreadMentionIdsStatus(state, action: PayloadAction<{ chatId: string; status: MentionIdCacheStatus }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      entry.liveProjection = {
        ...entry.liveProjection,
        unreadMentionIdsStatus: action.payload.status,
        inList: true,
      };
    },
    projectChatMessagePatched(
      state,
      action: PayloadAction<{
        chatId: string;
        messageId: string;
        message: MessageResponse;
        fallbackMessage: MessageResponse | null;
      }>,
    ) {
      const { chatId, messageId, message, fallbackMessage } = action.payload;
      const entry = state.byId[chatId];
      if (!entry) return;

      const current = getEffectiveListMeta(entry);
      const currentLatest = current.lastMessage;
      const isCurrentLatest =
        !!currentLatest &&
        (currentLatest.id === messageId || currentLatest.clientGeneratedId === message.clientGeneratedId);

      if (!isCurrentLatest) return;

      entry.liveProjection = {
        ...entry.liveProjection,
        inList: true,
      };

      if (message.isDeleted) {
        entry.liveProjection.lastMessage = fallbackMessage ? toMessagePreview(fallbackMessage) : null;
        entry.liveProjection.lastMessageAt = fallbackMessage?.createdAt ?? null;
        return;
      }

      entry.liveProjection.lastMessage = toMessagePreview(message);
      entry.liveProjection.lastMessageAt = message.createdAt;
    },
    markChatAsRead(state, action: PayloadAction<{ chatId: string; lastReadMessageId?: string | null }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      entry.liveProjection = {
        ...entry.liveProjection,
        unreadCount: 0,
        unreadMentions: 0,
        unreadMentionIds: [],
        unreadMentionIdsStatus: 'idle',
        lastReadMessageId:
          action.payload.lastReadMessageId !== undefined
            ? action.payload.lastReadMessageId
            : (entry.liveProjection?.lastReadMessageId ?? entry.listSnapshot?.lastReadMessageId ?? null),
        inList: true,
      };
    },
    setChatLastReadMessageId(state, action: PayloadAction<{ chatId: string; lastReadMessageId: string | null }>) {
      const entry = getChatEntry(state, action.payload.chatId);
      entry.liveProjection = {
        ...entry.liveProjection,
        lastReadMessageId: action.payload.lastReadMessageId,
        inList: true,
      };
    },
  },
});

export const {
  setChatMeta,
  setChatsMeta,
  setChatsList,
  appendChatsList,
  setChatsListLoading,
  setChatMutedUntil,
  setChatInList,
  setChatArchived,
  projectChatMessageAdded,
  projectChatMessageConfirmed,
  setChatUnreadCount,
  setChatUnreadMentions,
  setChatUnreadMentionIds,
  setChatUnreadMentionIdsStatus,
  incrementChatUnreadMentions,
  projectChatMessagePatched,
  markChatAsRead,
  setChatLastReadMessageId,
} = chatsSlice.actions;

export const selectChatMeta = (state: RootState, chatId: string): ChatMeta | undefined =>
  state.chats.byId[chatId]?.details;
export const selectChatName = (state: RootState, chatId: string): string | null =>
  state.chats.byId[chatId]?.details.name ?? null;

export function selectIsChatMuted(state: RootState, chatId: string): boolean {
  const entry = state.chats.byId[chatId];
  const mutedUntil = resolveMutedUntil(entry?.listSnapshot, entry?.liveProjection);
  if (!mutedUntil) return false;
  return new Date(mutedUntil) > new Date();
}

export function selectChatMutedUntil(state: RootState, chatId: string): string | null {
  const entry = state.chats.byId[chatId];
  return resolveMutedUntil(entry?.listSnapshot, entry?.liveProjection);
}

export const selectChatsNextCursor = (state: RootState, archived = false) =>
  state.chats.buckets[archived ? 'archived' : 'active'].nextCursor;
export const selectChatsLoading = (state: RootState, archived = false) =>
  state.chats.buckets[archived ? 'archived' : 'active'].isLoading;

export function selectChatLastReadMessageId(state: RootState, chatId: string): string | null {
  const entry = state.chats.byId[chatId];
  return getEffectiveListMeta(entry).lastReadMessageId ?? null;
}

export function selectChatUnreadCount(state: RootState, chatId: string): number {
  const entry = state.chats.byId[chatId];
  return getEffectiveListMeta(entry).unreadCount ?? 0;
}

export function selectChatUnreadMentions(state: RootState, chatId: string): number {
  const entry = state.chats.byId[chatId];
  return getEffectiveListMeta(entry).unreadMentions ?? 0;
}

export function selectChatUnreadMentionIds(state: RootState, chatId: string): string[] {
  const entry = state.chats.byId[chatId];
  return getEffectiveListMeta(entry).unreadMentionIds ?? [];
}

export function selectChatUnreadMentionIdsStatus(state: RootState, chatId: string): MentionIdCacheStatus {
  return getEffectiveListMeta(state.chats.byId[chatId]).unreadMentionIdsStatus ?? 'idle';
}

export function selectIsChatArchived(state: RootState, chatId: string): boolean {
  const entry = state.chats.byId[chatId];
  return getEffectiveListMeta(entry).archived ?? false;
}

const selectChatsById = (state: RootState) => state.chats.byId;

function reduceChatEntries(
  byId: Record<string, ChatStateEntry>,
  archived: boolean,
  transform: (meta: ChatListMeta, entry: ChatStateEntry) => number,
): number {
  let total = 0;
  for (const entry of Object.values(byId)) {
    const meta = getEffectiveListMeta(entry);
    if (!meta.inList || meta.archived !== archived) continue;
    if (!archived) {
      const mutedUntil = resolveMutedUntil(entry?.listSnapshot, entry?.liveProjection);
      if (mutedUntil && new Date(mutedUntil) > new Date()) continue;
    }
    total += transform(meta, entry);
  }
  return total;
}

function mapChatEntry(id: string, entry: ChatStateEntry): ChatListEntry {
  const listMeta = getEffectiveListMeta(entry);
  return {
    id,
    name: entry.details.name ?? null,
    avatar: entry.details.avatar ?? null,
    lastMessageAt: listMeta.lastMessageAt ?? null,
    unreadCount: listMeta.unreadCount ?? 0,
    unreadMentions: listMeta.unreadMentions ?? 0,
    lastReadMessageId: listMeta.lastReadMessageId ?? null,
    lastMessage: listMeta.lastMessage ?? null,
    mutedUntil: resolveMutedUntil(entry?.listSnapshot, entry?.liveProjection),
    archived: listMeta.archived ?? false,
    kind: entry.details.kind,
    peer: entry.details.peer ?? null,
  };
}

function sortChats(a: ChatListEntry, b: ChatListEntry): number {
  return compareMessageOrder(b.lastMessage, a.lastMessage);
}

export const selectAllChats = createSelector([selectChatsById], (byId): ChatListEntry[] => {
  return Object.entries(byId)
    .filter(([, entry]) => {
      const meta = getEffectiveListMeta(entry);
      return meta.inList && !meta.archived;
    })
    .map(([id, entry]) => mapChatEntry(id, entry))
    .sort(sortChats);
});

export const selectArchivedChats = createSelector([selectChatsById], (byId): ChatListEntry[] => {
  return Object.entries(byId)
    .filter(([, entry]) => {
      const meta = getEffectiveListMeta(entry);
      return meta.inList && !!meta.archived;
    })
    .map(([id, entry]) => mapChatEntry(id, entry))
    .sort(sortChats);
});

export const selectTotalUnreadChatCount = createSelector([selectChatsById], (byId): number =>
  reduceChatEntries(byId, false, (meta) => meta.unreadCount ?? 0),
);

export const selectTotalArchivedUnreadChatCount = createSelector([selectChatsById], (byId): number =>
  reduceChatEntries(byId, true, (meta) => meta.unreadCount ?? 0),
);

export const selectChatsWithUnreadCount = createSelector([selectChatsById], (byId): number =>
  reduceChatEntries(byId, false, (meta) => ((meta.unreadCount ?? 0) > 0 ? 1 : 0)),
);

export const selectArchivedChatsWithUnreadCount = createSelector([selectChatsById], (byId): number =>
  reduceChatEntries(byId, true, (meta) => ((meta.unreadCount ?? 0) > 0 ? 1 : 0)),
);

export default chatsSlice.reducer;
