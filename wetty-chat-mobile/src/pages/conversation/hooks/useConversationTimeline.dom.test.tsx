import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRef } from 'react';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import { getMessages } from '@/api/messages';
import { getThreadReadState } from '@/api/threads';
import { DEFAULT_OFFSET_RATIO, type VirtualScrollHandle } from '@/components/chat/virtualScroll/types';
import type { RootState } from '@/store';
import { useConversationTimeline } from './useConversationTimeline';

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

function message(id: string): MessageResponse {
  return {
    id,
    clientGeneratedId: `client-${id}`,
    chatId: 'chat-1',
    replyRootId: null,
    message: `message ${id}`,
    messageType: 'text',
    sender: { uid: 2, name: 'User', gender: 0 },
    createdAt: new Date(Number(id)).toISOString(),
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
  };
}

let fakeState: RootState;
const dispatch = vi.fn();

vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
  useSelector: (selector: (state: RootState) => unknown) => selector(fakeState),
}));

vi.mock('@/api/messages', () => ({
  getMessages: vi.fn(),
}));

vi.mock('@/api/threads', () => ({
  getThreadReadState: vi.fn(),
}));

vi.mock('@/store/index', () => ({
  default: {
    getState: () => fakeState,
  },
}));

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));

interface HookState {
  timeline: ReturnType<typeof useConversationTimeline>;
}

function emptyState(messages: MessageResponse[] = [], threadUnreadCount = 0, threadId = '20'): RootState {
  return {
    messages: {
      chats:
        messages.length > 0
          ? {
              'chat-1': {
                segments: [{ messages, olderCursor: 'old-cursor', newerCursor: null }],
                optimisticMessages: [],
                hasReachedOldest: false,
                hasReachedLatest: true,
                generation: 1,
              },
            }
          : {},
      views: {},
    },
    settings: {
      showAllAvatars: false,
    },
    // threadsSlice shape needed by selectThreadUnreadCount when a thread opens;
    // the item id defaults to the threadId used by the tests below.
    threads: {
      items: [
        {
          threadRootMessage: { id: threadId },
          unreadCount: threadUnreadCount,
        },
      ],
    },
  } as RootState;
}

function TestComponent({
  initialResumeMessageId = null,
  threadId,
  scrollToBottomUnreadCount = 0,
  threadLastReadMessageIdRef: providedThreadLastReadMessageIdRef,
  onRender,
  showToast,
}: {
  initialResumeMessageId?: string | null;
  threadId?: string;
  scrollToBottomUnreadCount?: number;
  threadLastReadMessageIdRef?: { current: string | null };
  onRender: (state: HookState) => void;
  showToast: (message: string) => void;
}) {
  const fallbackRef = useRef<string | null>(null);
  const timeline = useConversationTimeline({
    chatId: 'chat-1',
    storeChatId: threadId ? `chat-1_thread_${threadId}` : 'chat-1',
    threadId,
    initialResumeMessageId,
    lastReadMessageId: '5',
    scrollToBottomUnreadCount,
    threadLastReadMessageIdRef: providedThreadLastReadMessageIdRef ?? fallbackRef,
    formatDateSeparator: () => 'date',
    showToast,
  });
  onRender({ timeline });
  return null;
}

describe('useConversationTimeline', () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: HookState;
  let showToast: (message: string) => void;

  async function renderHook(props: Partial<React.ComponentProps<typeof TestComponent>> = {}) {
    await act(async () => {
      root.render(
        <TestComponent
          showToast={showToast}
          onRender={(nextState) => {
            state = nextState;
          }}
          {...props}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fakeState = emptyState();
    showToast = vi.fn();
    vi.mocked(getMessages).mockResolvedValue(
      response({ messages: [message('10'), message('11')], olderCursor: '10', newerCursor: null }),
    );
    vi.mocked(getThreadReadState).mockResolvedValue(response({ lastReadMessageId: '9' }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('loads the latest message window on first main-chat render', async () => {
    await renderHook();

    expect(getMessages).toHaveBeenCalledWith('chat-1', undefined);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/refreshLatest',
        payload: { chatId: 'chat-1', messages: [message('10'), message('11')], olderCursor: '10', newerCursor: null },
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/setTimelineMode',
        payload: { chatId: 'chat-1', mode: { type: 'latest' } },
      }),
    );
  });

  it('anchors to the resume target when the around window contains it', async () => {
    vi.mocked(getMessages).mockResolvedValue(
      response({ messages: [message('19'), message('20'), message('21')], olderCursor: '19', newerCursor: '21' }),
    );

    await renderHook({ initialResumeMessageId: '20' });

    expect(getMessages).toHaveBeenCalledWith('chat-1', { around: '20', max: 50, threadId: undefined });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/insertAround',
        payload: {
          chatId: 'chat-1',
          targetMessageId: '20',
          messages: [message('19'), message('20'), message('21')],
          olderCursor: '19',
          newerCursor: '21',
        },
      }),
    );
    expect(state.timeline.initialAnchor).toEqual({ type: 'message', messageId: '20', token: 1, align: 'top' });
  });

  it('falls back to the latest message when the resume target is missing from the around window', async () => {
    // The around fetch returns a window that does not contain the requested
    // target (e.g. the target was soft-deleted and is no longer addressable).
    // The anchor must degrade to the newest message instead of stranding the
    // scroll position on a phantom row.
    vi.mocked(getMessages).mockResolvedValue(
      response({ messages: [message('10'), message('11')], olderCursor: '10', newerCursor: null }),
    );

    await renderHook({ initialResumeMessageId: '20' });

    expect(getMessages).toHaveBeenCalledWith('chat-1', { around: '20', max: 50, threadId: undefined });
    expect(state.timeline.initialAnchor).toEqual({ type: 'bottom', token: 1 });
  });

  it('loads older messages from the current older anchor', async () => {
    fakeState = emptyState([message('10'), message('11')]);
    await renderHook();
    vi.mocked(getMessages).mockClear();

    await act(async () => {
      state.timeline.loadOlder.onLoad();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getMessages).toHaveBeenCalledWith('chat-1', { before: 'old-cursor', max: 50, threadId: undefined });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/insertBeforeAnchor',
        payload: {
          chatId: 'chat-1',
          anchorMessageId: 'old-cursor',
          messages: [message('10'), message('11')],
          olderCursor: '10',
        },
      }),
    );
    expect(state.timeline.loadOlder.loading).toBe(false);
  });

  it('scrolls to an already-loaded message without fetching around it', async () => {
    fakeState = emptyState([message('10'), message('11')]);
    await renderHook();
    const scrollToMessageId = vi.fn();
    state.timeline.scrollApiRef.current = {
      scrollToBottom: vi.fn(),
      scrollToItem: vi.fn(),
      scrollToMessageId,
    } satisfies VirtualScrollHandle;
    vi.mocked(getMessages).mockClear();

    await expect(state.timeline.jumpToMessage('10')).resolves.toBe(true);

    expect(scrollToMessageId).toHaveBeenCalledWith('10', 'smooth', 'top', DEFAULT_OFFSET_RATIO);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('shows the scroll-to-bottom button with the unread count for a thread with unread replies', async () => {
    fakeState = emptyState([message('10'), message('11')]);
    // FAB visibility must come from the unread count alone, not from scroll
    // direction or anchor position.
    await renderHook({ threadId: '20', scrollToBottomUnreadCount: 42 });

    expect(state.timeline.pendingJumpCount).toBe(42);
    expect(state.timeline.showScrollToBottomButton).toBe(true);
  });

  it('hides the scroll-to-bottom button when the thread has no unread replies', async () => {
    fakeState = emptyState([message('10'), message('11')]);
    await renderHook({ threadId: '20', scrollToBottomUnreadCount: 0 });

    expect(state.timeline.pendingJumpCount).toBe(0);
    expect(state.timeline.showScrollToBottomButton).toBe(false);
  });

  it('records the thread read position in the store after fetching the read state', async () => {
    fakeState = emptyState([message('10'), message('11')]);
    await renderHook({ threadId: '20' });

    expect(getThreadReadState).toHaveBeenCalledWith('chat-1', '20');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'threads/setThreadLastReadMessageId',
        payload: { threadRootId: '20', lastReadMessageId: '9' },
      }),
    );
  });

  it('seeds the thread last-read ref from the fetched read state for the initial anchor', async () => {
    fakeState = emptyState([message('10'), message('11')]);
    const threadLastReadMessageIdRef = { current: null as string | null };
    await renderHook({ threadId: '20', threadLastReadMessageIdRef });

    expect(threadLastReadMessageIdRef.current).toBe('9');
  });

  it('opens a thread with unread replies around the read boundary instead of the latest window', async () => {
    // Anchoring the latest window strands the read boundary outside the loaded
    // range: the view falls to the bottom and read tracking immediately marks
    // the unseen tail as read, zeroing the unread badge.
    fakeState = emptyState([message('10'), message('11')], 42);
    vi.mocked(getMessages).mockResolvedValue(
      response({ messages: [message('8'), message('9'), message('10')], olderCursor: '8', newerCursor: '10' }),
    );

    await renderHook({ threadId: '20', scrollToBottomUnreadCount: 42 });

    expect(getMessages).toHaveBeenCalledWith('chat-1', { around: '9', max: 50, threadId: '20' });
    expect(state.timeline.initialAnchor).toEqual({ type: 'message', messageId: '9', token: 1, align: 'top' });
    expect(state.timeline.pendingJumpCount).toBe(42);
  });

  it('opens a fully read thread on the latest window', async () => {
    fakeState = emptyState([message('10'), message('11')]);

    await renderHook({ threadId: '20', scrollToBottomUnreadCount: 0 });

    expect(getMessages).toHaveBeenCalledWith('chat-1', { threadId: '20' });
  });
});
