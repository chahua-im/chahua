import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveThread, getThreadSubscriptionStatus, subscribeToThread, unarchiveThread } from '@/api/threads';
import { useThreadSubscription } from './useThreadSubscription';

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));

const presentAlert = vi.fn();
vi.mock('@ionic/react', () => ({
  useIonAlert: () => [presentAlert],
}));

const dispatch = vi.fn();
const selectorState = {
  threads: {
    items: [],
    buckets: {
      active: { nextCursor: null, isLoaded: false, isLoading: false, pageDepth: 0 },
      archived: { nextCursor: null, isLoaded: false, isLoading: false, pageDepth: 0 },
    },
    subscriptionByThreadId: {} as Record<string, boolean>,
    archivedByThreadId: {} as Record<string, boolean>,
  },
};
vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
  useSelector: (selector: (state: typeof selectorState) => unknown) => selector(selectorState),
}));

vi.mock('@/api/threads', () => ({
  archiveThread: vi.fn(),
  getThreadSubscriptionStatus: vi.fn(),
  subscribeToThread: vi.fn(),
  unarchiveThread: vi.fn(),
}));

interface HookState {
  threadSubscribed: boolean | null;
  threadArchived: boolean;
  threadSubLoading: boolean;
  handleToggleThreadSubscription: () => Promise<void>;
  markThreadSubscribedOptimistically: () => void;
}

function TestComponent({
  chatId,
  threadId,
  onRender,
}: {
  chatId: string;
  threadId?: string;
  onRender: (state: HookState) => void;
}) {
  const state = useThreadSubscription({ chatId, threadId });
  onRender(state);
  return null;
}

describe('useThreadSubscription', () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: HookState;

  async function renderHook(threadId = 'thread-1') {
    await act(async () => {
      root.render(<TestComponent chatId="chat-1" threadId={threadId} onRender={(nextState) => (state = nextState)} />);
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    selectorState.threads.subscriptionByThreadId = {};
    selectorState.threads.archivedByThreadId = {};
    vi.mocked(getThreadSubscriptionStatus).mockResolvedValue(response({ subscribed: false, archived: false }));
    vi.mocked(archiveThread).mockResolvedValue(response(undefined));
    vi.mocked(subscribeToThread).mockResolvedValue(response(undefined));
    vi.mocked(unarchiveThread).mockResolvedValue(response(undefined));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('loads subscription status and mirrors it into Redux', async () => {
    vi.mocked(getThreadSubscriptionStatus).mockResolvedValue(response({ subscribed: true, archived: false }));

    await renderHook();

    expect(getThreadSubscriptionStatus).toHaveBeenCalledWith('chat-1', 'thread-1');
    expect(state.threadSubscribed).toBe(true);
    expect(state.threadArchived).toBe(false);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'threads/setThreadSubscriptionStatus',
        payload: { threadRootId: 'thread-1', subscribed: true, archived: false },
      }),
    );
  });

  it('archives an already subscribed thread', async () => {
    vi.mocked(getThreadSubscriptionStatus).mockResolvedValue(response({ subscribed: true, archived: false }));
    await renderHook();

    await act(async () => {
      await state.handleToggleThreadSubscription();
    });

    expect(archiveThread).toHaveBeenCalledWith('chat-1', 'thread-1');
    expect(state.threadSubscribed).toBe(true);
    expect(state.threadArchived).toBe(true);
  });

  it('uses an alert confirmation before unarchiving', async () => {
    vi.mocked(getThreadSubscriptionStatus).mockResolvedValue(response({ subscribed: true, archived: true }));
    await renderHook();

    await act(async () => {
      await state.handleToggleThreadSubscription();
    });

    expect(presentAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Unarchive thread?',
      }),
    );

    const alert = presentAlert.mock.calls[0][0] as { buttons: { text: string; handler?: () => void }[] };
    await act(async () => {
      alert.buttons[1].handler?.();
      await Promise.resolve();
    });

    expect(unarchiveThread).toHaveBeenCalledWith('chat-1', 'thread-1');
    expect(state.threadSubscribed).toBe(true);
    expect(state.threadArchived).toBe(false);
  });

  it('allows send flow to mark the thread subscribed optimistically', async () => {
    await renderHook();

    act(() => {
      state.markThreadSubscribedOptimistically();
    });

    expect(state.threadSubscribed).toBe(true);
  });
});
