import type { PayloadAction } from '@reduxjs/toolkit';
import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { RootState } from './index';
import { toMessagePreview, type MessagePreview, type MessageResponse } from '@/api/messages';
import type { ChatListEntry } from '@/api/chats';
import type { GroupKind } from '@/api/dms';
import type { MemberSummary } from '@/api/users';
import type { GroupRole } from '@/api/group';
import { UNREAD_BADGE_COUNT_CAP } from '@/utils/unreadBadge';
import { compareMessageOrder, isSameMessage } from './messageProjection';

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

export interface ChatsState {
  byId: Record<string, ChatStateEntry>;
}

const initialState: ChatsState = {
  byId: {},
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
    lastReadMessageId: live?.lastReadMessageId ?? snapshot?.lastReadMessageId ?? null,
    lastMessage: latest,
    lastMessageAt: latest?.createdAt ?? snapshot?.lastMessageAt ?? null,
    archived: live?.archived ?? snapshot?.archived ?? false,
  };
}

function reconcileAuthoritativeListFields(entry: ChatStateEntry, snapshotUnreadCount: number): void {
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
    setChatsList(state, action: PayloadAction<{ chats: ChatListEntry[]; archived?: boolean }>) {
      const archived = action.payload.archived ?? false;
      const nextIds = new Set(action.payload.chats.map((chat) => chat.id));

      for (const [chatId, entry] of Object.entries(state.byId)) {
        const snapshotArchived = entry.listSnapshot?.archived ?? false;
        if (snapshotArchived !== archived) continue;
        if (nextIds.has(chatId)) continue;

        entry.listSnapshot = {
          ...entry.listSnapshot,
          inList: false,
          archived,
        };
      }

      for (const chat of action.payload.chats) {
        const entry = getChatEntry(state, chat.id);
        entry.details = {
          ...entry.details,
          name: chat.name ?? entry.details.name,
          avatar: chat.avatar ?? entry.details.avatar ?? null,
        };
        entry.listSnapshot = {
          lastMessage: chat.lastMessage,
          lastMessageAt: chat.lastMessageAt,
          unreadCount: chat.unreadCount,
          lastReadMessageId: chat.lastReadMessageId,
          inList: true,
          mutedUntil: chat.mutedUntil,
          archived: chat.archived ?? archived,
        };
        reconcileAuthoritativeListFields(entry, chat.unreadCount);
      }
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
  setChatMutedUntil,
  setChatInList,
  setChatArchived,
  projectChatMessageAdded,
  projectChatMessageConfirmed,
  setChatUnreadCount,
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

export function selectChatLastReadMessageId(state: RootState, chatId: string): string | null {
  const entry = state.chats.byId[chatId];
  return getEffectiveListMeta(entry).lastReadMessageId ?? null;
}

export function selectChatUnreadCount(state: RootState, chatId: string): number {
  const entry = state.chats.byId[chatId];
  return getEffectiveListMeta(entry).unreadCount ?? 0;
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
    lastReadMessageId: listMeta.lastReadMessageId ?? null,
    lastMessage: listMeta.lastMessage ?? null,
    mutedUntil: resolveMutedUntil(entry?.listSnapshot, entry?.liveProjection),
    archived: listMeta.archived ?? false,
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
