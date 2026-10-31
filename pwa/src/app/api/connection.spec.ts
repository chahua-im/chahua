import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { ServerWsMessageType } from '../../generated/models';
import { RpcTestPeer, provideRpcTesting } from './rpc-testing';
import { Connection, ResyncReason } from './connection';
import { testChat, testMessage, wireChat, wireMessage } from './testing';

describe('Connection', () => {
  let peer: RpcTestPeer;
  let connection: Connection;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideChahuaBaseUrl('/_api'), provideRpcTesting()],
    });
    peer = TestBed.inject(RpcTestPeer);
    connection = TestBed.inject(Connection);
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('translates decoded RPC notifications and acknowledges typed watch scopes', () => {
    const messages = vi.fn();
    const events = vi.fn();
    const resync = vi.fn();
    connection.messages$.subscribe(messages);
    connection.events$.subscribe(events);
    connection.resync$.subscribe(resync);

    peer.authenticate();
    expect(connection.connected()).toBe(true);
    expect(resync).toHaveBeenCalledWith(ResyncReason.Connected);

    connection.watchPresence(7, [2], [testChat.id]);
    peer.expect('presence.watch', { requestId: 7, userIds: [2], chatIds: [wireChat.id] }).flush(null);
    connection.watchConversationUnread(
      8,
      [
        {
          key: 'custom',
          selector: {
            include: [{ chatId: testChat.id, threadId: testMessage.id }],
            exclude: [{ chatId: testChat.id }],
          },
        },
      ],
      true,
    );
    peer
      .expect('conversations.watchUnread', {
        requestId: 8,
        appBadge: true,
        views: [
          {
            key: 'custom',
            selector: {
              include: [{ chatId: wireChat.id, threadId: wireMessage.id }],
              exclude: [{ chatId: wireChat.id }],
            },
          },
        ],
      })
      .flush(null);
    connection.watchConversationStates(9, [{ chatId: testChat.id, threadId: testMessage.id }]);
    peer
      .expect('conversations.watchStates', {
        requestId: 9,
        conversations: [{ chatId: wireChat.id, threadId: wireMessage.id }],
      })
      .flush(null);

    peer.notify('events.conversationStates', {
      requestId: 9,
      full: true,
      states: [
        {
          chatId: wireChat.id,
          threadId: wireMessage.id,
          lastReadMessageId: wireMessage.id,
          accessible: true,
          unreadCount: 0,
          unreadMentions: 0,
          unreadReactions: 0,
        },
      ],
    });
    peer.notify('events.message', wireMessage);
    peer.notify('events.messagesBulkDeleted', { chatId: wireChat.id, messageIds: [wireMessage.id] });
    peer.notify('events.chatMembershipChanged', { chatId: wireChat.id });
    peer.notify('events.chatArchiveStateChanged', { chatId: wireChat.id, archived: false, mutedUntil: null });
    peer.notify('events.unknown', { ignored: true });

    expect(events).toHaveBeenNthCalledWith(1, {
      type: ServerWsMessageType.conversationStates,
      payload: expect.objectContaining({
        states: [
          expect.objectContaining({
            chatId: testChat.id,
            threadId: testMessage.id,
            lastReadMessageId: testMessage.id,
          }),
        ],
      }),
    });
    expect(messages).toHaveBeenCalledWith(testMessage);
    expect(events).toHaveBeenNthCalledWith(3, {
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: testChat.id, messageIds: [testMessage.id] },
    });
    expect(events).toHaveBeenNthCalledWith(4, {
      type: ServerWsMessageType.chatMembershipChanged,
      payload: { chatId: testChat.id },
    });
    expect(events).toHaveBeenLastCalledWith({
      type: ServerWsMessageType.chatArchiveStateChanged,
      payload: { chatId: testChat.id, archived: false, mutedUntil: null },
    });
  });

  it('deduplicates accepted message confirmations but preserves distinct message changes', () => {
    const messages = vi.fn();
    const changes = vi.fn();
    connection.messages$.subscribe(messages);
    connection.changes$.subscribe(changes);

    connection.accept(testMessage);
    connection.accept(testMessage);
    connection.acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, message: 'edited' },
    });
    connection.acceptChange({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });

    expect(messages).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('delivers distinct edited and deleted notifications after the original message echo is deduplicated', () => {
    const messages = vi.fn();
    const changes = vi.fn();
    connection.messages$.subscribe(messages);
    connection.changes$.subscribe(changes);

    peer.authenticate();
    connection.accept(testMessage);
    peer.notify('events.message', wireMessage);
    peer.notify('events.messageUpdated', { ...wireMessage, message: 'edited' });
    peer.notify('events.messageDeleted', { ...wireMessage, isDeleted: true });

    expect(messages).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenNthCalledWith(1, {
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, message: 'edited' },
    });
    expect(changes).toHaveBeenNthCalledWith(2, {
      type: ServerWsMessageType.messageDeleted,
      payload: { ...testMessage, isDeleted: true },
    });
  });

  it('emits Foreground resync only while the transport is authenticated', () => {
    vi.useFakeTimers();
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    const resync = vi.fn();
    connection.resync$.subscribe(resync);

    peer.authenticate();
    resync.mockClear();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(resync).toHaveBeenCalledWith(ResyncReason.Foreground);

    peer.disconnect();
    resync.mockClear();
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(resync).not.toHaveBeenCalled();
  });
  it('emits one Connected resync for each authenticated bind and resets message deduplication on account change', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const resync = vi.fn();
    const messages = vi.fn();
    connection.resync$.subscribe(resync);
    connection.messages$.subscribe(messages);

    peer.authenticate();
    connection.reset();
    connection.accept(testMessage);
    connection.reset();
    connection.accept(testMessage);
    expect(messages).toHaveBeenCalledTimes(2);

    peer.disconnect();
    vi.advanceTimersByTime(1_000);
    peer.open();
    peer.expect('session.open').flush({
      protocolVersion: 1,
      authenticated: true,
      uid: 1,
      clientId: 'fixture-client',
    });

    expect(resync).toHaveBeenCalledTimes(2);
  });
});
