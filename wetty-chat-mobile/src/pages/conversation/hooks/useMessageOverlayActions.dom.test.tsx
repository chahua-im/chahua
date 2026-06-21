import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import type { PinResponse } from '@/api/pins';
import { deleteMessage } from '@/api/messages';
import { createPin, deletePin } from '@/api/pins';
import { favoriteSticker } from '@/api/stickers';
import { saveMessage } from '@/api/savedMessages';
import { useMessageOverlayActions } from './useMessageOverlayActions';

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string | { message?: string }) => {
    if (typeof strings === 'string') return strings;
    if ('message' in strings) return strings.message ?? '';
    return (strings as TemplateStringsArray).join('');
  },
}));

vi.mock('@/api/messages', () => ({
  deleteMessage: vi.fn(),
}));

vi.mock('@/api/pins', () => ({
  createPin: vi.fn(),
  deletePin: vi.fn(),
}));

vi.mock('@/api/stickers', () => ({
  favoriteSticker: vi.fn(),
}));

vi.mock('@/api/savedMessages', () => ({
  saveMessage: vi.fn(),
}));

const dispatch = vi.fn();
vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
}));

function message(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'message-1',
    clientGeneratedId: 'client-message-1',
    chatId: 'chat-1',
    replyRootId: null,
    message: 'hello',
    messageType: 'text',
    sender: { uid: 2, name: 'User', gender: 0 },
    createdAt: new Date(0).toISOString(),
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
    ...overrides,
  };
}

function pinFor(nextMessage: MessageResponse): PinResponse {
  return {
    id: 'pin-1',
    chatId: 'chat-1',
    message: nextMessage,
    pinnedBy: 1,
    pinnedAt: new Date(0).toISOString(),
    expiresAt: null,
  };
}

interface HookState {
  actions: ReturnType<typeof useMessageOverlayActions>;
}

type MockFn<T extends (...args: any[]) => unknown> = ReturnType<typeof vi.fn> & T;

function TestComponent({
  message: overlayMessage,
  pins,
  onRender,
  presentAlert,
  showToast,
  onReply,
  onStartThread,
  onEdit,
  onOpenReactionDetails,
}: {
  message: MessageResponse | null;
  pins: PinResponse[];
  onRender: (state: HookState) => void;
  presentAlert: (options: any) => void;
  showToast: (message: string, duration?: number) => void;
  onReply: (message: MessageResponse) => void;
  onStartThread: (messageId: string) => void;
  onEdit: (message: MessageResponse) => void;
  onOpenReactionDetails: (messageId: string) => void;
}) {
  const actions = useMessageOverlayActions({
    chatId: 'chat-1',
    message: overlayMessage,
    currentUserId: 2,
    isAdmin: true,
    threadId: undefined,
    pins,
    savedMessagesEnabled: true,
    presentAlert,
    showToast,
    onReply,
    onStartThread,
    onEdit,
    onOpenReactionDetails,
  });
  onRender({ actions });
  return null;
}

describe('useMessageOverlayActions', () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: HookState;
  let presentAlert: MockFn<(options: any) => void>;
  let showToast: MockFn<(message: string, duration?: number) => void>;
  let onReply: MockFn<(message: MessageResponse) => void>;
  let onStartThread: MockFn<(messageId: string) => void>;
  let onEdit: MockFn<(message: MessageResponse) => void>;
  let onOpenReactionDetails: MockFn<(messageId: string) => void>;

  function renderHook(nextMessage: MessageResponse | null, pins: PinResponse[] = []) {
    act(() => {
      root.render(
        <TestComponent
          message={nextMessage}
          pins={pins}
          presentAlert={presentAlert}
          showToast={showToast}
          onReply={onReply}
          onStartThread={onStartThread}
          onEdit={onEdit}
          onOpenReactionDetails={onOpenReactionDetails}
          onRender={(nextState) => (state = nextState)}
        />,
      );
    });
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    presentAlert = vi.fn() as typeof presentAlert;
    showToast = vi.fn() as typeof showToast;
    onReply = vi.fn() as typeof onReply;
    onStartThread = vi.fn() as typeof onStartThread;
    onEdit = vi.fn() as typeof onEdit;
    onOpenReactionDetails = vi.fn() as typeof onOpenReactionDetails;
    vi.mocked(createPin).mockResolvedValue(response(pinFor(message())));
    vi.mocked(deletePin).mockResolvedValue(response(undefined));
    vi.mocked(deleteMessage).mockResolvedValue(response(undefined));
    vi.mocked(favoriteSticker).mockResolvedValue(response(undefined));
    vi.mocked(saveMessage).mockResolvedValue(response({} as any));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('builds the current admin-owned text action order', () => {
    renderHook(message());

    expect(state.actions.map((action) => action.key)).toEqual([
      'reply',
      'thread',
      'pin',
      'copy',
      'edit',
      'save',
      'copy-link',
      'delete',
    ]);
  });

  it('binds copy, reply, thread, edit, and reaction detail commands', () => {
    renderHook(message({ reactions: [{ emoji: '👍', count: 1, reactedByMe: true }] }));

    state.actions.find((action) => action.key === 'copy')?.handler();
    state.actions.find((action) => action.key === 'reply')?.handler();
    state.actions.find((action) => action.key === 'thread')?.handler();
    state.actions.find((action) => action.key === 'edit')?.handler();
    state.actions.find((action) => action.key === 'reaction-details')?.handler();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1' }));
    expect(onStartThread).toHaveBeenCalledWith('message-1');
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1' }));
    expect(onOpenReactionDetails).toHaveBeenCalledWith('message-1');
  });

  it('optimistically patches delete and rolls back on API failure', async () => {
    const nextMessage = message();
    vi.mocked(deleteMessage).mockRejectedValueOnce(new Error('nope'));
    renderHook(nextMessage);

    state.actions.find((action) => action.key === 'delete')?.handler();
    const alert = presentAlert.mock.calls[0][0] as { buttons: { text: string; handler?: () => void }[] };
    await act(async () => {
      alert.buttons[1].handler?.();
      await Promise.resolve();
    });

    expect(deleteMessage).toHaveBeenCalledWith('chat-1', 'message-1');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/messagePatched',
        payload: { chatId: 'chat-1', messageId: 'message-1', message: { ...nextMessage, isDeleted: true } },
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/messagePatched',
        payload: { chatId: 'chat-1', messageId: 'message-1', message: nextMessage },
      }),
    );
    expect(showToast).toHaveBeenCalledWith('nope');
  });

  it('binds pin and unpin alert commands', async () => {
    const nextMessage = message();
    renderHook(nextMessage);

    state.actions.find((action) => action.key === 'pin')?.handler();
    let alert = presentAlert.mock.calls[0][0] as { buttons: { text: string; handler?: () => void }[] };
    await act(async () => {
      alert.buttons[1].handler?.();
      await Promise.resolve();
    });
    expect(createPin).toHaveBeenCalledWith('chat-1', 'message-1');

    renderHook(nextMessage, [pinFor(nextMessage)]);
    state.actions.find((action) => action.key === 'pin')?.handler();
    alert = presentAlert.mock.calls[1][0] as { buttons: { text: string; handler?: () => void }[] };
    await act(async () => {
      alert.buttons[1].handler?.();
      await Promise.resolve();
    });
    expect(deletePin).toHaveBeenCalledWith('chat-1', 'pin-1');
  });

  it('binds save and favorite commands with success toasts', async () => {
    renderHook(message());
    await act(async () => {
      state.actions.find((action) => action.key === 'save')?.handler();
      await Promise.resolve();
    });
    expect(saveMessage).toHaveBeenCalledWith('message-1');
    expect(showToast).toHaveBeenCalledWith('Message saved', 2000);

    renderHook(
      message({
        messageType: 'sticker',
        sticker: {
          id: 'sticker-1',
          emoji: '👍',
          media: { id: 'media-1', url: '', contentType: 'image/png', size: 1 },
          createdAt: new Date(0).toISOString(),
          isFavorited: false,
        },
      }),
    );
    await act(async () => {
      state.actions.find((action) => action.key === 'favorite')?.handler();
      await Promise.resolve();
    });
    expect(favoriteSticker).toHaveBeenCalledWith('sticker-1');
    expect(showToast).toHaveBeenCalledWith('Sticker added to favorites', 2000);
  });
});
