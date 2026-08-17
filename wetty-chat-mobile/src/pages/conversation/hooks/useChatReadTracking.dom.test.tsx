import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markMessagesAsRead } from '@/api/messages';
import { markThreadAsRead } from '@/api/threads';
import { READ_REQUEST_COOLDOWN_MS } from '@/constants/chatTiming';
import { syncAppBadgeCount } from '@/utils/badges';
import { useChatReadTracking } from './useChatReadTracking';

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

let pageHidden = false;
vi.mock('@/utils/dom', () => ({
  isPageHidden: () => pageHidden,
}));

vi.mock('@/api/messages', () => ({
  markMessagesAsRead: vi.fn(),
}));

vi.mock('@/api/threads', () => ({
  markThreadAsRead: vi.fn(),
}));

vi.mock('@/utils/badges', () => ({
  syncAppBadgeCount: vi.fn(),
}));

const dispatch = vi.fn();
vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
}));

function TestComponent({
  threadId,
  lastFullyVisibleMessageId,
  lastReadMessageId,
  atBottom = false,
  initialResumeMessageId = null,
}: {
  threadId?: string;
  lastFullyVisibleMessageId: string | null;
  lastReadMessageId: string | null;
  atBottom?: boolean;
  initialResumeMessageId?: string | null;
}) {
  useChatReadTracking({
    chatId: 'chat-1',
    storeChatId: threadId ? `chat-1_thread_${threadId}` : 'chat-1',
    threadId,
    lastFullyVisibleMessageId,
    lastReadMessageId,
    initialResumeMessageId,
    atBottom,
  });
  return null;
}

describe('useChatReadTracking', () => {
  let host: HTMLDivElement;
  let root: Root;

  function renderHook(props: React.ComponentProps<typeof TestComponent>) {
    act(() => {
      root.render(<TestComponent {...props} />);
    });
  }

  async function advanceReadCooldown() {
    await act(async () => {
      vi.advanceTimersByTime(READ_REQUEST_COOLDOWN_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    pageHidden = false;
    vi.mocked(markMessagesAsRead).mockResolvedValue(response({ lastReadMessageId: '20', unreadCount: 0 }));
    vi.mocked(markThreadAsRead).mockResolvedValue(response({ lastReadMessageId: '20', unreadCount: 0 }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('marks the main chat read after the cooldown when a newer message is fully visible', async () => {
    renderHook({ lastFullyVisibleMessageId: '20', lastReadMessageId: '10' });

    await advanceReadCooldown();

    expect(markMessagesAsRead).toHaveBeenCalledWith('chat-1', '20');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chats/setChatLastReadMessageId',
        payload: { chatId: 'chat-1', lastReadMessageId: '20' },
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chats/setChatUnreadCount',
        payload: { chatId: 'chat-1', unreadCount: 0 },
      }),
    );
    expect(syncAppBadgeCount).toHaveBeenCalled();
  });

  it('does not mark main chat read when the target is already read or not numeric', async () => {
    renderHook({ lastFullyVisibleMessageId: '10', lastReadMessageId: '20' });
    await advanceReadCooldown();
    expect(markMessagesAsRead).not.toHaveBeenCalled();

    renderHook({ lastFullyVisibleMessageId: 'cg_local', lastReadMessageId: '20' });
    await advanceReadCooldown();
    expect(markMessagesAsRead).not.toHaveBeenCalled();
  });

  it('does not flush read state while the page is hidden', async () => {
    pageHidden = true;
    renderHook({ lastFullyVisibleMessageId: '20', lastReadMessageId: '10' });

    await advanceReadCooldown();

    expect(markMessagesAsRead).not.toHaveBeenCalled();
  });

  it('marks thread read after the cooldown when a numeric message is visible', async () => {
    renderHook({ threadId: 'thread-1', lastFullyVisibleMessageId: '20', lastReadMessageId: null });

    await advanceReadCooldown();

    expect(markThreadAsRead).toHaveBeenCalledWith('chat-1', 'thread-1', '20');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'threads/setThreadReadState',
        payload: { threadRootId: 'thread-1', lastReadMessageId: '20', unreadCount: 0 },
      }),
    );
  });
});
