import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import type { PinResponse, ServerWsMessage } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireMessage } from '../api/testing';
import type { ChatPins } from './chat-pins';
import { ChatStore } from './chat-store';

const chatUrl = `/_api/chats/${decodeId(testChat.id)}`;
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

  let http: HttpTestingController;

  let scope: EnvironmentInjector;

  let events: Subject<ServerWsMessage>;

  let resync: Subject<void>;

  beforeEach(() => {
    events = new Subject();
    resync = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ events$: events, resync$: resync }) },
      ],
    });
    scope = createEnvironmentInjector([ChatStore], TestBed.inject(EnvironmentInjector));
    http = TestBed.inject(HttpTestingController);
    conversation = scope.get(ChatStore).pins(testChat.id);
  });

  afterEach(() => {
    scope.destroy();
    http.verify();
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
    http.expectOne(`${chatUrl}/pins`).flush({ pins: structuredClone(pins) });
    await loading;
  }

  it('deduplicates a create response with its WebSocket echo and unpins by pin ID', async () => {
    await loadPins();
    const creating = conversation.set(testMessage, true);
    await settle();
    const request = http.expectOne(`${chatUrl}/pins`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ messageId: decodeId(testMessage.id) });
    added();
    request.flush(structuredClone(wirePin));
    await creating;
    expect(conversation.items()).toEqual([pin]);
    http.expectNone(() => true);

    const deleting = conversation.set(testMessage, false);
    await settle();
    const deletion = http.expectOne(`${chatUrl}/pins/${decodeId(pin.id)}`);
    expect(deletion.request.method).toBe('DELETE');
    deletion.flush(null);
    await deleting;
    removed();
    expect(conversation.items()).toEqual([]);
  });

  it('keeps the confirmed pin intention when another user has already completed it', async () => {
    await loadPins([wirePin]);
    removed();
    await conversation.set(testMessage, false);
    expect(conversation.items()).toEqual([]);
    http.expectNone(() => true);

    added();
    await conversation.set(testMessage, true);
    expect(conversation.items()).toEqual([pin]);
    http.expectNone(() => true);
  });

  it('does not restore a pin removed while its create response was still in flight', async () => {
    await loadPins();
    const creating = conversation.set(testMessage, true);
    await settle();
    const request = http.expectOne(`${chatUrl}/pins`);
    added();
    removed();
    request.flush(structuredClone(wirePin));
    await settle();
    expect(conversation.items()).toEqual([]);
    http.expectOne(`${chatUrl}/pins`).flush({ pins: [] });
    await creating;
    expect(conversation.items()).toEqual([]);
  });

  it('keeps chat and thread pin scopes separate and applies all thread pin mutations', async () => {
    conversation = scope.get(ChatStore).pins(testChat.id, threadId);
    const threadUrl = `${chatUrl}/threads/${decodeId(threadId)}/pins`;
    const loading = conversation.ensure();
    http.expectOne(threadUrl).flush({ pins: [] });
    await loading;
    added();
    events.next({
      type: ServerWsMessageType.threadPinAdded,
      payload: {
        chatId: otherChatId,
        threadRootId: threadId,
        messageId: testMessage.id,
        pinId: pin.id,
        pin,
      },
    });
    expect(conversation.items()).toEqual([]);

    const creating = conversation.set(testMessage, true);
    await settle();
    const created = http.expectOne(threadUrl);
    expect(created.request.method).toBe('POST');
    created.flush({ ...structuredClone(wirePin), threadRootId: decodeId(threadId) });
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
    const deleted = http.expectOne(`${threadUrl}/${decodeId(pin.id)}`);
    expect(deleted.request.method).toBe('DELETE');
    deleted.flush(null);
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
    const request = http.expectOne(`${chatUrl}/pins`);
    conversation = scope.get(ChatStore).pins(otherChatId);
    request.flush(structuredClone(wirePin));
    await creating;
    expect(conversation.items()).toEqual([]);
    http.expectNone(() => true);
  });

  it('shares the pin lookup and refreshes after reconnect without dropping the displayed pins', async () => {
    const pending = conversation.ensure();
    expect(conversation.ensure()).toBe(pending);
    expect(conversation.loading()).toBe(true);
    http.expectOne(`${chatUrl}/pins`).flush({ pins: [structuredClone(wirePin)] });
    await pending;
    expect(conversation.loading()).toBe(false);
    expect(conversation.get(testMessage.id)).toEqual(pin);
    await conversation.ensure();
    http.expectNone(() => true);

    resync.next();
    expect(conversation.items()).toEqual([pin]);
    await loadPins();
    expect(conversation.items()).toEqual([]);
  });

  it('revalidates a pin list when a WebSocket event arrives during its request', async () => {
    const pending = conversation.ensure();
    const stale = http.expectOne(`${chatUrl}/pins`);
    added();
    stale.flush({ pins: [] });
    await settle();
    expect(conversation.items()).toEqual([pin]);
    http.expectOne(`${chatUrl}/pins`).flush({ pins: [structuredClone(wirePin)] });
    await pending;
    expect(conversation.items()).toEqual([pin]);
  });

  it('does not let an earlier context request replace or clear the new context loading state', async () => {
    const previous = conversation.ensure();
    const stale = http.expectOne(`${chatUrl}/pins`);
    conversation = scope.get(ChatStore).pins(otherChatId);
    const current = conversation.ensure();
    const next = http.expectOne(`/_api/chats/${decodeId(otherChatId)}/pins`);
    expect(stale.cancelled).toBe(false);
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
    http.expectNone(() => true);
  });

  it('recovers from pin lookup failure and cancels a pending retry when destroyed', async () => {
    const pending = conversation.ensure();
    const failure = expect(pending).rejects.toBeDefined();
    http.expectOne(`${chatUrl}/pins`).flush('', { status: 503, statusText: 'Unavailable' });
    await failure;
    expect(conversation.loading()).toBe(false);
    const retry = conversation.ensure();
    const cancelled = expect(retry).rejects.toBeDefined();
    const request = http.expectOne(`${chatUrl}/pins`);
    scope.destroy();
    expect(request.cancelled).toBe(true);
    await cancelled;
    scope = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
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
    expect(conversation.get(testMessage.id)?.message.isDeleted).toBe(true);
  });
});
