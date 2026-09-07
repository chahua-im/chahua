import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { GroupKind, ServerWsMessageType, type MessageResponse } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, wireChat, wireMessage } from '../api/testing';
import { ChatListError, ChatListStore, type ChatQuery } from './chat-list-store';
import { ChatStore } from './chat-store';

describe('ChatListStore', () => {
  let data: ChatListStore;
  let query: ChatQuery;
  let releaseQuery: () => void;
  let messages: Connection;
  let http: HttpTestingController;
  let incoming: Subject<MessageResponse>;
  let resync: Subject<void>;
  beforeEach(() => {
    incoming = new Subject<MessageResponse>();
    resync = new Subject<void>();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        {
          provide: Connection,
          useValue: mockRealtime({ messages$: incoming, resync$: resync, events$: new Subject() }),
        },
      ],
    });
    data = TestBed.inject(ChatListStore);
    query = data.chats(false);
    releaseQuery = query.activate();
    messages = TestBed.inject(Connection);
    http = TestBed.inject(HttpTestingController);
    TestBed.tick();
  });
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  function selectQuery(archived: boolean) {
    releaseQuery();
    query = data.chats(archived);
    releaseQuery = query.activate();
  }

  async function settle() {
    for (let step = 0; step < 12; step++) await Promise.resolve();
    TestBed.tick();
  }

  it('loads archives separately and excludes topic messages from main chat previews', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    incoming.next({ ...testMessage, replyRootId: encodeId('100') });
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
    expect(query.items()[0].lastMessage).toBeUndefined();
    selectQuery(true);
    TestBed.tick();
    http
      .expectOne('/_api/chats?limit=50&archived=true')
      .flush(structuredClone({ chats: [{ ...wireChat, archived: true }] }));
    await settle();
    TestBed.tick();
    expect(query.items()[0].archived).toBe(true);
    const restoring = data['chatInfo'].setArchived(testChat.id, false);
    const action = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/archive`);
    expect(action.request.method).toBe('DELETE');
    action.flush(null);
    await restoring;
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50&archived=true').flush({ chats: [] });
    await settle();
    TestBed.tick();
    expect(query.items()).toEqual([]);
  });

  it('reconciles archive changes missed while disconnected without retaining an old local override', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    const archiving = data['chatInfo'].setArchived(testChat.id, true);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/archive`).flush(null);
    await archiving;
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    await settle();
    TestBed.tick();
    resync.next();
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    expect(query.items()).toEqual([testChat]);
    resync.next();
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    await settle();
    TestBed.tick();
    expect(query.items()).toEqual([]);
  });

  it('loads response models, filters them, and follows the conversation cursor', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [wireChat], nextCursor: '9007199254740993' }));
    await settle();
    TestBed.tick();
    expect(query.items()).toEqual([testChat]);
    const loading = query.loadMore();
    const dm = { ...testChat, id: encodeId('9007199254740995'), kind: GroupKind.dm };
    http
      .expectOne('/_api/chats?limit=50&after=9007199254740993')
      .flush({ chats: [{ ...dm, id: decodeId(dm.id) }], nextCursor: null });
    await loading;
    expect(query.items()).toEqual([testChat, dm]);
    expect(query.hasMore()).toBe(false);
    const info = TestBed.inject(ChatStore);
    expect(info.get(dm.id)?.kind).toBe(GroupKind.dm);
    selectQuery(true);
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50&archived=true').flush({ chats: [] });
    await settle();
    expect(query.items()).toEqual([]);
    expect(info.get(testChat.id)?.name).toBe(testChat.name);
    expect(info.get(dm.id)?.kind).toBe(GroupKind.dm);
  });

  it('ignores an old pagination response after the list has refreshed', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [wireChat], nextCursor: '9007199254740993' }));
    await settle();
    TestBed.tick();
    const loading = query.loadMore();
    const oldPage = http.expectOne('/_api/chats?limit=50&after=9007199254740993');
    data.refreshChats();
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50').flush({ chats: [], nextCursor: null });
    await settle();
    TestBed.tick();
    expect(oldPage.cancelled).toBe(true);
    await loading;
    expect(query.items()).toEqual([]);
  });
  it('updates the preview once and uses the authoritative live unread count without losing pagination', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [wireChat], nextCursor: '9007199254740993' }));
    await settle();
    TestBed.tick();
    const loading = query.loadMore();
    incoming.next(testMessage);
    incoming.next(testMessage);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ unreadCount: 7 });
    http
      .expectOne('/_api/chats?limit=50&after=9007199254740993')
      .flush(structuredClone({ chats: [{ ...wireChat, id: '9007199254740995' }], nextCursor: null }));
    await loading;
    expect(query.items()).toHaveLength(2);
    expect(query.items()[0].lastMessage?.id).toBe(testMessage.id);
    expect(query.items()[0].unreadCount).toBe(7);
  });

  it('keeps an edit visible over a list response that started before the change', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastMessage: wireMessage }] }));
    await settle();
    query.refresh();
    const stale = http.expectOne('/_api/chats?limit=50');
    stale.flush(structuredClone({ chats: [{ ...wireChat, lastMessage: wireMessage }] }));
    const edited = { ...testMessage, message: '修改后的消息', isEdited: true };
    messages.acceptChange({ type: ServerWsMessageType.messageUpdated, payload: edited });
    expect(query.items()[0].lastMessage?.message).toBe(edited.message);
    await settle();
    expect(query.items()[0].lastMessage?.message).toBe(edited.message);
    http.expectNone('/_api/chats?limit=50');
    query.refresh();
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastMessage: { ...wireMessage, message: edited.message } }] }));
    await settle();
    expect(query.items()[0].lastMessage?.message).toBe(edited.message);
  });

  it('withdraws a live preview immediately and retires it after the authoritative tombstone arrives', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    incoming.next(testMessage);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ unreadCount: 7 });
    await settle();
    query.refresh();
    const stale = http.expectOne('/_api/chats?limit=50');
    const deleted = { ...testMessage, message: undefined, isDeleted: true, attachments: [], mentions: [] };
    messages.acceptChange({ type: ServerWsMessageType.messageDeleted, payload: deleted });
    expect(query.items()[0].lastMessage).toMatchObject({ id: testMessage.id, isDeleted: true });
    expect(query.items()[0].unreadCount).toBe(7);
    await settle();
    expect(stale.cancelled).toBe(true);
    http.expectOne('/_api/chats?limit=50').flush(
      structuredClone({
        chats: [{ ...wireChat, lastMessage: { ...wireMessage, isDeleted: true, message: null }, unreadCount: 3 }],
      }),
    );
    await settle();
    expect(query.items()[0]).toMatchObject({ lastMessage: { isDeleted: true }, unreadCount: 3 });
    incoming.next(testMessage);
    expect(query.items()[0].lastMessage?.isDeleted).toBe(true);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ unreadCount: 3 });
    await settle();
  });

  it('coalesces bulk withdrawals and takes unread state from the refreshed list', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastMessage: wireMessage, unreadCount: 7 }] }));
    await settle();
    const change = {
      type: ServerWsMessageType.messagesBulkDeleted as const,
      payload: { chatId: testChat.id, messageIds: [testMessage.id, encodeId('100')] },
    };
    messages.acceptChange(change);
    messages.acceptChange(change);
    expect(query.items()[0]).toMatchObject({
      lastMessage: { isDeleted: true, attachments: [], mentions: [] },
      unreadCount: 7,
    });
    await settle();
    http
      .expectOne('/_api/chats?limit=50')
      .flush(
        structuredClone({ chats: [{ ...wireChat, lastMessage: { ...wireMessage, isDeleted: true }, unreadCount: 4 }] }),
      );
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
    await settle();
    expect(query.items()[0].unreadCount).toBe(4);
  });

  it('ignores topic edits and reactions, and refreshes hidden changed chats only on return', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastMessage: wireMessage }] }));
    await settle();
    messages.acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, replyRootId: encodeId('100'), message: '话题回复' },
    });
    messages.acceptChange({
      type: ServerWsMessageType.reactionUpdated,
      payload: { chatId: testChat.id, messageId: testMessage.id, reactions: [] },
    });
    await settle();
    http.expectNone(() => true);
    releaseQuery();
    messages.acceptChange({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    expect(query.items()[0].lastMessage?.isDeleted).toBe(true);
    await settle();
    http.expectNone(() => true);
    releaseQuery = query.activate();
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastMessage: { ...wireMessage, isDeleted: true } }] }));
    await settle();
    expect(query.items()[0].lastMessage?.isDeleted).toBe(true);
  });

  it('coalesces visible messages into one read and keeps its result over an older chat-list response', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    query.refresh();
    const oldList = http.expectOne('/_api/chats?limit=50');
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, encodeId('9007199254741000'));
    const newer = data['chatInfo'].markRead(testChat.id, testMessage.id);
    data['chatInfo'].markRead(testChat.id, encodeId('9007199254741001'));
    await vi.advanceTimersByTimeAsync(1000);
    const request = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`);
    expect(request.request.body).toEqual({ messageId: wireMessage.id });
    request.flush({ lastReadMessageId: wireMessage.id, unreadCount: 1 });
    await Promise.all([reading, newer]);
    oldList.flush(structuredClone({ chats: [wireChat] }));
    await settle();
    expect(query.items()[0].lastReadMessageId).toBe(testMessage.id);
    expect(query.items()[0].unreadCount).toBe(1);
    await data['chatInfo'].markRead(testChat.id, encodeId('9007199254741000'));
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
  });

  it('serializes read requests while retaining the largest next visible message', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    const first = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`);
    data['chatInfo'].markRead(testChat.id, encodeId('9007199254741010'));
    data['chatInfo'].markRead(testChat.id, encodeId('9007199254741009'));
    await vi.advanceTimersByTimeAsync(1000);
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/read`);
    first.flush({ lastReadMessageId: wireMessage.id, unreadCount: 4 });
    await vi.advanceTimersByTimeAsync(1000);
    const second = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`);
    expect(second.request.body).toEqual({ messageId: '9007199254741010' });
    second.flush({ lastReadMessageId: '9007199254741010', unreadCount: 0 });
    await reading;
    expect(query.items()[0].unreadCount).toBe(0);
  });

  it('discards an unread snapshot when a newer live message arrives during its request', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    const refreshing = data['chatInfo']['refreshUnread'](testChat.id);
    const stale = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    incoming.next(testMessage);
    stale.flush({ lastReadMessageId: '9007199254741000', unreadCount: 0 });
    await settle();
    expect(query.items()[0].unreadCount).toBe(testChat.unreadCount);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({
      lastReadMessageId: '9007199254741000',
      unreadCount: 1,
    });
    expect(await refreshing).toEqual({ lastReadMessageId: encodeId('9007199254741000'), unreadCount: 1 });
    expect(query.items()[0].unreadCount).toBe(1);
  });

  it('applies the server read advancement after our own send, including duplicate HTTP and WebSocket delivery', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    const initialRead = data['chatInfo']['refreshUnread'](testChat.id);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ unreadCount: wireChat.unreadCount });
    await initialRead;
    // A concurrent list fetch can discover our send before either send-response delivery path.
    query.refresh();
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastMessage: wireMessage }] }));
    await settle();
    incoming.next(testMessage);
    messages.accept(testMessage);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({
      lastReadMessageId: wireMessage.id,
      unreadCount: 0,
    });
    await settle();
    expect(query.items()[0].lastReadMessageId).toBe(testMessage.id);
    expect(query.items()[0].unreadCount).toBe(0);
  });

  it('applies a read response immediately and prevents an older in-flight unread GET from undoing it', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    const refreshing = data['chatInfo']['refreshUnread'](testChat.id);
    const oldUnread = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`).flush({
      lastReadMessageId: wireMessage.id,
      unreadCount: 0,
    });
    await settle();
    expect(query.items()[0].unreadCount).toBe(0);
    oldUnread.flush({ lastReadMessageId: null, unreadCount: 2 });
    await settle();
    expect(query.items()[0].lastReadMessageId).toBe(testMessage.id);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({
      lastReadMessageId: wireMessage.id,
      unreadCount: 1,
    });
    await Promise.all([refreshing, reading]);
    expect(query.items()[0].unreadCount).toBe(1);
  });

  it('reconciles a live message that arrived after the read POST started', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    const read = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`);
    incoming.next({ ...testMessage, id: encodeId('9007199254741010') });
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ unreadCount: 4 });
    await vi.advanceTimersByTimeAsync(0);
    read.flush({ lastReadMessageId: wireMessage.id, unreadCount: 1 });
    await settle();
    expect(query.items()[0].unreadCount).toBe(1);
    http
      .expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`)
      .flush({ lastReadMessageId: wireMessage.id, unreadCount: 2 });
    await reading;
    expect(query.items()[0].unreadCount).toBe(2);
  });

  it('refreshes read state for out-of-order delivery while preserving the newest preview', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    incoming.next({ ...testMessage, id: encodeId('9007199254741010') });
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ unreadCount: 5 });
    await settle();
    await settle();
    incoming.next(testMessage);
    http
      .expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`)
      .flush({ lastReadMessageId: wireMessage.id, unreadCount: 1 });
    await settle();
    expect(query.items()[0].lastMessage?.id).toBe(encodeId('9007199254741010'));
    expect(query.items()[0].lastReadMessageId).toBe(testMessage.id);
    expect(query.items()[0].unreadCount).toBe(1);
  });

  it('can retry a failed read without advancing the local pointer prematurely', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    TestBed.tick();
    vi.useFakeTimers();
    const failed = expect(data['chatInfo'].markRead(testChat.id, testMessage.id)).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`).flush('failed', { status: 500, statusText: 'Error' });
    await failed;
    expect(query.items()[0].lastReadMessageId).toBeUndefined();
    const retry = data['chatInfo'].markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    http
      .expectOne(`/_api/chats/${decodeId(testChat.id)}/read`)
      .flush({ lastReadMessageId: wireMessage.id, unreadCount: 0 });
    await retry;
  });

  it('discards a throttled read when marking unread and retains a later newly queued read', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '200', unreadCount: 1 }] }));
    await settle();
    vi.useFakeTimers();
    const oldRead = data['chatInfo'].markRead(testChat.id, encodeId('201'));
    const unread = data['chatInfo'].markUnread(testChat.id);
    expect(data['chatInfo'].markUnread(testChat.id)).toBe(unread);
    const request = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    await data['chatInfo'].markRead(testChat.id, encodeId('202'));
    request.flush({ lastReadMessageId: '200', unreadCount: 1 });
    await unread;
    await vi.advanceTimersByTimeAsync(500);
    const nextRead = data['chatInfo'].markRead(testChat.id, encodeId('202'));
    await vi.advanceTimersByTimeAsync(500);
    await oldRead;
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/read`);
    expect(data['chatInfo'].markRead(testChat.id, encodeId('203'))).toBe(nextRead);
    await vi.advanceTimersByTimeAsync(500);
    const next = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`);
    expect(next.request.body).toEqual({ messageId: '203' });
    next.flush({ lastReadMessageId: '203', unreadCount: 0 });
    await nextRead;
  });

  it('waits for a sent read, drops its queued target, and accepts the authoritative unread rewind', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '200', unreadCount: 1 }] }));
    await settle();
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, encodeId('201'));
    await vi.advanceTimersByTimeAsync(1000);
    const read = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`);
    data['chatInfo'].markRead(testChat.id, encodeId('205'));
    const unread = data['chatInfo'].markUnread(testChat.id);
    await data['chatInfo'].markRead(testChat.id, encodeId('206'));
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
    read.flush({ lastReadMessageId: '201', unreadCount: 0 });
    await reading;
    await settle();
    const request = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    expect(request.request.method).toBe('POST');
    request.flush({ lastReadMessageId: '200', unreadCount: 1 });
    await unread;
    await vi.advanceTimersByTimeAsync(2000);
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/read`);
    expect(query.items()[0].lastReadMessageId).toBe(encodeId('200'));
    expect(query.items()[0].unreadCount).toBe(1);
  });

  it('still marks unread after a previously sent read fails', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    vi.useFakeTimers();
    const reading = expect(data['chatInfo'].markRead(testChat.id, encodeId('201'))).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    const unread = data['chatInfo'].markUnread(testChat.id);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`).flush('failed', { status: 500, statusText: 'Error' });
    await reading;
    await settle();
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ lastReadMessageId: '200', unreadCount: 1 });
    await unread;
    expect(query.items()[0].lastReadMessageId).toBe(encodeId('200'));
  });

  it('prevents an old unread GET from overriding a successful rewind', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '201', unreadCount: 0 }] }));
    await settle();
    const refreshing = data['chatInfo']['refreshUnread'](testChat.id);
    const stale = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    const unread = data['chatInfo'].markUnread(testChat.id);
    http
      .expectOne(
        (request) => request.url === `/_api/chats/${decodeId(testChat.id)}/unread` && request.method === 'POST',
      )
      .flush({ lastReadMessageId: '200', unreadCount: 1 });
    await settle();
    expect(query.items()[0].lastReadMessageId).toBe(encodeId('200'));
    stale.flush({ lastReadMessageId: '201', unreadCount: 0 });
    await settle();
    expect(query.items()[0].lastReadMessageId).toBe(encodeId('200'));
    const fresh = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    expect(fresh.request.method).toBe('GET');
    fresh.flush({ lastReadMessageId: '200', unreadCount: 1 });
    await Promise.all([refreshing, unread]);
    expect(query.items()[0].unreadCount).toBe(1);
  });

  it('reconciles a new message received while the unread POST response was delayed', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '201', unreadCount: 0 }] }));
    await settle();
    const unread = data['chatInfo'].markUnread(testChat.id);
    const delayed = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    incoming.next(testMessage);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ lastReadMessageId: '200', unreadCount: 2 });
    await settle();
    delayed.flush({ lastReadMessageId: '200', unreadCount: 1 });
    await settle();
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ lastReadMessageId: '200', unreadCount: 2 });
    await unread;
    expect(query.items()[0].unreadCount).toBe(2);
  });

  it('preserves state on a failed unread command and permits retry', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '201', unreadCount: 0 }] }));
    await settle();
    const failed = expect(data['chatInfo'].markUnread(testChat.id)).rejects.toBeDefined();
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush('failed', { status: 500, statusText: 'Error' });
    await failed;
    expect(query.items()[0].lastReadMessageId).toBe(encodeId('201'));
    const retry = data['chatInfo'].markUnread(testChat.id);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ lastReadMessageId: '200', unreadCount: 1 });
    await retry;
    expect(query.items()[0].lastReadMessageId).toBe(encodeId('200'));
  });

  it('mutes a direct chat indefinitely using server metadata and reconciles later remote changes', async () => {
    const chat = { ...wireChat, kind: GroupKind.dm, mutedUntil: null };
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [chat] }));
    await settle();
    const muting = data['chatInfo'].setMuted(testChat.id, true);
    const request = http.expectOne(`/_api/group/${decodeId(testChat.id)}/mute`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({});
    const mutedUntil = '9999-12-31T23:59:59.999Z';
    request.flush({ mutedUntil });
    await muting;
    TestBed.tick();
    expect(query.items()[0].mutedUntil).toBe(mutedUntil);
    expect(query.items()[0].archived).toBe(false);
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [{ ...chat, mutedUntil }] }));
    await settle();
    resync.next();
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [chat] }));
    await settle();
    expect(query.items()[0].mutedUntil).toBeNull();
  });

  it('unmutes and unarchives an archived conversation', async () => {
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    await settle();
    selectQuery(true);
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50&archived=true').flush(
      structuredClone({
        chats: [{ ...wireChat, archived: true, mutedUntil: '9999-12-31T23:59:59Z' }],
      }),
    );
    await settle();
    const unmuting = data['chatInfo'].setMuted(testChat.id, false);
    const request = http.expectOne(`/_api/group/${decodeId(testChat.id)}/mute`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null);
    await unmuting;
    TestBed.tick();
    expect(query.items()).toEqual([]);
    http.expectOne('/_api/chats?limit=50&archived=true').flush({ chats: [] });
    await settle();
    selectQuery(false);
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [{ ...wireChat, mutedUntil: null }] }));
    await settle();
    expect(query.items()[0]).toMatchObject({ mutedUntil: null, archived: false });
  });

  it('leaves mute metadata unchanged when the command fails', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [{ ...wireChat, mutedUntil: null }] }));
    await settle();
    const failed = expect(data['chatInfo'].setMuted(testChat.id, true)).rejects.toBeDefined();
    http.expectOne(`/_api/group/${decodeId(testChat.id)}/mute`).flush('failed', { status: 500, statusText: 'Error' });
    await failed;
    expect(query.items()[0].mutedUntil).toBeNull();
  });

  it('joins an existing read-state GET without invalidating it and fetches a missing deep link', async () => {
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    await settle();
    const first = data['chatInfo'].getReadState(testChat.id);
    expect(data['chatInfo'].getReadState(testChat.id)).toBe(first);
    const initial = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    initial.flush({ lastReadMessageId: '200', unreadCount: 1 });
    await first;
    expect(data['chatInfo']['readOperations'].size).toBe(0);
    resync.next();
    TestBed.tick();
    const joined = data['chatInfo'].getReadState(testChat.id);
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ lastReadMessageId: '200', unreadCount: 2 });
    expect(await joined).toEqual({ lastReadMessageId: encodeId('200'), unreadCount: 2 });
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
  });

  it('accepts a later list snapshot for read and preview state', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    incoming.next(testMessage);
    http
      .expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`)
      .flush({ lastReadMessageId: wireMessage.id, unreadCount: 0 });
    await settle();
    expect(data['chatInfo']['readOperations'].size).toBe(0);
    expect(data['chatInfo'].cachedReadState(testChat.id)?.unreadCount).toBe(0);
    data.refreshChats();
    TestBed.tick();
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
    // A different device marked this conversation unread after our previous snapshot.
    http.expectOne('/_api/chats?limit=50').flush(
      structuredClone({
        chats: [{ ...wireChat, lastMessage: wireMessage, lastReadMessageId: '200', unreadCount: 2 }],
      }),
    );
    await settle();
    expect(query.items()[0]).toMatchObject({ lastReadMessageId: encodeId('200'), unreadCount: 2 });
  });

  it('deduplicates reads for deep links and reloads their state on demand after reconnect', async () => {
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    await settle();
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    http
      .expectOne(`/_api/chats/${decodeId(testChat.id)}/read`)
      .flush({ lastReadMessageId: wireMessage.id, unreadCount: 0 });
    await reading;
    await data['chatInfo'].markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/read`);
    resync.next();
    TestBed.tick();
    const joined = data['chatInfo'].getReadState(testChat.id);
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    http
      .expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`)
      .flush({ lastReadMessageId: wireMessage.id, unreadCount: 1 });
    await joined;
    expect(data['chatInfo']['readOperations'].size).toBe(0);
    resync.next();
    TestBed.tick();
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    await settle();
  });

  it('keeps a new read over an older list response and accepts the next reload', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    data.refreshChats();
    TestBed.tick();
    const oldList = http.expectOne('/_api/chats?limit=50');
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    http
      .expectOne(`/_api/chats/${decodeId(testChat.id)}/read`)
      .flush({ lastReadMessageId: wireMessage.id, unreadCount: 0 });
    await reading;
    oldList.flush(structuredClone({ chats: [wireChat] }));
    await settle();
    expect(query.items()[0]).toMatchObject({ lastReadMessageId: testMessage.id, unreadCount: 0 });
    data.refreshChats();
    TestBed.tick();
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: wireMessage.id, unreadCount: 1 }] }));
    await settle();
    expect(query.items()[0].unreadCount).toBe(1);
  });

  it('keeps an open conversation read pointer when a fresh list later switches to another query', async () => {
    const chat = { ...wireChat, lastReadMessageId: wireMessage.id, unreadCount: 0 };
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [chat] }));
    await settle();
    query.refresh();
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [chat] }));
    await settle();
    selectQuery(true);
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50&archived=true').flush({ chats: [] });
    await settle();
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/read`);
    await reading;
  });

  it('keeps historical chats without refreshing their reads in the background', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    incoming.next(testMessage);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush({ unreadCount: 1 });
    await settle();
    selectQuery(true);
    TestBed.tick();
    http.expectOne('/_api/chats?limit=50&archived=true').flush({ chats: [] });
    await settle();
    expect(data['chatInfo']['readOperations'].size).toBe(0);
    resync.next();
    TestBed.tick();
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
    http.expectOne('/_api/chats?limit=50&archived=true').flush({ chats: [] });
    await settle();
  });

  it('cancels a pending read delay and the list request when the service is destroyed', async () => {
    const list = http.expectOne('/_api/chats?limit=50');
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, testMessage.id);
    TestBed.resetTestingModule();
    expect(list.cancelled).toBe(true);
    await reading;
    await vi.advanceTimersByTimeAsync(2000);
    incoming.next(testMessage);
    resync.next();
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/read`);
    expect(data['chatInfo']['readOperations'].size).toBe(0);
  });

  it('cancels unread HTTP reconciliation on destruction and does not start its queued retry', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    const refreshing = expect(data['chatInfo'].getReadState(testChat.id)).rejects.toBeDefined();
    const unread = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    incoming.next(testMessage);
    TestBed.resetTestingModule();
    expect(unread.cancelled).toBe(true);
    await refreshing;
    await settle();
    expect(data['chatInfo']['readOperations'].size).toBe(0);
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
  });

  it('shares a stable query, its initial request and pagination until its last consumer leaves', async () => {
    expect(data.chats(false)).toBe(query);
    data.chats(true);
    http.expectNone('/_api/chats?limit=50&archived=true');
    const releaseSecond = data.chats(false).activate();
    const initial = http.expectOne('/_api/chats?limit=50');
    releaseQuery();
    expect(initial.cancelled).toBe(false);
    initial.flush(structuredClone({ chats: [wireChat], nextCursor: '9007199254740993' }));
    await settle();
    const paging = query.loadMore();
    expect(query.loadMore()).toBe(paging);
    const page = http.expectOne('/_api/chats?limit=50&after=9007199254740993');
    releaseSecond();
    expect(page.cancelled).toBe(true);
    await paging;
    expect(query.items()).toEqual([testChat]);
    expect(query.loadingMore()).toBe(false);
    query.activate();
    http.expectOne('/_api/chats?limit=50').flush({ chats: [] });
    await settle();
    expect(query.items()).toEqual([]);
  });

  it('cancels a departing query page without applying it to the other query', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [wireChat], nextCursor: '9007199254740993' }));
    await settle();
    const regular = query;
    const paging = query.loadMore();
    const old = http.expectOne('/_api/chats?limit=50&after=9007199254740993');
    selectQuery(true);
    expect(old.cancelled).toBe(true);
    http
      .expectOne('/_api/chats?limit=50&archived=true')
      .flush(structuredClone({ chats: [{ ...wireChat, id: '9007199254740995', archived: true }] }));
    await paging;
    await settle();
    expect(query.items().map((chat) => chat.id)).toEqual([encodeId('9007199254740995')]);
    expect(regular.items()).toEqual([testChat]);
    selectQuery(false);
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    expect(query.hasMore()).toBe(false);
  });

  it('merges a recent conversation before an older pagination response without losing either page', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [wireChat], nextCursor: '9007199254740993' }));
    await settle();
    const paging = query.loadMore();
    const old = http.expectOne('/_api/chats?limit=50&after=9007199254740993');
    const otherId = encodeId('9007199254740995');
    incoming.next({ ...testMessage, chatId: otherId });
    const unread = http.expectOne('/_api/chats/9007199254740995/unread');
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, id: '9007199254740995', lastMessage: wireMessage }] }));
    await settle();
    unread.flush({ lastReadMessageId: wireMessage.id, unreadCount: 0 });
    await settle();
    old.flush(structuredClone({ chats: [{ ...wireChat, id: '9007199254740997' }], nextCursor: null }));
    await paging;
    expect(new Set(query.items().map((chat) => chat.id))).toEqual(
      new Set([testChat.id, otherId, encodeId('9007199254740997')]),
    );
    expect(data['chatInfo'].cachedReadState(otherId)?.lastReadMessageId).toBe(testMessage.id);
    expect(query.hasMore()).toBe(false);
  });

  it('does not expose an obsolete by-id count after live unread reconciliation fails', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    incoming.next(testMessage);
    const failed = expect(data['chatInfo'].getReadState(testChat.id)).rejects.toBeDefined();
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`).flush('failed', { status: 500, statusText: 'Error' });
    await failed;
    await settle();
    expect(data['chatInfo'].cachedReadState(testChat.id)).toBeUndefined();
    expect(query.error()).toBe(ChatListError.Unread);
    query.refresh();
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [{ ...wireChat, unreadCount: 4 }] }));
    await settle();
    expect(data['chatInfo'].cachedReadState(testChat.id)?.unreadCount).toBe(4);
  });

  it('serves a fresh by-id read snapshot across queries and falls back after hidden invalidation', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '200', unreadCount: 3 }] }));
    await settle();
    const regular = query;
    selectQuery(true);
    http.expectOne('/_api/chats?limit=50&archived=true').flush({ chats: [] });
    await settle();
    expect(data['chatInfo'].cachedReadState(testChat.id)).toEqual({
      lastReadMessageId: encodeId('200'),
      unreadCount: 3,
    });
    data.refreshChats();
    expect(data['chatInfo'].cachedReadState(testChat.id)).toBeUndefined();
    http.expectNone('/_api/chats?limit=50');
    http.expectOne('/_api/chats?limit=50&archived=true').flush({ chats: [] });
    await settle();
    expect(regular.items()[0].unreadCount).toBe(3);
    selectQuery(false);
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '199', unreadCount: 4 }] }));
    await settle();
    expect(data['chatInfo'].cachedReadState(testChat.id)).toEqual({
      lastReadMessageId: encodeId('199'),
      unreadCount: 4,
    });
  });

  it('keeps hidden queries dirty without background list work and reloads them on activation', async () => {
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    releaseQuery();
    incoming.next(testMessage);
    resync.next();
    http.expectNone('/_api/chats?limit=50');
    http.expectNone(`/_api/chats/${decodeId(testChat.id)}/unread`);
    expect(data['chatInfo'].cachedReadState(testChat.id)).toBeUndefined();
    expect(query.items()).toHaveLength(1);
    query.activate();
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastMessage: wireMessage, unreadCount: 5 }] }));
    await settle();
    expect(query.items()[0].lastMessage?.id).toBe(testMessage.id);
  });

  it('does not use a stale cursor after a refresh fails', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [wireChat], nextCursor: '9007199254740993' }));
    await settle();
    query.refresh();
    http.expectOne('/_api/chats?limit=50').flush('failed', { status: 500, statusText: 'Error' });
    await settle();
    expect(query.error()).toBe(ChatListError.Load);
    expect(query.items()).toEqual([testChat]);
    expect(query.hasMore()).toBe(false);
    expect(data['chatInfo'].cachedReadState(testChat.id)).toBeUndefined();
    await query.loadMore();
    http.expectNone('/_api/chats?limit=50&after=9007199254740993');
  });

  it('catches up a new conversation received during initial loading without letting the old page replace it', async () => {
    const initial = http.expectOne('/_api/chats?limit=50');
    incoming.next(testMessage);
    incoming.next(testMessage);
    http.expectNone('/_api/chats?limit=50');
    const unread = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/unread`);
    initial.flush({ chats: [], nextCursor: '9007199254740993' });
    await settle();
    const recent = http.expectOne('/_api/chats?limit=50');
    unread.flush({ lastReadMessageId: wireMessage.id, unreadCount: 0 });
    await settle();
    recent.flush(structuredClone({ chats: [{ ...wireChat, lastMessage: wireMessage, unreadCount: 5 }] }));
    await settle();
    expect(query.items()[0]).toMatchObject({ lastReadMessageId: testMessage.id, unreadCount: 0 });
    expect(query.items()[0].lastMessage?.id).toBe(testMessage.id);
    expect(query.hasMore()).toBe(true);
  });

  it('shares the latest unread count when switching to a cached query', async () => {
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '200', unreadCount: 3 }] }));
    await settle();
    const archived = data.chats(true);
    archived.activate();
    http
      .expectOne('/_api/chats?limit=50&archived=true')
      .flush(structuredClone({ chats: [{ ...wireChat, archived: true, lastReadMessageId: '200', unreadCount: 3 }] }));
    await settle();
    archived.refresh();
    const old = http.expectOne('/_api/chats?limit=50&archived=true');
    vi.useFakeTimers();
    const reading = data['chatInfo'].markRead(testChat.id, encodeId('205'));
    await vi.advanceTimersByTimeAsync(1000);
    http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`).flush({ lastReadMessageId: '205', unreadCount: 0 });
    await reading;
    query.refresh();
    http
      .expectOne('/_api/chats?limit=50')
      .flush(structuredClone({ chats: [{ ...wireChat, lastReadMessageId: '205', unreadCount: 0 }] }));
    await settle();
    old.flush(structuredClone({ chats: [{ ...wireChat, archived: true, lastReadMessageId: '200', unreadCount: 3 }] }));
    await settle();
    expect(query.items()[0].unreadCount).toBe(0);
    expect(archived.items()).toEqual([]);
    expect(data['chatInfo'].cachedReadState(testChat.id)).toEqual({
      lastReadMessageId: encodeId('205'),
      unreadCount: 0,
    });
  });
  it('refreshes the loaded conversation depth and keeps the final paging cursor', async () => {
    http.expectOne('/_api/chats?limit=50').flush({ chats: [structuredClone(wireChat)], nextCursor: wireChat.id });
    await settle();
    const olderChat = { ...wireChat, id: '9007199254740900', name: 'Older' };
    const more = query.loadMore();
    http.expectOne(`/_api/chats?limit=50&after=${wireChat.id}`).flush({
      chats: [structuredClone(olderChat)],
      nextCursor: olderChat.id,
    });
    await more;
    query.refresh();
    http
      .expectOne('/_api/chats?limit=50')
      .flush({ chats: [{ ...wireChat, name: 'Updated' }], nextCursor: wireChat.id });
    await settle();
    expect(query.items()).toHaveLength(2);
    http
      .expectOne(`/_api/chats?limit=50&after=${wireChat.id}`)
      .flush({ chats: [structuredClone(olderChat)], nextCursor: olderChat.id });
    await settle();
    expect(query.items().map((chat) => chat.name)).toEqual(['Updated', 'Older']);
    const next = query.loadMore();
    http.expectOne(`/_api/chats?limit=50&after=${olderChat.id}`).flush({ chats: [] });
    await next;
  });
});
