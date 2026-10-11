import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chatsReducer, { setChatsList, type ChatsState } from '@/store/chatsSlice';
import threadsReducer, { setThreadsList } from '@/store/threadsSlice';
import { useDocumentTitle } from './useDocumentTitle';
import type { ChatListEntry } from '@/api/chats';
import type { ThreadListItem } from '@/api/threads';

vi.mock('@/utils/dom', () => ({
  isPageHidden: vi.fn(() => hiddenRef.value),
  getOverlayPortalTarget: vi.fn(() => document.body),
}));

const hiddenRef = { value: true };

function chatEntry(over: Partial<ChatListEntry> = {}): ChatListEntry {
  return {
    id: 'c1',
    name: 'Chat',
    avatar: null,
    lastMessageAt: null,
    unreadCount: 0,
    unreadMentions: 0,
    lastMessage: null,
    mutedUntil: null,
    archived: false,
    ...over,
  };
}

const thread: ThreadListItem = {
  chatId: 'c1',
  chatName: 'Chat',
  chatAvatar: null,
  threadRootMessage: {
    id: 't9',
    clientGeneratedId: 'cg-t9',
    createdAt: '2026-08-31T00:00:00Z',
    message: null,
    messageType: 'text',
    sender: { uid: 1, name: 'Alice', gender: 0 },
    isDeleted: false,
  },
  participants: [],
  lastReply: null,
  replyCount: 2,
  lastReplyAt: '2026-08-31T00:00:00Z',
  unreadCount: 0,
  unreadMentions: 0,
  unreadReactions: 0,
  lastReadMessageId: null,
  subscribedAt: '2026-08-31T00:00:00Z',
  archived: false,
};

function renderHook({ chats, threads }: { chats: ChatsState; threads: ReturnType<typeof threadsReducer> }) {
  const store = configureStore({
    reducer: { chats: chatsReducer, threads: threadsReducer },
    preloadedState: { chats, threads },
  });
  function Probe() {
    useDocumentTitle(undefined, undefined);
    return null;
  }
  return (
    <Provider store={store}>
      <Probe />
    </Provider>
  );
}

describe('useDocumentTitle mention prefix', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    document.title = '茶话';
    hiddenRef.value = true;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    hiddenRef.value = false;
    document.title = '茶话';
  });

  it('shows (@) while hidden when a chat has unread mentions', () => {
    const chats = chatsReducer(
      undefined,
      setChatsList({ chats: [chatEntry({ unreadMentions: 2 })], nextCursor: null }),
    );
    const threads = threadsReducer(undefined, { type: '@@init' });

    act(() => {
      root.render(renderHook({ chats, threads }));
    });

    expect(document.title).toBe('(@) 茶话');
  });

  it('shows (@) when only a muted chat has unread mentions', () => {
    const chats = chatsReducer(
      undefined,
      setChatsList({ chats: [chatEntry({ unreadMentions: 1, mutedUntil: '9999-12-31T23:59:59Z' })], nextCursor: null }),
    );
    const threads = threadsReducer(undefined, { type: '@@init' });

    act(() => {
      root.render(renderHook({ chats, threads }));
    });

    expect(document.title).toBe('(@) 茶话');
  });

  it('ignores mentions in archived chats', () => {
    const chats = chatsReducer(
      undefined,
      setChatsList({ chats: [chatEntry({ unreadMentions: 3, archived: true })], nextCursor: null }),
    );
    const threads = threadsReducer(undefined, { type: '@@init' });

    act(() => {
      root.render(renderHook({ chats, threads }));
    });

    expect(document.title).toBe('茶话');
  });

  it('shows the numeric prefix when there are unreads but no mentions', () => {
    const chats = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadCount: 3 })], nextCursor: null }));
    const threads = threadsReducer(undefined, { type: '@@init' });

    act(() => {
      root.render(renderHook({ chats, threads }));
    });

    expect(document.title).toBe('(1) 茶话');
  });

  it('shows the bare title when there is nothing unread', () => {
    const chats = chatsReducer(undefined, setChatsList({ chats: [chatEntry()], nextCursor: null }));
    const threads = threadsReducer(undefined, { type: '@@init' });

    act(() => {
      root.render(renderHook({ chats, threads }));
    });

    expect(document.title).toBe('茶话');
  });

  it('shows (@) when only a thread has unread mentions', () => {
    const chats = chatsReducer(undefined, { type: '@@init' });
    const threads = threadsReducer(
      undefined,
      setThreadsList({ threads: [{ ...thread, unreadMentions: 1 }], nextCursor: null }),
    );

    act(() => {
      root.render(renderHook({ chats, threads }));
    });

    expect(document.title).toBe('(@) 茶话');
  });

  it('recovers the base title from a stale (@) prefix on reload', () => {
    document.title = '(@) 茶话';
    const chats = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadCount: 2 })], nextCursor: null }));
    const threads = threadsReducer(undefined, { type: '@@init' });

    act(() => {
      root.render(renderHook({ chats, threads }));
    });

    expect(document.title).toBe('(1) 茶话');
  });
});
