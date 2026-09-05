import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListEntry, ListChatsResponse } from '@/api/chats';
import { getChats } from '@/api/chats';
import type { ThreadListItem } from '@/api/threads';
import { getThreads } from '@/api/threads';
import { createStore } from './index';
import {
  selectAllChats,
  selectArchivedChats,
  selectChatsLoading,
  selectChatsNextCursor,
  setChatsList,
} from './chatsSlice';
import { loadMoreChatList, loadMoreThreadList, refreshChatList, refreshThreadList } from './listPagination';
import { appendThreads, selectActiveThreads, selectArchivedThreads, setThreadsList } from './threadsSlice';

vi.mock('@/api/chats', () => ({
  getChats: vi.fn(),
}));

vi.mock('@/api/threads', () => ({
  getThreads: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

function chat(id: string, archived = false): ChatListEntry {
  return {
    id,
    name: id,
    avatar: null,
    lastMessageAt: null,
    unreadCount: 0,
    lastMessage: null,
    mutedUntil: null,
    archived,
  };
}

function thread(id: string, archived = false): ThreadListItem {
  return {
    chatId: `chat-${id}`,
    chatName: id,
    chatAvatar: null,
    threadRootMessage: {
      id,
      message: id,
      messageType: 'text',
      sender: { uid: 1, name: 'Sender', gender: 0 },
      isDeleted: false,
    },
    participants: [],
    lastReply: null,
    replyCount: 1,
    lastReplyAt: '2026-09-05T00:00:00Z',
    unreadCount: 0,
    lastReadMessageId: null,
    subscribedAt: '2026-09-05T00:00:00Z',
    archived,
  };
}

describe('list pagination', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('appends a cursor page without disturbing the other archive bucket', async () => {
    const store = createStore();
    store.dispatch(setChatsList({ chats: [chat('active-1')], nextCursor: 'cursor-1', archived: false }));
    store.dispatch(setChatsList({ chats: [chat('archived-1', true)], nextCursor: null, archived: true }));
    vi.mocked(getChats).mockResolvedValue(response({ chats: [chat('active-1'), chat('active-2')], nextCursor: null }));

    await store.dispatch(loadMoreChatList(false));

    expect(selectAllChats(store.getState()).map((entry) => entry.id)).toEqual(['active-1', 'active-2']);
    expect(selectArchivedChats(store.getState()).map((entry) => entry.id)).toEqual(['archived-1']);
    expect(selectChatsNextCursor(store.getState())).toBeNull();
  });

  it('refreshes every loaded page before atomically replacing stale memberships', async () => {
    const store = createStore();
    store.dispatch(
      setChatsList({
        chats: [chat('stale-1'), chat('stale-2')],
        nextCursor: 'old-cursor',
        archived: false,
        pageDepth: 2,
      }),
    );
    vi.mocked(getChats)
      .mockResolvedValueOnce(response({ chats: [chat('fresh-1')], nextCursor: 'fresh-cursor' }))
      .mockResolvedValueOnce(response({ chats: [chat('fresh-2')], nextCursor: null }));

    await store.dispatch(refreshChatList(false));

    expect(selectAllChats(store.getState()).map((entry) => entry.id)).toEqual(['fresh-1', 'fresh-2']);
    expect(selectChatsNextCursor(store.getState())).toBeNull();
  });

  it('preserves rows and cursor while a failed next page clears loading', async () => {
    const store = createStore();
    store.dispatch(setChatsList({ chats: [chat('active-1')], nextCursor: 'cursor-1', archived: false }));
    vi.mocked(getChats).mockRejectedValueOnce(new Error('offline'));

    await expect(store.dispatch(loadMoreChatList(false))).rejects.toThrow('offline');

    expect(selectAllChats(store.getState()).map((entry) => entry.id)).toEqual(['active-1']);
    expect(selectChatsNextCursor(store.getState())).toBe('cursor-1');
    expect(selectChatsLoading(store.getState())).toBe(false);
  });

  it('coalesces duplicate next-page requests and queues refresh at the resulting depth', async () => {
    const store = createStore();
    store.dispatch(setChatsList({ chats: [chat('first')], nextCursor: 'next' }));
    const nextPage = deferred<AxiosResponse<ListChatsResponse>>();
    vi.mocked(getChats)
      .mockReturnValueOnce(nextPage.promise)
      .mockResolvedValueOnce(response({ chats: [chat('refreshed-first')], nextCursor: 'refreshed-next' }))
      .mockResolvedValueOnce(response({ chats: [chat('refreshed-second')], nextCursor: null }));

    const firstLoad = store.dispatch(loadMoreChatList(false));
    const duplicateLoad = store.dispatch(loadMoreChatList(false));
    const refresh = store.dispatch(refreshChatList(false));
    nextPage.resolve(response({ chats: [chat('second')], nextCursor: null }));
    await Promise.all([firstLoad, duplicateLoad, refresh]);

    expect(selectAllChats(store.getState()).map((entry) => entry.id)).toEqual(['refreshed-first', 'refreshed-second']);
    expect(getChats).toHaveBeenCalledTimes(3);
    expect(selectChatsLoading(store.getState())).toBe(false);
  });

  it('does not share in-flight requests between independent stores', async () => {
    const first = createStore();
    const second = createStore();
    vi.mocked(getChats)
      .mockResolvedValueOnce(response({ chats: [chat('first-store')], nextCursor: null }))
      .mockResolvedValueOnce(response({ chats: [chat('second-store')], nextCursor: null }));

    await Promise.all([first.dispatch(refreshChatList(false)), second.dispatch(refreshChatList(false))]);

    expect(selectAllChats(first.getState()).map((entry) => entry.id)).toEqual(['first-store']);
    expect(selectAllChats(second.getState()).map((entry) => entry.id)).toEqual(['second-store']);
  });

  it('keeps the full loaded snapshot when a later refresh page fails', async () => {
    const store = createStore();
    store.dispatch(setChatsList({ chats: [chat('first'), chat('second')], nextCursor: 'old-next', pageDepth: 2 }));
    const firstPage = deferred<AxiosResponse<ListChatsResponse>>();
    vi.mocked(getChats).mockReturnValueOnce(firstPage.promise).mockRejectedValueOnce(new Error('offline'));
    const refresh = store.dispatch(refreshChatList(false));
    expect(selectAllChats(store.getState()).map((entry) => entry.id)).toEqual(['first', 'second']);
    firstPage.resolve(response({ chats: [chat('new-first')], nextCursor: 'new-next' }));

    await expect(refresh).rejects.toThrow('offline');
    expect(selectAllChats(store.getState()).map((entry) => entry.id)).toEqual(['first', 'second']);
    expect(selectChatsNextCursor(store.getState())).toBe('old-next');
    expect(selectChatsLoading(store.getState())).toBe(false);
  });

  it('loads and refreshes archived thread pages without discarding older subscriptions', async () => {
    const store = createStore();
    vi.mocked(getThreads)
      .mockResolvedValueOnce(response({ threads: [thread('first', true)], nextCursor: 'next' }))
      .mockResolvedValueOnce(response({ threads: [thread('second', true)], nextCursor: null }))
      .mockResolvedValueOnce(response({ threads: [thread('first', true)], nextCursor: 'next' }))
      .mockResolvedValueOnce(response({ threads: [thread('second', true)], nextCursor: null }));
    await store.dispatch(refreshThreadList(true));
    await store.dispatch(loadMoreThreadList(true));
    await store.dispatch(refreshThreadList(true));

    expect(selectArchivedThreads(store.getState()).map((entry) => entry.threadRootMessage.id)).toEqual([
      'first',
      'second',
    ]);
    expect(selectActiveThreads(store.getState())).toEqual([]);
  });

  it('deduplicates merged thread pages without mixing archive buckets', () => {
    const store = createStore();
    store.dispatch(
      setThreadsList({
        threads: [thread('active-1'), thread('active-1')],
        nextCursor: 'cursor-1',
        archived: false,
        pageDepth: 2,
      }),
    );
    store.dispatch(setThreadsList({ threads: [thread('archived-1', true)], nextCursor: null, archived: true }));
    store.dispatch(
      appendThreads({ threads: [thread('active-1'), thread('active-2')], nextCursor: null, archived: false }),
    );

    expect(selectActiveThreads(store.getState()).map((entry) => entry.threadRootMessage.id)).toEqual([
      'active-1',
      'active-2',
    ]);
    expect(selectArchivedThreads(store.getState()).map((entry) => entry.threadRootMessage.id)).toEqual(['archived-1']);
  });
});
