import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import { markMessagesAsRead, sendMessage, sendThreadMessage } from '@/api/messages';
import { useChatMessageSender } from './useChatMessageSender';

function response<T>(data: T): AxiosResponse<T> {
  return { data } as AxiosResponse<T>;
}

function message(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'server-1',
    clientGeneratedId: 'client-1',
    chatId: 'chat-1',
    replyRootId: null,
    message: 'hello',
    messageType: 'text',
    sender: { uid: 7, name: 'Me', gender: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
    attachments: [],
    ...overrides,
  };
}

const dispatch = vi.fn();
const setReplyingTo = vi.fn();
const setEditingSession = vi.fn();
const revealLatestAfterSend = vi.fn();
const markThreadSubscribedOptimistically = vi.fn();
const showToast = vi.fn();

vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
}));

vi.mock('@/api/messages', () => ({
  markMessagesAsRead: vi.fn(),
  sendMessage: vi.fn(),
  sendThreadMessage: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock('@/api/threads', () => ({
  markThreadAsRead: vi.fn(),
}));

vi.mock('@/api/upload', () => ({
  requestUploadUrl: vi.fn(),
  uploadFileToS3: vi.fn(),
}));

vi.mock('@/utils/badges', () => ({
  syncAppBadgeCount: vi.fn(),
}));

vi.mock('@/utils/heicMedia', () => ({
  getUploadMimeType: () => 'text/plain',
}));

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));

interface HookState {
  sender: ReturnType<typeof useChatMessageSender>;
}

function TestComponent({ onRender }: { onRender: (state: HookState) => void }) {
  const sender = useChatMessageSender({
    chatId: 'chat-1',
    storeChatId: 'chat-1',
    currentUserId: 7,
    currentUserName: 'Me',
    currentUserAvatarUrl: null,
    threadSubscribed: false,
    replyingTo: null,
    editingSession: null,
    messageLookup: new Map(),
    setReplyingTo,
    setEditingSession,
    revealLatestAfterSend,
    markThreadSubscribedOptimistically,
    showToast,
  });
  onRender({ sender });
  return null;
}

describe('useChatMessageSender', () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: HookState;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(sendMessage).mockResolvedValue(response(message({ id: 'server-1' })));
    vi.mocked(markMessagesAsRead).mockResolvedValue(response({ lastReadMessageId: 'server-1', unreadCount: 0 }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  async function renderHook() {
    await act(async () => {
      root.render(
        <TestComponent
          onRender={(nextState) => {
            state = nextState;
          }}
        />,
      );
      await Promise.resolve();
    });
  }

  it('dispatches optimistic and confirmed actions for a main-chat text send', async () => {
    await renderHook();

    await act(async () => {
      state.sender.handleSend({
        kind: 'text',
        text: 'hello',
        attachmentIds: [],
        existingAttachments: [],
        uploadedAttachments: [],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/messageAdded',
        payload: expect.objectContaining({
          chatId: 'chat-1',
          storeChatId: 'chat-1',
          origin: 'optimistic',
          scope: 'main',
          message: expect.objectContaining({
            message: 'hello',
            messageType: 'text',
            sender: { uid: 7, name: 'Me', avatarUrl: undefined, gender: 0 },
          }),
        }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        message: 'hello',
        messageType: 'text',
        clientGeneratedId: expect.any(String),
        attachmentIds: [],
      }),
    );
    expect(setReplyingTo).toHaveBeenCalledWith(null);
    expect(revealLatestAfterSend).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/messageConfirmed',
        payload: expect.objectContaining({
          chatId: 'chat-1',
          storeChatId: 'chat-1',
          origin: 'api_confirm',
          scope: 'main',
          message: expect.objectContaining({ id: 'server-1', message: 'hello' }),
        }),
      }),
    );
  });

  it('dispatches optimistic and confirmed actions for a thread text send', async () => {
    vi.mocked(sendThreadMessage).mockResolvedValue(response(message({ id: 'server-1', replyRootId: 'thread-1' })));

    // Create a test component with threadId
    function ThreadTestComponent({ onRender }: { onRender: (state: HookState) => void }) {
      const sender = useChatMessageSender({
        chatId: 'chat-1',
        storeChatId: 'chat-1_thread_thread-1',
        threadId: 'thread-1',
        currentUserId: 7,
        currentUserName: 'Me',
        currentUserAvatarUrl: null,
        threadSubscribed: true,
        replyingTo: null,
        editingSession: null,
        messageLookup: new Map(),
        setReplyingTo,
        setEditingSession,
        revealLatestAfterSend,
        markThreadSubscribedOptimistically,
        showToast,
      });
      onRender({ sender });
      return null;
    }

    await act(async () => {
      root.render(
        <ThreadTestComponent
          onRender={(nextState) => {
            state = nextState;
          }}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      state.sender.handleSend({
        kind: 'text',
        text: 'thread reply',
        attachmentIds: [],
        existingAttachments: [],
        uploadedAttachments: [],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Should use sendThreadMessage, not sendMessage
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendThreadMessage).toHaveBeenCalledWith(
      'chat-1',
      'thread-1',
      expect.objectContaining({
        message: 'thread reply',
        messageType: 'text',
      }),
    );

    // Should dispatch with scope: 'thread'
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'messages/messageAdded',
        payload: expect.objectContaining({
          scope: 'thread',
        }),
      }),
    );
  });

  it('auto-subscribes to thread when sending in an unsubscribed thread', async () => {
    vi.mocked(sendThreadMessage).mockResolvedValue(response(message({ id: 'server-1', replyRootId: 'thread-1' })));

    function UnsubscribedThreadTestComponent({ onRender }: { onRender: (state: HookState) => void }) {
      const sender = useChatMessageSender({
        chatId: 'chat-1',
        storeChatId: 'chat-1_thread_thread-1',
        threadId: 'thread-1',
        currentUserId: 7,
        currentUserName: 'Me',
        currentUserAvatarUrl: null,
        threadSubscribed: false, // Not subscribed
        replyingTo: null,
        editingSession: null,
        messageLookup: new Map(),
        setReplyingTo,
        setEditingSession,
        revealLatestAfterSend,
        markThreadSubscribedOptimistically,
        showToast,
      });
      onRender({ sender });
      return null;
    }

    await act(async () => {
      root.render(
        <UnsubscribedThreadTestComponent
          onRender={(nextState) => {
            state = nextState;
          }}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      state.sender.handleSend({
        kind: 'text',
        text: 'auto subscribe',
        attachmentIds: [],
        existingAttachments: [],
        uploadedAttachments: [],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Should call markThreadSubscribedOptimistically before sending
    expect(markThreadSubscribedOptimistically).toHaveBeenCalled();
    expect(sendThreadMessage).toHaveBeenCalled();
  });
});
