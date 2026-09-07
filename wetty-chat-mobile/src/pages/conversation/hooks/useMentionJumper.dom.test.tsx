import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUnreadMentionIds } from '@/api/chats';
import { pickNextMention, useMentionJumper } from './useMentionJumper';

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

vi.mock('@/api/chats', () => ({
  getUnreadMentionIds: vi.fn(),
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

function TestComponent({
  chatId,
  threadId,
  jumpToMessage,
  enabled,
  onRender,
}: {
  chatId: string;
  threadId?: string;
  jumpToMessage: (id: string) => void;
  enabled?: boolean;
  onRender: (state: HookState) => void;
}) {
  const state = useMentionJumper({ chatId, threadId, jumpToMessage, enabled });
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

describe('pickNextMention', () => {
  it('returns null for an empty list', () => {
    expect(pickNextMention([], null)).toBeNull();
  });

  it('returns the oldest when nothing has been viewed', () => {
    expect(pickNextMention(['30', '20', '10'], null)).toBe('10');
  });

  it('advances to the next-newer after viewing the oldest', () => {
    expect(pickNextMention(['30', '20', '10'], '10')).toBe('20');
  });

  it('wraps to the oldest after viewing the newest', () => {
    expect(pickNextMention(['30', '20', '10'], '30')).toBe('10');
  });

  it('falls back to the oldest when lastJumpedId is no longer in the list', () => {
    expect(pickNextMention(['30', '20'], '99')).toBe('20');
  });

  it('re-views the only mention when it is the sole id', () => {
    expect(pickNextMention(['30'], '30')).toBe('30');
  });
});

describe('useMentionJumper', () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: HookState;
  const jumpToMessage = vi.fn();

  async function renderHook(enabled?: boolean) {
    await act(async () => {
      root.render(
        <TestComponent
          chatId="chat-1"
          jumpToMessage={jumpToMessage}
          enabled={enabled}
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

  it('jumps to the oldest mention on first tap, then cycles newer, then wraps', async () => {
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

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).toHaveBeenLastCalledWith('10');
  });

  it('does not jump when there are no unread mentions', async () => {
    setChatState({ unreadMentions: 0, ids: [], status: 'ready' });
    await renderHook();

    await act(async () => {
      await state.jumpToNextMention();
    });
    expect(jumpToMessage).not.toHaveBeenCalled();
  });
});
