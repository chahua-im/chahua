import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import { getMessages } from '@/api/messages';
import { getThreadReadState } from '@/api/threads';
import type { VirtualScrollHandle } from '@/components/chat/virtualScroll/types';
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

function emptyState(messages: MessageResponse[] = []): RootState {
  return {
    messages: {
      chats:
        messages.length > 0
          ? {
              'chat-1': {
                segments: [{ messages, nextCursor: 'old-cursor', prevCursor: null }],
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
  } as RootState;
}

function TestComponent({
  initialResumeMessageId = null,
  threadId,
  onRender,
  showToast,
}: {
  initialResumeMessageId?: string | null;
  threadId?: string;
  onRender: (state: HookState) => void;
  showToast: (message: string) => void;
}) {
  const timeline = useConversationTimeline({
    chatId: 'chat-1',
    storeChatId: threadId ? `chat-1_thread_${threadId}` : 'chat-1',
    threadId,
    initialResumeMessageId,
    lastReadMessageId: '5',
    scrollToBottomUnreadCount: 0,
    threadLastReadMessageIdRef: { current: null },
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
      response({ messages: [message('10'), message('11')], nextCursor: '10', prevCursor: null }),
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
        payload: { chatId: 'chat-1', messages: [message('10'), message('11')], nextCursor: '10', prevCursor: null },
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/setTimelineMode',
        payload: { chatId: 'chat-1', mode: { type: 'latest' } },
      }),
    );
  });

  it('loads around the initial resume target before latest load', async () => {
    await renderHook({ initialResumeMessageId: '20' });

    expect(getMessages).toHaveBeenCalledWith('chat-1', { around: '20', max: 50, threadId: undefined });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/insertAround',
        payload: {
          chatId: 'chat-1',
          targetMessageId: '20',
          messages: [message('10'), message('11')],
          nextCursor: '10',
          prevCursor: null,
        },
      }),
    );
    expect(state.timeline.initialAnchor).toEqual({ type: 'message', messageId: '20', token: 1 });
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
          nextCursor: '10',
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

    expect(scrollToMessageId).toHaveBeenCalledWith('10', 'smooth');
    expect(getMessages).not.toHaveBeenCalled();
  });
});
