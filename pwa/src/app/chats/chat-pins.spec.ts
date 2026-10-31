import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { ServerWsMessageType, type PinResponse, type ServerWsMessage } from '../../generated/models';
import { Connection, ResyncReason } from '../api/connection';
import { RpcErrorCode } from '../api/rpc-error';
import { RpcTestPeer, provideRpcTesting } from '../api/rpc-testing';
import { decodeId, encodeId } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { mockRealtime, testChat, testMessage, testUser, wireMessage } from '../api/testing';
import type { ChatPins } from './chat-pins';
import { ChatStore } from './chat-store';

const threadId = encodeId('9007199254741005');
const otherChatId = encodeId('9007199254741020');
const pin: PinResponse = {
  id: encodeId('9007199254741010'),
  chatId: testChat.id,
  message: testMessage,
  pinnedBy: testUser.uid,
  pinnedAt: testMessage.createdAt,
};
const wirePin = { ...pin, id: decodeId(pin.id), chatId: decodeId(pin.chatId), message: wireMessage };

async function settle() {
  for (let step = 0; step < 8; step++) await Promise.resolve();
}

describe('ChatStore pins', () => {
  let conversation: ChatPins;
  let peer: RpcTestPeer;
  let scope: EnvironmentInjector;
  let events: Subject<ServerWsMessage>;
  let resync: Subject<ResyncReason | void>;
  const watch = vi.fn<Connection['watchConversationStates']>();

  beforeEach(() => {
    watch.mockReset();
    events = new Subject();
    resync = new Subject();
    TestBed.configureTestingModule({
      providers: [
        ...provideRpcTesting(),
        {
          provide: Connection,
          useValue: { ...mockRealtime({ events$: events, resync$: resync }), watchConversationStates: watch },
        },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    TestBed.inject(SessionStore).user.set(testUser);
    scope = createEnvironmentInjector([ChatStore], TestBed.inject(EnvironmentInjector));
    conversation = scope.get(ChatStore).pins(testChat.id);
  });

  afterEach(() => {
    try {
      scope.destroy();
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function added() {
    events.next({
      type: ServerWsMessageType.pinAdded,
      payload: { chatId: testChat.id, messageId: testMessage.id, pinId: pin.id, pin },
    });
  }

  function removed() {
    events.next({
      type: ServerWsMessageType.pinRemoved,
      payload: { chatId: testChat.id, messageId: testMessage.id, pinId: pin.id },
    });
  }

  async function loadPins(pins: (typeof wirePin)[] = []) {
    const loading = conversation.ensure();
    peer.expect('pins.list', { chatId: decodeId(testChat.id) }).flush({ pins: structuredClone(pins) });
    await loading;
  }

  it('deduplicates a create response with its WebSocket echo and unpins by pin ID', async () => {
    await loadPins();
    const creating = conversation.set(testMessage, true);
    await settle();
    const request = peer.expect('pins.create', { chatId: decodeId(testChat.id), messageId: decodeId(testMessage.id) });
    added();
    request.flush(structuredClone(wirePin));
    await creating;
    expect(conversation.items()).toEqual([pin]);
    peer.expectNone('pins.list');

    const deleting = conversation.set(testMessage, false);
    await settle();
    peer.expect('pins.delete', { chatId: decodeId(testChat.id), pinId: decodeId(pin.id) }).flush(null);
    await deleting;
    removed();
    expect(conversation.items()).toEqual([]);
  });

  it('keeps the confirmed pin intention when another user has already completed it', async () => {
    await loadPins([wirePin]);
    removed();
    await conversation.set(testMessage, false);
    expect(conversation.items()).toEqual([]);
    peer.expectNone('pins.delete');

    added();
    await conversation.set(testMessage, true);
    expect(conversation.items()).toEqual([pin]);
    peer.expectNone('pins.create');
  });

  it('does not restore a pin removed while its create response was still in flight', async () => {
    await loadPins();
    const creating = conversation.set(testMessage, true);
    await settle();
    const request = peer.expect('pins.create', { chatId: decodeId(testChat.id), messageId: decodeId(testMessage.id) });
    added();
    removed();
    request.flush(structuredClone(wirePin));
    await settle();
    expect(conversation.items()).toEqual([]);
    peer.expect('pins.list', { chatId: decodeId(testChat.id) }).flush({ pins: [] });
    await creating;
    expect(conversation.items()).toEqual([]);
  });

  it('keeps chat and thread pin scopes separate and applies all thread pin mutations', async () => {
    conversation = scope.get(ChatStore).pins(testChat.id, threadId);
    const threadParams = { chatId: decodeId(testChat.id), threadRootId: decodeId(threadId) };
    const loading = conversation.ensure();
    peer.expect('pins.listForThread', threadParams).flush({ pins: [] });
    await loading;
    added();
    events.next({
      type: ServerWsMessageType.threadPinAdded,
      payload: { chatId: otherChatId, threadRootId: threadId, messageId: testMessage.id, pinId: pin.id, pin },
    });
    expect(conversation.items()).toEqual([]);

    const creating = conversation.set(testMessage, true);
    await settle();
    peer.expect('pins.createForThread', { ...threadParams, messageId: decodeId(testMessage.id) }).flush({
      ...structuredClone(wirePin),
      threadRootId: decodeId(threadId),
    });
    await creating;
    expect(conversation.get(testMessage.id)?.threadRootId).toBe(threadId);
    const threadPin = { ...pin, threadRootId: threadId };
    events.next({
      type: ServerWsMessageType.threadPinAdded,
      payload: {
        chatId: testChat.id,
        threadRootId: threadId,
        messageId: testMessage.id,
        pinId: pin.id,
        pin: threadPin,
      },
    });
    expect(conversation.items()).toEqual([threadPin]);

    const deleting = conversation.set(testMessage, false);
    await settle();
    peer.expect('pins.deleteForThread', { ...threadParams, pinId: decodeId(pin.id) }).flush(null);
    await deleting;
    events.next({
      type: ServerWsMessageType.threadPinRemoved,
      payload: { chatId: testChat.id, threadRootId: threadId, messageId: testMessage.id, pinId: pin.id },
    });
    expect(conversation.items()).toEqual([]);
  });

  it('does not apply a pin mutation to the new context after navigation', async () => {
    await loadPins();
    const creating = conversation.set(testMessage, true);
    await settle();
    const request = peer.expect('pins.create', { chatId: decodeId(testChat.id), messageId: decodeId(testMessage.id) });
    conversation = scope.get(ChatStore).pins(otherChatId);
    request.flush(structuredClone(wirePin));
    await creating;
    expect(conversation.items()).toEqual([]);
    peer.expectNone('pins.list');
  });

  it('shares the pin lookup and refreshes after reconnect without dropping the displayed pins', async () => {
    const pending = conversation.ensure();
    expect(conversation.ensure()).toBe(pending);
    expect(conversation.loading()).toBe(true);
    peer.expect('pins.list', { chatId: decodeId(testChat.id) }).flush({ pins: [structuredClone(wirePin)] });
    await pending;
    expect(conversation.loading()).toBe(false);
    expect(conversation.get(testMessage.id)).toEqual(pin);
    await conversation.ensure();
    peer.expectNone('pins.list');

    resync.next(ResyncReason.Foreground);
    await conversation.ensure();
    peer.expectNone('pins.list');
    expect(conversation.items()).toEqual([pin]);

    resync.next(ResyncReason.Connected);
    peer.expect('users.getNotificationSettings').flush(testUser);
    expect(conversation.items()).toEqual([pin]);
    await loadPins();
    expect(conversation.items()).toEqual([]);
  });

  it('revalidates a pin list when a WebSocket event arrives during its request', async () => {
    const pending = conversation.ensure();
    const stale = peer.expect('pins.list', { chatId: decodeId(testChat.id) });
    added();
    stale.flush({ pins: [] });
    await settle();
    expect(conversation.items()).toEqual([pin]);
    peer.expect('pins.list', { chatId: decodeId(testChat.id) }).flush({ pins: [structuredClone(wirePin)] });
    await pending;
    expect(conversation.items()).toEqual([pin]);
  });

  it('does not let an earlier context reply replace or clear the new context loading state', async () => {
    const previous = conversation.ensure();
    const stale = peer.expect('pins.list', { chatId: decodeId(testChat.id) });
    conversation = scope.get(ChatStore).pins(otherChatId);
    const current = conversation.ensure();
    const next = peer.expect('pins.list', { chatId: decodeId(otherChatId) });
    stale.flush({ pins: [structuredClone(wirePin)] });
    await previous;
    expect(conversation.loading()).toBe(true);
    expect(conversation.items()).toEqual([]);
    next.flush({ pins: [] });
    await current;
    expect(conversation.loading()).toBe(false);
  });

  it('shares loaded pins across page owners without a timeline or a second request', async () => {
    const shared = scope.get(ChatStore).pins(testChat.id);
    expect(shared).toBe(conversation);
    await loadPins([wirePin]);
    await shared.ensure();
    expect(shared.items()).toEqual([pin]);
    peer.expectNone('pins.list');
  });

  it('recovers from pin lookup failure and ignores a real late retry reply after destruction', async () => {
    const pending = conversation.ensure();
    const failure = expect(pending).rejects.toBeDefined();
    peer.expect('pins.list', { chatId: decodeId(testChat.id) }).error(RpcErrorCode.Unavailable);
    await failure;
    expect(conversation.loading()).toBe(false);
    const retry = conversation.ensure();
    const cancelled = expect(retry).rejects.toBeDefined();
    const request = peer.expect('pins.list', { chatId: decodeId(testChat.id) });
    scope.destroy();
    request.flush({ pins: [structuredClone(wirePin)] });
    await cancelled;
    scope = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
  });
  it('clears revoked pin scopes and fences held replies and events without affecting other scopes', async () => {
    const store = scope.get(ChatStore);
    const thread = store.pins(testChat.id, threadId);
    const other = store.pins(otherChatId);
    store.watchReadStates([{ chatId: testChat.id }, { chatId: testChat.id, threadId }]);
    TestBed.tick();
    const publish = (accessible: boolean, scopeThreadId?: typeof threadId, full = false) =>
      events.next({
        type: ServerWsMessageType.conversationStates,
        payload: {
          requestId: watch.mock.calls.at(-1)![0],
          full,
          states: [
            {
              chatId: testChat.id,
              threadId: scopeThreadId,
              accessible,
              unreadCount: 0,
              unreadMentions: 0,
              unreadReactions: 0,
            },
          ],
        },
      });
    publish(true, threadId, true);
    await loadPins([wirePin]);
    const threadLoading = thread.ensure();
    const held = peer.expect('pins.listForThread', { chatId: decodeId(testChat.id), threadRootId: decodeId(threadId) });
    const otherLoading = other.ensure();
    peer.expect('pins.list', { chatId: decodeId(otherChatId) }).flush({ pins: [structuredClone(wirePin)] });
    await otherLoading;
    publish(false, threadId);
    held.flush({ pins: [structuredClone(wirePin)] });
    await threadLoading;
    events.next({
      type: ServerWsMessageType.threadPinAdded,
      payload: { chatId: testChat.id, threadRootId: threadId, messageId: testMessage.id, pinId: pin.id, pin },
    });
    expect(thread.items()).toEqual([]);
    expect(conversation.items()).toEqual([pin]);
    expect(other.items()).toEqual([pin]);
    conversation.invalidate();
    const oldLoading = conversation.ensure();
    const oldPins = peer.expect('pins.list', { chatId: decodeId(testChat.id) });
    publish(false);
    expect(conversation.items()).toEqual([]);
    expect(other.items()).toEqual([pin]);
    added();
    expect(conversation.items()).toEqual([]);
    publish(true);
    oldPins.flush({ pins: [structuredClone(wirePin)] });
    await oldLoading;
    expect(conversation.items()).toEqual([]);
    const refreshed = conversation.ensure();
    peer.expect('pins.list', { chatId: decodeId(testChat.id) }).flush({ pins: [structuredClone(wirePin)] });
    await refreshed;
    expect(conversation.items()).toEqual([pin]);
  });

  it('applies remote changes to pinned messages while retaining personal reaction state', async () => {
    await loadPins([
      {
        ...wirePin,
        message: { ...structuredClone(wireMessage), reactions: [{ emoji: '👍', count: 1, reactedByMe: true }] },
      },
    ]);
    events.next({
      type: ServerWsMessageType.reactionUpdated,
      payload: { chatId: testChat.id, messageId: testMessage.id, reactions: [{ emoji: '👍', count: 2 }] },
    });
    expect(conversation.get(testMessage.id)?.message.reactions[0]).toMatchObject({ count: 2, reactedByMe: true });
    events.next({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, message: '更新后的置顶内容', reactions: [{ emoji: '👍', count: 2 }] },
    });
    expect(conversation.get(testMessage.id)?.message.message).toBe('更新后的置顶内容');
    expect(conversation.get(testMessage.id)?.message.reactions[0].reactedByMe).toBe(true);
    events.next({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: testChat.id, messageIds: [testMessage.id] },
    });
    expect(conversation.get(testMessage.id)?.message).toMatchObject({
      isDeleted: true,
      message: undefined,
      attachments: [],
      mentions: [],
      sticker: undefined,
    });
  });
});
