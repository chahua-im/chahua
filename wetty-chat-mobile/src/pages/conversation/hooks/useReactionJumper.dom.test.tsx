import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUnreadReactionIds } from '@/api/chats';
import { useReactionJumper } from './useReactionJumper';

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

vi.mock('@/api/chats', () => ({
  getUnreadMentionIds: vi.fn(),
  getUnreadReactionIds: vi.fn(),
}));

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));

const dispatch = vi.fn();
const selectorState = {
  chats: {
    byId: {} as Record<string, { liveProjection: Record<string, unknown>; listSnapshot: Record<string, unknown> }>,
  },
  threads: {
    unreadReactionIdsByThread: {} as Record<string, string[]>,
    unreadReactionIdsStatusByThread: {} as Record<string, string>,
    items: [] as unknown[],
  },
};
vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
  useSelector: (selector: (state: typeof selectorState) => unknown) => selector(selectorState),
  shallowEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
}));

interface HookState {
  canJump: boolean;
  unreadCount: number;
  jumpToNextReaction: () => Promise<void>;
}

interface RenderOptions {
  threadId?: string;
  showToast?: (message: string) => void;
}

function TestComponent({
  chatId,
  threadId,
  jumpToMessage,
  enabled,
  showToast,
  onRender,
}: {
  chatId: string;
  threadId?: string;
  jumpToMessage: (id: string) => void;
  enabled?: boolean;
  showToast?: (message: string) => void;
  onRender: (state: HookState) => void;
}) {
  const state = useReactionJumper({ chatId, threadId, jumpToMessage, showToast, enabled });
  onRender(state);
  return null;
}

function setChatState(over: { unreadReactions?: number; ids?: string[]; status?: string }) {
  selectorState.chats.byId['chat-1'] = {
    liveProjection: {
      inList: true,
      unreadReactions: over.unreadReactions ?? 0,
      unreadReactionIds: over.ids ?? [],
      unreadReactionIdsStatus: over.status ?? 'idle',
    },
    listSnapshot: { unreadReactions: 0 },
  };
}

function setThreadState(over: { unreadReactions?: number; ids?: string[]; status?: string }) {
  selectorState.threads.items = [{ threadRootMessage: { id: 'thread-1' }, unreadReactions: over.unreadReactions ?? 0 }];
  selectorState.threads.unreadReactionIdsByThread = over.ids ? { 'thread-1': over.ids } : {};
  selectorState.threads.unreadReactionIdsStatusByThread = { 'thread-1': over.status ?? 'idle' };
}

describe('useReactionJumper', () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: HookState;
  const jumpToMessage = vi.fn();

  async function renderHook(enabled?: boolean, options?: RenderOptions) {
    await act(async () => {
      root.render(
        <TestComponent
          chatId="chat-1"
          threadId={options?.threadId}
          jumpToMessage={jumpToMessage}
          enabled={enabled}
          showToast={options?.showToast}
          onRender={(nextState) => (state = nextState)}
        />,
      );
      // Flush the eager-fetch promise chain (then/catch/finally).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    jumpToMessage.mockReset();
    vi.mocked(getUnreadReactionIds).mockReset();
    vi.mocked(getUnreadReactionIds).mockResolvedValue(response({ messageIds: ['30', '20'] }));
    dispatch.mockReset();
    setChatState({ unreadReactions: 0, ids: [], status: 'idle' });
    setThreadState({ unreadReactions: 0, ids: [], status: 'idle' });
    selectorState.threads.items = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('eagerly fetches reaction ids when the badge is non-zero and the cache is idle', async () => {
    setChatState({ unreadReactions: 2, ids: [], status: 'idle' });
    await renderHook();

    expect(getUnreadReactionIds).toHaveBeenCalledWith('chat-1', { threadId: undefined });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chats/setChatUnreadReactionIds',
        payload: { chatId: 'chat-1', ids: ['30', '20'] },
      }),
    );
  });

  it('does not fetch when there are no unread reactions', async () => {
    setChatState({ unreadReactions: 0, ids: [], status: 'idle' });
    await renderHook();

    expect(getUnreadReactionIds).not.toHaveBeenCalled();
    expect(state.canJump).toBe(false);
  });

  it('does not fetch or jump when the feature gate is disabled', async () => {
    setChatState({ unreadReactions: 2, ids: ['30', '20'], status: 'ready' });
    await renderHook(false);

    expect(getUnreadReactionIds).not.toHaveBeenCalled();
    expect(state.canJump).toBe(false);

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(jumpToMessage).not.toHaveBeenCalled();
  });

  it('jumps to the oldest reacted message on first tap, then cycles newer, then wraps', async () => {
    setChatState({ unreadReactions: 2, ids: ['30', '20'], status: 'ready' });
    await renderHook();

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('20');

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('30');

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('20');
  });

  it('does not jump when there are no unread reactions', async () => {
    setChatState({ unreadReactions: 0, ids: [], status: 'ready' });
    await renderHook();

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(jumpToMessage).not.toHaveBeenCalled();
  });

  it('fetches thread-scope reaction ids when a threadId is passed', async () => {
    setThreadState({ unreadReactions: 2, status: 'idle' });
    await renderHook(undefined, { threadId: 'thread-1' });

    expect(getUnreadReactionIds).toHaveBeenCalledWith('chat-1', { threadId: 'thread-1' });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'threads/setThreadUnreadReactionIds',
        payload: { threadRootId: 'thread-1', ids: ['30', '20'] },
      }),
    );
  });

  it('cycles thread reactions oldest-first within the thread cache', async () => {
    setThreadState({ unreadReactions: 2, ids: ['30', '20'], status: 'ready' });
    await renderHook(undefined, { threadId: 'thread-1' });

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('20');

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('30');

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('20');
  });

  it('shows a toast and invalidates the cache when the id fetch fails', async () => {
    setChatState({ unreadReactions: 2, status: 'idle' });
    const showToast = vi.fn();
    vi.mocked(getUnreadReactionIds).mockRejectedValue(new Error('offline'));
    await renderHook(undefined, { showToast });

    await act(async () => {
      await state.jumpToNextReaction();
    });
    expect(showToast).toHaveBeenCalledWith('Failed to load reactions');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chats/setChatUnreadReactionIdsStatus',
        payload: { chatId: 'chat-1', status: 'idle' },
      }),
    );
    expect(jumpToMessage).not.toHaveBeenCalled();
  });
});
