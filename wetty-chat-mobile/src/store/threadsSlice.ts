import type { PayloadAction } from '@reduxjs/toolkit';
import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { RootState } from './index';
import type { MessagePreview } from '@/api/messages';
import type { StoredThreadListItem, ThreadListItem } from '@/api/threads';
import { applyIncomingId, type MentionIdCacheStatus } from './mentionIdCache';

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
  isLoading: boolean;
  pageDepth: number;
}

interface ThreadsState {
  items: StoredThreadListItem[];
  buckets: Record<'active' | 'archived', ThreadListBucketState>;
  subscriptionByThreadId: Record<string, boolean>;
  archivedByThreadId: Record<string, boolean>;
  unreadMentionIdsByThread: Record<string, string[]>;
  unreadMentionIdsStatusByThread: Record<string, MentionIdCacheStatus>;
  unreadReactionIdsByThread: Record<string, string[]>;
  unreadReactionIdsStatusByThread: Record<string, MentionIdCacheStatus>;
}

const initialState: ThreadsState = {
  items: [],
  buckets: {
    active: { nextCursor: null, isLoaded: false, isLoading: false, pageDepth: 0 },
    archived: { nextCursor: null, isLoaded: false, isLoading: false, pageDepth: 0 },
  },
  subscriptionByThreadId: {},
  archivedByThreadId: {},
  unreadMentionIdsByThread: {},
  unreadMentionIdsStatusByThread: {},
  unreadReactionIdsByThread: {},
  unreadReactionIdsStatusByThread: {},
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
      action: PayloadAction<{
        threads: ThreadListItem[];
        nextCursor: string | null;
        archived?: boolean;
        pageDepth?: number;
      }>,
    ) {
      const archived = action.payload.archived ?? false;
      const key = bucketKey(archived);
      const seenIds = new Set<string>();
      const nextItems: StoredThreadListItem[] = [];
      for (const thread of action.payload.threads) {
        const threadRootId = thread.threadRootMessage.id;
        if (seenIds.has(threadRootId)) continue;
        seenIds.add(threadRootId);
        nextItems.push(toStoredThread(thread));
      }

      // Full snapshot refresh: server mention counts are authoritative, so drop cached id lists.
      state.unreadMentionIdsByThread = {};
      state.unreadMentionIdsStatusByThread = {};
      state.unreadReactionIdsByThread = {};
      state.unreadReactionIdsStatusByThread = {};

      // Full refreshes replace the target bucket so memberships that moved or disappeared
      // while realtime updates were unavailable do not survive the authoritative snapshot.
      state.items = state.items.filter((thread) => thread.archived !== archived);
      state.items.push(...nextItems);
      state.buckets[key] = {
        nextCursor: action.payload.nextCursor,
        isLoaded: true,
        isLoading: state.buckets[key].isLoading,
        pageDepth: action.payload.pageDepth ?? 1,
      };
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
      const existingIds = new Set(state.items.map((thread) => thread.threadRootMessage.id));
      const newThreads: StoredThreadListItem[] = [];
      for (const thread of action.payload.threads) {
        const threadRootId = thread.threadRootMessage.id;
        if (existingIds.has(threadRootId)) continue;
        existingIds.add(threadRootId);
        newThreads.push(toStoredThread(thread));
      }
      state.items.push(...newThreads);
      state.buckets[key].nextCursor = action.payload.nextCursor;
      state.buckets[key].isLoaded = true;
      state.buckets[key].pageDepth += 1;
      for (const thread of action.payload.threads) {
        state.subscriptionByThreadId[thread.threadRootMessage.id] = true;
        state.archivedByThreadId[thread.threadRootMessage.id] = thread.archived;
      }
    },
    setThreadsListLoading(state, action: PayloadAction<{ archived?: boolean; isLoading: boolean }>) {
      state.buckets[bucketKey(action.payload.archived ?? false)].isLoading = action.payload.isLoading;
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
    incrementThreadUnreadMentions(state, action: PayloadAction<{ threadRootId: string; messageId?: string }>) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread) {
        thread.unreadMentions = (thread.unreadMentions ?? 0) + 1;
      }
      const tid = action.payload.threadRootId;
      const next = applyIncomingId(
        { ids: state.unreadMentionIdsByThread[tid], status: state.unreadMentionIdsStatusByThread[tid] },
        action.payload.messageId,
      );
      state.unreadMentionIdsByThread[tid] = next.ids;
      if (next.status !== undefined) {
        state.unreadMentionIdsStatusByThread[tid] = next.status;
      }
    },
    incrementThreadUnreadReactions(state, action: PayloadAction<{ threadRootId: string; messageId?: string }>) {
      const tid = action.payload.threadRootId;
      const next = applyIncomingId(
        { ids: state.unreadReactionIdsByThread[tid], status: state.unreadReactionIdsStatusByThread[tid] },
        action.payload.messageId,
      );
      // One message counts as one unread unit however many reactions it gains
      // (server counts DISTINCT messages); setThreadReadState reconciles when the cache isn't ready.
      if (next.alreadyPresent) {
        return;
      }
      const thread = state.items.find((t) => t.threadRootMessage.id === tid);
      if (thread) {
        thread.unreadReactions = (thread.unreadReactions ?? 0) + 1;
      }
      state.unreadReactionIdsByThread[tid] = next.ids;
      if (next.status !== undefined) {
        state.unreadReactionIdsStatusByThread[tid] = next.status;
      }
    },
    /**
     * Apply an authoritative thread read-state response (or an optimistic
     * reset): counts come from the payload (defaulting to 0), and the cached
     * id lists are invalidated since they were computed against the
     * superseded state.
     */
    setThreadReadState(
      state,
      action: PayloadAction<{
        threadRootId: string;
        lastReadMessageId?: string | null;
        unreadCount?: number;
        unreadMentions?: number;
        unreadReactions?: number;
      }>,
    ) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread) {
        thread.lastReadMessageId = action.payload.lastReadMessageId ?? thread.lastReadMessageId;
        thread.unreadCount = action.payload.unreadCount ?? 0;
        thread.unreadMentions = action.payload.unreadMentions ?? 0;
        thread.unreadReactions = action.payload.unreadReactions ?? 0;
      }
      const tid = action.payload.threadRootId;
      delete state.unreadMentionIdsByThread[tid];
      delete state.unreadMentionIdsStatusByThread[tid];
      delete state.unreadReactionIdsByThread[tid];
      delete state.unreadReactionIdsStatusByThread[tid];
    },
    /**
     * Record just the read position (lastReadMessageId) without touching the
     * unread counts — used when the read state is fetched for display purposes
     * (opening a thread) and the counts in the payload are absent, unlike
     * `setThreadReadState` where counts are authoritative.
     */
    setThreadLastReadMessageId(
      state,
      action: PayloadAction<{ threadRootId: string; lastReadMessageId: string | null }>,
    ) {
      const thread = state.items.find((t) => t.threadRootMessage.id === action.payload.threadRootId);
      if (thread) {
        thread.lastReadMessageId = action.payload.lastReadMessageId;
      }
    },
    setThreadUnreadReactionIds(state, action: PayloadAction<{ threadRootId: string; ids: string[] }>) {
      const tid = action.payload.threadRootId;
      // Same mid-flight guard as mentions.
      if (state.unreadReactionIdsStatusByThread[tid] !== 'loading') {
        state.unreadReactionIdsStatusByThread[tid] = 'idle';
        return;
      }
      state.unreadReactionIdsByThread[tid] = action.payload.ids;
      state.unreadReactionIdsStatusByThread[tid] = 'ready';
    },
    setThreadUnreadReactionIdsStatus(
      state,
      action: PayloadAction<{ threadRootId: string; status: MentionIdCacheStatus }>,
    ) {
      state.unreadReactionIdsStatusByThread[action.payload.threadRootId] = action.payload.status;
    },
    setThreadUnreadMentionIds(state, action: PayloadAction<{ threadRootId: string; ids: string[] }>) {
      const tid = action.payload.threadRootId;
      // Only claim the cache is fresh if this response is still the acknowledged fetch: a
      // mention that arrived mid-flight resets the status to 'idle', and caching the
      // pre-mention list as 'ready' would strand that mention until the next invalidation.
      if (state.unreadMentionIdsStatusByThread[tid] !== 'loading') {
        state.unreadMentionIdsStatusByThread[tid] = 'idle';
        return;
      }
      state.unreadMentionIdsByThread[tid] = action.payload.ids;
      state.unreadMentionIdsStatusByThread[tid] = 'ready';
    },
    setThreadUnreadMentionIdsStatus(
      state,
      action: PayloadAction<{ threadRootId: string; status: MentionIdCacheStatus }>,
    ) {
      state.unreadMentionIdsStatusByThread[action.payload.threadRootId] = action.payload.status;
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
      state.buckets.active = { nextCursor: null, isLoaded: false, isLoading: false, pageDepth: 0 };
      state.buckets.archived = { nextCursor: null, isLoaded: false, isLoading: false, pageDepth: 0 };
      state.subscriptionByThreadId = {};
      state.archivedByThreadId = {};
      state.unreadMentionIdsByThread = {};
      state.unreadMentionIdsStatusByThread = {};
      state.unreadReactionIdsByThread = {};
      state.unreadReactionIdsStatusByThread = {};
    },
  },
});

export const {
  setThreadsList,
  appendThreads,
  setThreadsListLoading,
  updateThreadFromWs,
  updateThreadCachedLastReply,
  patchThreadCachedLastReply,
  incrementThreadUnread,
  incrementThreadUnreadMentions,
  incrementThreadUnreadReactions,
  setThreadReadState,
  setThreadLastReadMessageId,
  setThreadUnreadMentionIds,
  setThreadUnreadMentionIdsStatus,
  setThreadUnreadReactionIds,
  setThreadUnreadReactionIdsStatus,
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
export const selectThreadsLoading = (state: RootState, archived = false) =>
  state.threads.buckets[bucketKey(archived)].isLoading;
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
export const selectThreadUnreadMentions = (state: RootState, threadRootId: string): number => {
  return selectThreadByRootId(state, threadRootId)?.unreadMentions ?? 0;
};

export const selectThreadUnreadReactions = (state: RootState, threadRootId: string): number => {
  return selectThreadByRootId(state, threadRootId)?.unreadReactions ?? 0;
};

export const selectThreadUnreadMentionIds = (state: RootState, threadRootId: string): string[] =>
  state.threads.unreadMentionIdsByThread[threadRootId] ?? [];

export const selectThreadUnreadMentionIdsStatus = (state: RootState, threadRootId: string): MentionIdCacheStatus =>
  state.threads.unreadMentionIdsStatusByThread[threadRootId] ?? 'idle';

export const selectThreadUnreadReactionIds = (state: RootState, threadRootId: string): string[] =>
  state.threads.unreadReactionIdsByThread[threadRootId] ?? [];

export const selectThreadUnreadReactionIdsStatus = (state: RootState, threadRootId: string): MentionIdCacheStatus =>
  state.threads.unreadReactionIdsStatusByThread[threadRootId] ?? 'idle';
export const selectThreadLastReadMessageId = (state: RootState, threadId: string | undefined): string | null => {
  return selectThreadByRootId(state, threadId)?.lastReadMessageId ?? null;
};
export const selectShouldShowThreadsRow = (state: RootState) =>
  selectTotalUnreadThreadCount(state) > 0 ||
  (selectThreadsLoaded(state, false) && selectActiveThreads(state).length > 0);

export default threadsSlice.reducer;
