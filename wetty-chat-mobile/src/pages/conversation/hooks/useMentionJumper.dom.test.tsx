import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUnreadMentionIds } from '@/api/chats';
import { pickNextUnreadId } from '@/store/mentionIdCache';
import { useMentionJumper } from './useMentionJumper';

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

vi.mock('@/api/chats', () => ({
  getUnreadMentionIds: vi.fn(),
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
    unreadMentionIdsByThread: {} as Record<string, string[]>,
    unreadMentionIdsStatusByThread: {} as Record<string, string>,
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
  jumpToNextMention: () => Promise<void>;
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
  const state = useMentionJumper({ chatId, threadId, jumpToMessage, showToast, enabled });
  onRender(state);
  return null;
}

function setChatState(over: { unreadMentions?: number; ids?: string[]; status?: string }) {
  selectorState.chats.byId['chat-1'] = {
    liveProjection: {
      inList: true,
      unreadMentions: over.unreadMentions ?? 0,
      unreadMentionIds: over.ids ?? [],
      unreadMentionIdsStatus: over.status ?? 'idle',
    },
    listSnapshot: { unreadMentions: 0 },
  };
}

function setThreadState(over: { unreadMentions?: number; ids?: string[]; status?: string }) {
  selectorState.threads.items = [{ threadRootMessage: { id: 'thread-1' }, unreadMentions: over.unreadMentions ?? 0 }];
  selectorState.threads.unreadMentionIdsByThread = over.ids ? { 'thread-1': over.ids } : {};
  selectorState.threads.unreadMentionIdsStatusByThread = { 'thread-1': over.status ?? 'idle' };
}

describe('pickNextUnreadId', () => {
  it('returns null for an empty list', () => {
    expect(pickNextUnreadId([], null)).toBeNull();
  });

  it('returns the oldest when nothing has been viewed', () => {
    expect(pickNextUnreadId(['30', '20', '10'], null)).toBe('10');
  });

  it('advances to the next-newer after viewing the oldest', () => {
    expect(pickNextUnreadId(['30', '20', '10'], '10')).toBe('20');
  });

  it('returns null after viewing the newest (single pass, no wrap)', () => {
    expect(pickNextUnreadId(['30', '20', '10'], '30')).toBeNull();
  });

  it('falls back to the oldest when lastJumpedId is no longer in the list', () => {
    expect(pickNextUnreadId(['30', '20'], '99')).toBe('20');
  });

  it('returns null when the sole id has been viewed', () => {
    expect(pickNextUnreadId(['30'], '30')).toBeNull();
  });
});

describe('useMentionJumper', () => {
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
    vi.mocked(getUnreadMentionIds).mockReset();
    vi.mocked(getUnreadMentionIds).mockResolvedValue(response({ messageIds: ['30', '20', '10'] }));
    dispatch.mockReset();
    setChatState({ unreadMentions: 0, ids: [], status: 'idle' });
    setThreadState({ unreadMentions: 0, ids: [], status: 'idle' });
    selectorState.threads.items = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('eagerly fetches mention ids when the badge is non-zero and the cache is idle', async () => {
    setChatState({ unreadMentions: 3, ids: [], status: 'idle' });
    await renderHook();

    expect(getUnreadMentionIds).toHaveBeenCalledWith('chat-1', { threadId: undefined });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chats/setChatUnreadMentionIds',
        payload: { chatId: 'chat-1', ids: ['30', '20', '10'] },
      }),
    );
  });

  it('does not fetch when there are no unread mentions', async () => {
    setChatState({ unreadMentions: 0, ids: [], status: 'idle' });
    await renderHook();

    expect(getUnreadMentionIds).not.toHaveBeenCalled();
    expect(state.canJump).toBe(false);
  });

  it('does not fetch or jump when the feature gate is disabled', async () => {
    setChatState({ unreadMentions: 3, ids: ['30', '20', '10'], status: 'ready' });
    await renderHook(false);

    expect(getUnreadMentionIds).not.toHaveBeenCalled();
    expect(state.canJump).toBe(false);

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).not.toHaveBeenCalled();
  });

  it('jumps oldest-first through each mention once, then hides the fab', async () => {
    setChatState({ unreadMentions: 3, ids: ['30', '20', '10'], status: 'ready' });
    await renderHook();

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('10');

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('20');

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('30');

    // Pass exhausted: the fab hides and further taps do nothing.
    expect(state.canJump).toBe(false);
    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenCalledTimes(3);
  });

  it('resumes the chronological pass when a newer id arrives after exhaustion', async () => {
    setChatState({ unreadMentions: 2, ids: ['20', '10'], status: 'ready' });
    await renderHook();

    await act(async () => {
      await state.jumpToNextMention();
    });
    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(state.canJump).toBe(false);

    // A WS notification prepends a fresh mention to the ready cache; the pass
    // resumes chronologically, so the next target is the new (newest) id.
    setChatState({ unreadMentions: 3, ids: ['40', '20', '10'], status: 'ready' });
    await act(async () => {
      root.render(
        <TestComponent chatId="chat-1" jumpToMessage={jumpToMessage} onRender={(nextState) => (state = nextState)} />,
      );
    });

    expect(state.canJump).toBe(true);
    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('40');
  });

  it('does not jump when there are no unread mentions', async () => {
    setChatState({ unreadMentions: 0, ids: [], status: 'ready' });
    await renderHook();

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).not.toHaveBeenCalled();
  });

  it('fetches thread-scope mention ids when a threadId is passed', async () => {
    setThreadState({ unreadMentions: 2, status: 'idle' });
    await renderHook(undefined, { threadId: 'thread-1' });

    expect(getUnreadMentionIds).toHaveBeenCalledWith('chat-1', { threadId: 'thread-1' });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'threads/setThreadUnreadMentionIds',
        payload: { threadRootId: 'thread-1', ids: ['30', '20', '10'] },
      }),
    );
  });

  it('visits thread mentions oldest-first once within the thread cache, then hides', async () => {
    setThreadState({ unreadMentions: 2, ids: ['30', '20'], status: 'ready' });
    await renderHook(undefined, { threadId: 'thread-1' });

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('20');

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('30');

    expect(state.canJump).toBe(false);
    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenCalledTimes(2);
  });

  it('shows a toast and invalidates the cache when the id fetch fails', async () => {
    setChatState({ unreadMentions: 3, status: 'idle' });
    const showToast = vi.fn();
    vi.mocked(getUnreadMentionIds).mockRejectedValue(new Error('offline'));
    await renderHook(undefined, { showToast });

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(showToast).toHaveBeenCalledWith('Failed to load mentions');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chats/setChatUnreadMentionIdsStatus',
        payload: { chatId: 'chat-1', status: 'idle' },
      }),
    );
    expect(jumpToMessage).not.toHaveBeenCalled();
  });
});
