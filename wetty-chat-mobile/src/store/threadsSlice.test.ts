import { describe, expect, it } from 'vitest';
import type { ThreadListItem } from '@/api/threads';
import reducer, {
  appendThreads,
  clearThreads,
  incrementThreadUnread,
  markThreadRead,
  patchThreadCachedLastReply,
  patchThreadRootMessage,
  removeThread,
  selectActiveThreads,
  selectArchivedThreads,
  selectShouldShowThreadsRow,
  selectThreadArchivedStatus,
  selectThreadSubscriptionStatus,
  selectThreadUnreadCount,
  selectThreads,
  selectTotalArchivedUnreadThreadCount,
  selectTotalUnreadThreadCount,
  selectThreadsWithUnreadCount,
  selectArchivedThreadsWithUnreadCount,
  setThreadReadState,
  setThreadSubscriptionStatus,
  setThreadsList,
  updateThreadCachedLastReply,
  updateThreadFromWs,
} from './threadsSlice';
import type { RootState } from './index';

function makeThread(id: string, overrides: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    chatId: '1',
    chatName: 'Chat',
    chatAvatar: null,
    threadRootMessage: {
      id,
      clientGeneratedId: `client-${id}`,
      createdAt: new Date(Number(id)).toISOString(),
      message: `root ${id}`,
      messageType: 'text',
      sender: { uid: 2, name: 'User', gender: 0 },
      isDeleted: false,
    },
    participants: [{ uid: 2, name: 'User', gender: 0 }],
    lastReply: null,
    replyCount: 1,
    lastReplyAt: new Date(Number(id)).toISOString(),
    unreadCount: 0,
    lastReadMessageId: null,
    subscribedAt: new Date(Number(id)).toISOString(),
    archived: false,
    ...overrides,
  };
}

function rootState(state: ReturnType<typeof reducer>): RootState {
  return { threads: state } as unknown as RootState;
}

describe('threadsSlice reducers', () => {
  it('setThreadsList replaces the target bucket and updates subscription map', () => {
    const state = reducer(
      undefined,
      setThreadsList({ threads: [makeThread('10'), makeThread('11')], nextCursor: null }),
    );

    expect(selectThreads(rootState(state))).toHaveLength(2);
    expect(state.buckets.active.isLoaded).toBe(true);
    expect(state.subscriptionByThreadId['10']).toBe(true);
    expect(state.subscriptionByThreadId['11']).toBe(true);
    expect(state.archivedByThreadId['10']).toBe(false);
  });

  it('setThreadsList with archived=true replaces archived bucket while preserving active', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    state = reducer(
      state,
      setThreadsList({ threads: [makeThread('20', { archived: true })], nextCursor: null, archived: true }),
    );

    expect(selectActiveThreads(rootState(state))).toHaveLength(1);
    expect(selectArchivedThreads(rootState(state))).toHaveLength(1);
    expect(state.buckets.archived.isLoaded).toBe(true);
  });

  it('setThreadsList with archived=true removes stale archived entries', () => {
    let state = reducer(
      undefined,
      setThreadsList({ threads: [makeThread('10', { archived: true })], nextCursor: null, archived: true }),
    );
    state = reducer(
      state,
      setThreadsList({ threads: [makeThread('20', { archived: true })], nextCursor: null, archived: true }),
    );

    const archived = selectArchivedThreads(rootState(state));
    expect(archived).toHaveLength(1);
    expect(archived[0].threadRootMessage.id).toBe('20');
  });

  it('appendThreads deduplicates by thread root id', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    state = reducer(state, appendThreads({ threads: [makeThread('10'), makeThread('11')], nextCursor: null }));

    expect(selectThreads(rootState(state))).toHaveLength(2);
  });

  it('appendThreads updates cursor and subscription map', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    state = reducer(state, appendThreads({ threads: [makeThread('11')], nextCursor: 'cursor-11' }));

    expect(state.buckets.active.nextCursor).toBe('cursor-11');
    expect(state.subscriptionByThreadId['11']).toBe(true);
  });

  it('updateThreadFromWs moves thread to top and updates replyCount', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10'), makeThread('11')], nextCursor: null }));
    state = reducer(
      state,
      updateThreadFromWs({ threadRootId: '10', chatId: '1', lastReplyAt: '2025-01-01', replyCount: 5 }),
    );

    expect(selectThreads(rootState(state))[0].threadRootMessage.id).toBe('10');
    expect(selectThreads(rootState(state))[0].replyCount).toBe(5);
  });

  it('updateThreadFromWs removes thread when replyCount is 0', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10'), makeThread('11')], nextCursor: null }));
    state = reducer(
      state,
      updateThreadFromWs({ threadRootId: '10', chatId: '1', lastReplyAt: '2025-01-01', replyCount: 0 }),
    );

    expect(selectThreads(rootState(state))).toHaveLength(1);
    expect(selectThreads(rootState(state))[0].threadRootMessage.id).toBe('11');
    expect(state.subscriptionByThreadId['10']).toBe(false);
    expect(state.archivedByThreadId['10']).toBeUndefined();
  });

  it('updateThreadFromWs does nothing for unknown thread', () => {
    const state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    const next = reducer(
      state,
      updateThreadFromWs({ threadRootId: '999', chatId: '1', lastReplyAt: '2025-01-01', replyCount: 5 }),
    );

    expect(selectThreads(rootState(next))).toHaveLength(1);
  });

  it('updateThreadCachedLastReply updates the cached preview', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    const preview = { ...makeThread('10').threadRootMessage, id: 'reply-1', message: 'last reply' };
    state = reducer(state, updateThreadCachedLastReply({ threadRootId: '10', cachedLastReply: preview }));

    expect(state.items[0].cachedLastReply?.message).toBe('last reply');
  });

  it('patchThreadCachedLastReply partially updates the cached preview', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    const preview = { ...makeThread('10').threadRootMessage, id: 'reply-1', message: 'last reply' };
    state = reducer(state, updateThreadCachedLastReply({ threadRootId: '10', cachedLastReply: preview }));
    state = reducer(
      state,
      patchThreadCachedLastReply({ threadRootId: '10', patch: { isDeleted: true, message: null } }),
    );

    expect(state.items[0].cachedLastReply?.isDeleted).toBe(true);
    expect(state.items[0].cachedLastReply?.message).toBeNull();
  });

  it('patchThreadCachedLastReply does nothing for unknown thread', () => {
    const state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    const next = reducer(state, patchThreadCachedLastReply({ threadRootId: '999', patch: { isDeleted: true } }));

    expect(next).toBe(state);
  });

  it('incrementThreadUnread increments unreadCount', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    state = reducer(state, incrementThreadUnread({ threadRootId: '10' }));
    state = reducer(state, incrementThreadUnread({ threadRootId: '10' }));

    expect(selectThreadUnreadCount(rootState(state), '10')).toBe(2);
  });

  it('markThreadRead resets unreadCount to 0', () => {
    let state = reducer(
      undefined,
      setThreadsList({ threads: [makeThread('10', { unreadCount: 5 })], nextCursor: null }),
    );
    state = reducer(state, markThreadRead({ threadRootId: '10' }));

    expect(selectThreadUnreadCount(rootState(state), '10')).toBe(0);
  });

  it('setThreadReadState updates lastReadMessageId and unreadCount', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    state = reducer(state, setThreadReadState({ threadRootId: '10', lastReadMessageId: 'msg-5', unreadCount: 3 }));

    expect(state.items[0].lastReadMessageId).toBe('msg-5');
    expect(state.items[0].unreadCount).toBe(3);
  });

  it('setThreadSubscriptionStatus updates subscription and archived maps', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    state = reducer(state, setThreadSubscriptionStatus({ threadRootId: '10', subscribed: true, archived: true }));

    expect(selectThreadSubscriptionStatus(rootState(state), '10')).toBe(true);
    expect(selectThreadArchivedStatus(rootState(state), '10')).toBe(true);
    expect(state.items[0].archived).toBe(true);
  });

  it('setThreadSubscriptionStatus without archived only updates subscription', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    state = reducer(state, setThreadSubscriptionStatus({ threadRootId: '10', subscribed: false }));

    expect(selectThreadSubscriptionStatus(rootState(state), '10')).toBe(false);
  });

  it('removeThread removes thread from items and resets maps', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10'), makeThread('11')], nextCursor: null }));
    state = reducer(state, removeThread({ threadRootId: '10' }));

    expect(selectThreads(rootState(state))).toHaveLength(1);
    expect(selectThreads(rootState(state))[0].threadRootMessage.id).toBe('11');
    expect(state.subscriptionByThreadId['10']).toBe(false);
    expect(state.archivedByThreadId['10']).toBeUndefined();
  });

  it('patchThreadRootMessage partially updates threadRootMessage', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null }));
    state = reducer(state, patchThreadRootMessage({ threadRootId: '10', message: { isDeleted: true, message: null } }));

    expect(state.items[0].threadRootMessage.isDeleted).toBe(true);
    expect(state.items[0].threadRootMessage.message).toBeNull();
  });

  it('clearThreads resets all state to initial', () => {
    let state = reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: 'cursor' }));
    state = reducer(state, clearThreads());

    expect(state.items).toEqual([]);
    expect(state.buckets.active).toEqual({ nextCursor: null, isLoaded: false });
    expect(state.buckets.archived).toEqual({ nextCursor: null, isLoaded: false });
    expect(state.subscriptionByThreadId).toEqual({});
    expect(state.archivedByThreadId).toEqual({});
  });
});

describe('threadsSlice selectors', () => {
  it('selectActiveThreads filters out archived threads', () => {
    const state = rootState(
      reducer(
        undefined,
        setThreadsList({
          threads: [makeThread('10'), makeThread('11', { archived: true })],
          nextCursor: null,
          archived: true,
        }),
      ),
    );
    // Need to add active threads too
    const fullState = rootState(
      reducer(
        (state as unknown as RootState).threads,
        setThreadsList({ threads: [makeThread('10')], nextCursor: null }),
      ),
    );

    expect(selectActiveThreads(fullState)).toHaveLength(1);
    expect(selectActiveThreads(fullState)[0].threadRootMessage.id).toBe('10');
  });

  it('selectArchivedThreads filters to only archived threads', () => {
    const state = rootState(
      reducer(
        reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null })),
        setThreadsList({ threads: [makeThread('20', { archived: true })], nextCursor: null, archived: true }),
      ),
    );

    expect(selectArchivedThreads(state)).toHaveLength(1);
    expect(selectArchivedThreads(state)[0].threadRootMessage.id).toBe('20');
  });

  it('selectTotalUnreadThreadCount sums active thread unread counts', () => {
    const state = rootState(
      reducer(
        undefined,
        setThreadsList({
          threads: [
            makeThread('10', { unreadCount: 3 }),
            makeThread('11', { unreadCount: 2 }),
            makeThread('12', { unreadCount: 5, archived: true }),
          ],
          nextCursor: null,
        }),
      ),
    );

    expect(selectTotalUnreadThreadCount(state)).toBe(5);
  });

  it('selectTotalArchivedUnreadThreadCount sums archived thread unread counts', () => {
    const state = rootState(
      reducer(
        reducer(undefined, setThreadsList({ threads: [makeThread('10', { unreadCount: 3 })], nextCursor: null })),
        setThreadsList({
          threads: [makeThread('20', { unreadCount: 7, archived: true })],
          nextCursor: null,
          archived: true,
        }),
      ),
    );

    expect(selectTotalArchivedUnreadThreadCount(state)).toBe(7);
  });

  it('selectThreadsWithUnreadCount counts active threads with unread > 0', () => {
    const state = rootState(
      reducer(
        undefined,
        setThreadsList({
          threads: [
            makeThread('10', { unreadCount: 3 }),
            makeThread('11', { unreadCount: 0 }),
            makeThread('12', { unreadCount: 1 }),
          ],
          nextCursor: null,
        }),
      ),
    );

    expect(selectThreadsWithUnreadCount(state)).toBe(2);
  });

  it('selectArchivedThreadsWithUnreadCount counts archived threads with unread > 0', () => {
    const state = rootState(
      reducer(
        reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null })),
        setThreadsList({
          threads: [
            makeThread('20', { unreadCount: 2, archived: true }),
            makeThread('21', { unreadCount: 0, archived: true }),
          ],
          nextCursor: null,
          archived: true,
        }),
      ),
    );

    expect(selectArchivedThreadsWithUnreadCount(state)).toBe(1);
  });

  it('selectThreadSubscriptionStatus returns boolean for known thread, null for unknown', () => {
    let state = rootState(reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null })));
    state = rootState(reducer(state.threads, setThreadSubscriptionStatus({ threadRootId: '10', subscribed: true })));

    expect(selectThreadSubscriptionStatus(state, '10')).toBe(true);
    expect(selectThreadSubscriptionStatus(state, '999')).toBeNull();
  });

  it('selectThreadUnreadCount returns count for known thread, 0 for unknown', () => {
    const state = rootState(
      reducer(undefined, setThreadsList({ threads: [makeThread('10', { unreadCount: 5 })], nextCursor: null })),
    );

    expect(selectThreadUnreadCount(state, '10')).toBe(5);
    expect(selectThreadUnreadCount(state, '999')).toBe(0);
  });

  it('selectThreadArchivedStatus returns boolean for known thread, null for unknown', () => {
    const state = rootState(
      reducer(
        reducer(undefined, setThreadsList({ threads: [makeThread('10')], nextCursor: null })),
        setThreadsList({ threads: [makeThread('20', { archived: true })], nextCursor: null, archived: true }),
      ),
    );

    expect(selectThreadArchivedStatus(state, '20')).toBe(true);
    expect(selectThreadArchivedStatus(state, '10')).toBe(false);
    expect(selectThreadArchivedStatus(state, '999')).toBeNull();
  });

  it('selectShouldShowThreadsRow returns true when there are unread threads', () => {
    const state = rootState(
      reducer(undefined, setThreadsList({ threads: [makeThread('10', { unreadCount: 1 })], nextCursor: null })),
    );

    expect(selectShouldShowThreadsRow(state)).toBe(true);
  });

  it('selectShouldShowThreadsRow returns true when threads are loaded and active threads exist', () => {
    const state = rootState(
      reducer(undefined, setThreadsList({ threads: [makeThread('10', { unreadCount: 0 })], nextCursor: null })),
    );

    expect(selectShouldShowThreadsRow(state)).toBe(true);
  });

  it('selectShouldShowThreadsRow returns false when no unread and no loaded threads', () => {
    const state = rootState(reducer(undefined, { type: 'init' } as any));

    expect(selectShouldShowThreadsRow(state)).toBe(false);
  });
});
