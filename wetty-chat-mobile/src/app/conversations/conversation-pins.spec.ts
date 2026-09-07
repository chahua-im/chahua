import { ConversationStore } from './conversation-store';
import { mockRealtime } from '../api/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { ServerWsMessageType } from '../../generated/models';
import type { PinResponse, ServerWsMessage } from '../../generated/models';
import { jsonInterceptor } from '../api/json.interceptor';
import { testChat, testMessage, testUser, wireMessage } from '../api/testing';
import { Connection } from '../api/connection';
import { decodeId, encodeId } from '../api/snowflake-id';

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

describe('ConversationStore pins', () => {
  let conversation: ConversationStore;

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
    scope = createEnvironmentInjector([ConversationStore], TestBed.inject(EnvironmentInjector));
    conversation = scope.get(ConversationStore);
    http = TestBed.inject(HttpTestingController);
    conversation.reset(testChat.id);
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
    const loading = conversation.ensurePins();
    http.expectOne(`${chatUrl}/pins`).flush({ pins: structuredClone(pins) });
    await loading;
  }

  it('deduplicates a create response with its WebSocket echo and unpins by pin ID', async () => {
    await loadPins();
    const creating = conversation.setPinned(testMessage, true);
    await settle();
    const request = http.expectOne(`${chatUrl}/pins`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ messageId: decodeId(testMessage.id) });
    added();
    request.flush(structuredClone(wirePin));
    await creating;
    expect(conversation.pins()).toEqual([pin]);
    http.expectNone(() => true);

    const deleting = conversation.setPinned(testMessage, false);
    await settle();
    const deletion = http.expectOne(`${chatUrl}/pins/${decodeId(pin.id)}`);
    expect(deletion.request.method).toBe('DELETE');
    deletion.flush(null);
    await deleting;
    removed();
    expect(conversation.pins()).toEqual([]);
  });

  it('keeps the confirmed pin intention when another user has already completed it', async () => {
    await loadPins([wirePin]);
    removed();
    await conversation.setPinned(testMessage, false);
    expect(conversation.pins()).toEqual([]);
    http.expectNone(() => true);

    added();
    await conversation.setPinned(testMessage, true);
    expect(conversation.pins()).toEqual([pin]);
    http.expectNone(() => true);
  });

  it('does not restore a pin removed while its create response was still in flight', async () => {
    await loadPins();
    const creating = conversation.setPinned(testMessage, true);
    await settle();
    const request = http.expectOne(`${chatUrl}/pins`);
    added();
    removed();
    request.flush(structuredClone(wirePin));
    await settle();
    expect(conversation.pins()).toEqual([]);
    http.expectOne(`${chatUrl}/pins`).flush({ pins: [] });
    await creating;
    expect(conversation.pins()).toEqual([]);
  });

  it('keeps chat and thread pin scopes separate and applies all thread pin mutations', async () => {
    conversation.reset(testChat.id, threadId);
    const threadUrl = `${chatUrl}/threads/${decodeId(threadId)}/pins`;
    const loading = conversation.ensurePins();
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
    expect(conversation.pins()).toEqual([]);

    const creating = conversation.setPinned(testMessage, true);
    await settle();
    const created = http.expectOne(threadUrl);
    expect(created.request.method).toBe('POST');
    created.flush({ ...structuredClone(wirePin), threadRootId: decodeId(threadId) });
    await creating;
    expect(conversation.pinFor(testMessage.id)?.threadRootId).toBe(threadId);
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
    expect(conversation.pins()).toEqual([threadPin]);

    const deleting = conversation.setPinned(testMessage, false);
    await settle();
    const deleted = http.expectOne(`${threadUrl}/${decodeId(pin.id)}`);
    expect(deleted.request.method).toBe('DELETE');
    deleted.flush(null);
    await deleting;
    events.next({
      type: ServerWsMessageType.threadPinRemoved,
      payload: { chatId: testChat.id, threadRootId: threadId, messageId: testMessage.id, pinId: pin.id },
    });
    expect(conversation.pins()).toEqual([]);
  });

  it('does not apply a pin mutation to the new context after navigation', async () => {
    await loadPins();
    const creating = conversation.setPinned(testMessage, true);
    await settle();
    const request = http.expectOne(`${chatUrl}/pins`);
    conversation.reset(otherChatId);
    request.flush(structuredClone(wirePin));
    await creating;
    expect(conversation.pins()).toEqual([]);
    http.expectNone(() => true);
  });

  it('shares the pin lookup and refreshes after reconnect without dropping the displayed pins', async () => {
    const pending = conversation.ensurePins();
    expect(conversation.ensurePins()).toBe(pending);
    expect(conversation.pinsLoading()).toBe(true);
    http.expectOne(`${chatUrl}/pins`).flush({ pins: [structuredClone(wirePin)] });
    await pending;
    expect(conversation.pinsLoading()).toBe(false);
    expect(conversation.pinFor(testMessage.id)).toEqual(pin);
    await conversation.ensurePins();
    http.expectNone(() => true);

    resync.next();
    expect(conversation.pins()).toEqual([pin]);
    await loadPins();
    expect(conversation.pins()).toEqual([]);
  });

  it('revalidates a pin list when a WebSocket event arrives during its request', async () => {
    const pending = conversation.ensurePins();
    const stale = http.expectOne(`${chatUrl}/pins`);
    added();
    stale.flush({ pins: [] });
    await settle();
    expect(conversation.pins()).toEqual([pin]);
    http.expectOne(`${chatUrl}/pins`).flush({ pins: [structuredClone(wirePin)] });
    await pending;
    expect(conversation.pins()).toEqual([pin]);
  });

  it('does not let an earlier context request replace or clear the new context loading state', async () => {
    const previous = conversation.ensurePins();
    const stale = http.expectOne(`${chatUrl}/pins`);
    conversation.reset(otherChatId);
    const current = conversation.ensurePins();
    const next = http.expectOne(`/_api/chats/${decodeId(otherChatId)}/pins`);
    expect(stale.cancelled).toBe(true);
    await previous;
    expect(conversation.pinsLoading()).toBe(true);
    expect(conversation.pins()).toEqual([]);
    next.flush({ pins: [] });
    await current;
    expect(conversation.pinsLoading()).toBe(false);
  });

  it('clears the context on leave and ignores its pending response and later WebSocket events', async () => {
    const pending = conversation.ensurePins();
    const request = http.expectOne(`${chatUrl}/pins`);
    conversation.reset();
    expect(conversation.pinsLoading()).toBe(false);
    added();
    expect(request.cancelled).toBe(true);
    await pending;
    await conversation.ensurePins();
    expect(conversation.pins()).toEqual([]);
    http.expectNone(() => true);
  });

  it('recovers from pin lookup failure and cancels a pending retry when destroyed', async () => {
    const pending = conversation.ensurePins();
    const failure = expect(pending).rejects.toBeDefined();
    http.expectOne(`${chatUrl}/pins`).flush('', { status: 503, statusText: 'Unavailable' });
    await failure;
    expect(conversation.pinsLoading()).toBe(false);
    const retry = conversation.ensurePins();
    const cancelled = expect(retry).resolves.toBeUndefined();
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
    expect(conversation.pinFor(testMessage.id)?.message.reactions[0]).toMatchObject({ count: 2, reactedByMe: true });
    events.next({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, message: '更新后的置顶内容', reactions: [{ emoji: '👍', count: 2 }] },
    });
    expect(conversation.pinFor(testMessage.id)?.message.message).toBe('更新后的置顶内容');
    expect(conversation.pinFor(testMessage.id)?.message.reactions[0].reactedByMe).toBe(true);
    events.next({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: testChat.id, messageIds: [testMessage.id] },
    });
    expect(conversation.pinFor(testMessage.id)?.message.isDeleted).toBe(true);
  });
});
