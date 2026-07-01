import type { PayloadAction } from '@reduxjs/toolkit';
import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { RootState } from './index';
import type { MessagePreview } from '@/api/messages';
import type { StoredThreadListItem, ThreadListItem } from '@/api/threads';

export interface ThreadUpdatePayload {
  threadRootId: string;
  chatId: string;
  lastReplyAt: string;
  replyCount: number;
}

function toStoredThread(item: ThreadListItem): StoredThreadListItem {
  const { lastReply, ...rest } = item;
  return { ...rest, cachedLastReply: lastReply };
}

interface ThreadListBucketState {
  nextCursor: string | null;
  isLoaded: boolean;
}

interface ThreadsState {
  items: StoredThreadListItem[];
  buckets: Record<'active' | 'archived', ThreadListBucketState>;
  subscriptionByThreadId: Record<string, boolean>;
  archivedByThreadId: Record<string, boolean>;
}

const initialState: ThreadsState = {
  items: [],
  buckets: {
    active: { nextCursor: null, isLoaded: false },
    archived: { nextCursor: null, isLoaded: false },
  },
  subscriptionByThreadId: {},
  archivedByThreadId: {},
};

function bucketKey(archived: boolean): 'active' | 'archived' {
  return archived ? 'archived' : 'active';
}

const threadsSlice = createSlice({
  name: 'threads',
  initialState,
  reducers: {
    setThreadsList(
      state,
      action: PayloadAction<{ threads: ThreadListItem[]; nextCursor: string | null; archived?: boolean }>,
    ) {
      const archived = action.payload.archived ?? false;
      const key = bucketKey(archived);
      const nextItems = action.payload.threads.map(toStoredThread);

      // `setThreadsList` is used for full snapshot refreshes, so the target bucket
      // must be replaced wholesale to avoid keeping stale entries that moved buckets
      // or disappeared while this client missed realtime updates.
      state.items = state.items.filter((thread) => thread.archived !== archived);
      state.items.push(...nextItems);
      state.buckets[key] = { nextCursor: action.payload.nextCursor, isLoaded: true };
      for (const thread of action.payload.threads) {
        state.subscriptionByThreadId[thread.threadRootMessage.id] = true;
        state.archivedByThreadId[thread.threadRootMessage.id] = thread.archived;
      }
    },
    appendThreads(
      state,
      action: PayloadAction<{ threads: ThreadListItem[]; nextCursor: string | null; archived?: boolean }>,
    ) {
      const archived = action.payload.archived ?? false;
      const key = bucketKey(archived);
      const existingIds = new Set(state.items.map((t) => t.threadRootMessage.id));
      const newThreads = action.payload.threads
        .filter((t) => !existingIds.has(t.threadRootMessage.id))
        .map(toStoredThread);
      state.items.push(...newThreads);
      state.buckets[key].nextCursor = action.payload.nextCursor;
      state.buckets[key].isLoaded = true;
      for (const thread of action.payload.threads) {
        state.subscriptionByThreadId[thread.threadRootMessage.id] = true;
        state.archivedByThreadId[thread.threadRootMessage.id] = thread.archived;
      }
    },
    updateThreadFromWs(state, action: PayloadAction<ThreadUpdatePayload>) {
      const { threadRootId, lastReplyAt, replyCount } = action.payload;
      const idx = state.items.findIndex((t) => t.threadRootMessage.id === threadRootId);
      if (idx >= 0) {
        // When all replies are deleted, remove the thread from the list entirely
        if (replyCount === 0) {
          state.items.splice(idx, 1);
          state.subscriptionByThreadId[threadRootId] = false;
          delete state.archivedByThreadId[threadRootId];
          return;
        }
        const thread = state.items[idx];
        thread.replyCount = replyCount;
        thread.lastReplyAt = lastReplyAt;
        // Move to top of list
        state.items.splice(idx, 1);
        state.items.unshift(thread);
      }
    },
    /** Update the cached preview for threads whose messages aren't loaded in the message timeline store. */
    updateThreadCachedLastReply(
      state,
      action: PayloadAction<{ threadRootId: string; cachedLastReply: MessagePreview }>,
    ) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread) {
        thread.cachedLastReply = action.payload.cachedLastReply;
      }
    },
    /** Partially patch the cached preview (e.g. mark as deleted when the thread window isn't loaded). */
    patchThreadCachedLastReply(state, action: PayloadAction<{ threadRootId: string; patch: Partial<MessagePreview> }>) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread && thread.cachedLastReply) {
        Object.assign(thread.cachedLastReply, action.payload.patch);
      }
    },
    incrementThreadUnread(state, action: PayloadAction<{ threadRootId: string }>) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread) {
        thread.unreadCount = (thread.unreadCount ?? 0) + 1;
      }
    },
    markThreadRead(state, action: PayloadAction<{ threadRootId: string }>) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread) {
        thread.unreadCount = 0;
      }
    },
    setThreadReadState(
      state,
      action: PayloadAction<{ threadRootId: string; lastReadMessageId: string | null; unreadCount: number }>,
    ) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread) {
        thread.lastReadMessageId = action.payload.lastReadMessageId;
        thread.unreadCount = action.payload.unreadCount;
      }
    },
    setThreadSubscriptionStatus(
      state,
      action: PayloadAction<{ threadRootId: string; subscribed: boolean; archived?: boolean }>,
    ) {
      state.subscriptionByThreadId[action.payload.threadRootId] = action.payload.subscribed;
      if (action.payload.archived !== undefined) {
        state.archivedByThreadId[action.payload.threadRootId] = action.payload.archived;
        const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
        if (thread) {
          thread.archived = action.payload.archived;
        }
      }
    },
    removeThread(state, action: PayloadAction<{ threadRootId: string }>) {
      state.items = state.items.filter((t) => t.threadRootMessage.id !== action.payload.threadRootId);
      state.subscriptionByThreadId[action.payload.threadRootId] = false;
      delete state.archivedByThreadId[action.payload.threadRootId];
    },
    patchThreadRootMessage(state, action: PayloadAction<{ threadRootId: string; message: Partial<MessagePreview> }>) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread) {
        Object.assign(thread.threadRootMessage, action.payload.message);
      }
    },
    clearThreads(state) {
      state.items = [];
      state.buckets.active = { nextCursor: null, isLoaded: false };
      state.buckets.archived = { nextCursor: null, isLoaded: false };
      state.subscriptionByThreadId = {};
      state.archivedByThreadId = {};
    },
  },
});

export const {
  setThreadsList,
  appendThreads,
  updateThreadFromWs,
  updateThreadCachedLastReply,
  patchThreadCachedLastReply,
  incrementThreadUnread,
  markThreadRead,
  setThreadReadState,
  setThreadSubscriptionStatus,
  removeThread,
  patchThreadRootMessage,
  clearThreads,
} = threadsSlice.actions;

export const selectThreads = (state: RootState) => state.threads.items;
export const selectActiveThreads = createSelector([selectThreads], (threads) => threads.filter((t) => !t.archived));
export const selectArchivedThreads = createSelector([selectThreads], (threads) => threads.filter((t) => t.archived));
export const selectThreadsLoaded = (state: RootState, archived = false) =>
  state.threads.buckets[bucketKey(archived)].isLoaded;
export const selectThreadsNextCursor = (state: RootState, archived = false) =>
  state.threads.buckets[bucketKey(archived)].nextCursor;
export const selectTotalUnreadThreadCount = createSelector([selectThreads], (threads) =>
  threads.filter((t) => !t.archived).reduce((sum, t) => sum + (t.unreadCount ?? 0), 0),
);
export const selectTotalArchivedUnreadThreadCount = createSelector([selectThreads], (threads) =>
  threads.filter((t) => t.archived).reduce((sum, t) => sum + (t.unreadCount ?? 0), 0),
);
export const selectThreadsWithUnreadCount = createSelector(
  [selectThreads],
  (threads) => threads.filter((t) => !t.archived && (t.unreadCount ?? 0) > 0).length,
);
export const selectArchivedThreadsWithUnreadCount = createSelector(
  [selectThreads],
  (threads) => threads.filter((t) => t.archived && (t.unreadCount ?? 0) > 0).length,
);
export const selectThreadSubscriptionStatus = (state: RootState, threadRootId: string) =>
  state.threads.subscriptionByThreadId[threadRootId] ?? null;
export const selectThreadArchivedStatus = (state: RootState, threadRootId: string) =>
  state.threads.archivedByThreadId[threadRootId] ?? null;
const selectThreadByRootId = (state: RootState, threadId: string | undefined): StoredThreadListItem | undefined => {
  if (!threadId) return undefined;
  return state.threads.items.find((t) => t.threadRootMessage.id === threadId);
};
export const selectThreadUnreadCount = (state: RootState, threadRootId: string): number => {
  return selectThreadByRootId(state, threadRootId)?.unreadCount ?? 0;
};
// Currently unused — kept for future thread detail UI that may need store-side read position.
export const selectThreadLastReadMessageId = (state: RootState, threadId: string | undefined): string | null => {
  return selectThreadByRootId(state, threadId)?.lastReadMessageId ?? null;
};
export const selectShouldShowThreadsRow = (state: RootState) =>
  selectTotalUnreadThreadCount(state) > 0 ||
  (selectThreadsLoaded(state, false) && selectActiveThreads(state).length > 0);

export default threadsSlice.reducer;
