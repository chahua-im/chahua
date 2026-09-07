import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { ServerWsMessageType, type MessageResponse, type ServerWsMessage } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, wireChat } from '../api/testing';
import { ChatListStore } from './chat-list-store';
import { ChatStore } from './chat-store';

describe('ChatListStore archived unread', () => {
  let counts: ChatListStore['archivedUnread'];
  let http: HttpTestingController;
  let scope: EnvironmentInjector;
  let messages: Subject<MessageResponse>;
  let events: Subject<ServerWsMessage>;
  let resync: Subject<void>;

  beforeEach(() => {
    messages = new Subject();
    events = new Subject();
    resync = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ messages$: messages, events$: events, resync$: resync }) },
      ],
    });
    scope = createEnvironmentInjector([ChatListStore, ChatStore], TestBed.inject(EnvironmentInjector));
    counts = scope.get(ChatListStore).archivedUnread;
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    scope.destroy();
    http.verify();
  });

  async function settle() {
    for (let step = 0; step < 8; step++) await Promise.resolve();
  }
  function chatTotal(count: number) {
    return { archivedUnreadCount: count, archivedUnreadChatCount: 2, unreadCount: 0, unreadChatCount: 0 };
  }
  function topicTotal(count: number) {
    return {
      archivedUnreadMessageCount: count,
      archivedUnreadThreadCount: 3,
      unreadMessageCount: 0,
      unreadThreadCount: 0,
    };
  }

  it('uses a zero backend total without probing archived records', async () => {
    counts.chats.activate();
    counts.threads.activate();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(0));
    http.expectOne('/_api/threads/unread').flush(topicTotal(0));
    await settle();
    expect(counts.chats.value()).toBe(0);
    expect(counts.threads.value()).toBe(0);
    http.expectNone(() => true);
  });

  it('keeps cached totals but only refreshes queries with consumers', async () => {
    counts.refresh();
    resync.next();
    messages.next(testMessage);
    await settle();
    http.expectNone(() => true);
    let releaseChats = counts.chats.activate();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(17));
    await settle();
    releaseChats();
    const releaseThreads = counts.threads.activate();
    await settle();
    http.expectOne('/_api/threads/unread').flush(topicTotal(31));
    await settle();
    expect(counts.chats.value()).toBe(17);
    releaseThreads();
    releaseChats = counts.chats.activate();
    await settle();
    http.expectNone(() => true);
    releaseChats();
    messages.next(testMessage);
    resync.next();
    await settle();
    http.expectNone(() => true);
    counts.threads.activate();
    await settle();
    http.expectOne('/_api/threads/unread').flush(topicTotal(32));
    await settle();
    expect(counts.threads.value()).toBe(32);
    expect(counts.chats.value()).toBe(17);
    http.expectNone('/_api/chats/unread');
  });

  it('shares the backend total without scanning archived pages', async () => {
    const release = counts.chats.activate();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(268));
    await settle();
    expect(counts.chats.value()).toBe(268);
    release();
    counts.chats.activate();
    await settle();
    http.expectNone(() => true);
  });

  it('coalesces invalidations and rejects a snapshot superseded in flight', async () => {
    counts.chats.activate();
    counts.refresh();
    resync.next();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(5));
    await settle();
    counts.refresh();
    await settle();
    const stale = http.expectOne('/_api/chats/unread');
    messages.next(testMessage);
    counts.refresh();
    events.next({
      type: ServerWsMessageType.chatArchiveStateChanged,
      payload: { chatId: testChat.id, archived: true, mutedUntil: undefined },
    });
    resync.next();
    await settle();
    http.expectNone('/_api/chats/unread');
    stale.flush(chatTotal(100));
    await settle();
    expect(counts.chats.value()).toBe(5);
    http.expectOne('/_api/chats/unread').flush(chatTotal(8));
    await settle();
    expect(counts.chats.value()).toBe(8);
  });

  it('handles accepted HTTP messages and WebSocket echoes through the same refresh path', async () => {
    counts.threads.activate();
    await settle();
    http.expectOne('/_api/threads/unread').flush(topicTotal(3));
    await settle();
    const reply = { ...testMessage, replyRootId: encodeId('100') };
    scope.get(Connection).accept(reply);
    messages.next(reply);
    await settle();
    http.expectOne('/_api/threads/unread').flush(topicTotal(2));
    await settle();
    expect(counts.threads.value()).toBe(2);
    http.expectNone(() => true);
  });

  it('cancels the last consumer’s pending total request', async () => {
    const release = counts.chats.activate();
    await settle();
    const pending = http.expectOne('/_api/chats/unread');
    release();
    expect(pending.cancelled).toBe(true);
    http.expectNone(() => true);
  });

  it('preserves the last successful value on failure and retries on demand', async () => {
    counts.chats.activate();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(7));
    await settle();
    counts.refresh();
    await settle();
    http.expectOne('/_api/chats/unread').flush('failed', { status: 500, statusText: 'Error' });
    await settle();
    expect(counts.chats.value()).toBe(7);
    expect(counts.chats.error()).toBe(true);
    http.expectNone(() => true);
    counts.refresh();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(0));
    await settle();
    await settle();
    expect(counts.chats.value()).toBe(0);
    expect(counts.chats.error()).toBe(false);
  });

  it.each([ServerWsMessageType.threadUpdate, ServerWsMessageType.threadMembershipChanged] as const)(
    'invalidates topic totals on %s',
    async (type) => {
      counts.threads.activate();
      await settle();
      http.expectOne('/_api/threads/unread').flush(topicTotal(4));
      await settle();
      events.next(
        type === ServerWsMessageType.threadUpdate
          ? {
              type,
              payload: {
                chatId: testChat.id,
                threadRootId: encodeId('100'),
                replyCount: 2,
                lastReplyAt: testMessage.createdAt,
              },
            }
          : { type, payload: { chatId: testChat.id, threadRootId: encodeId('100') } },
      );
      await settle();
      http.expectOne('/_api/threads/unread').flush(topicTotal(6));
      await settle();
      expect(counts.threads.value()).toBe(6);
    },
  );

  it('shares one query between consumers and cancels only after the last consumer leaves', async () => {
    const releaseFirst = counts.chats.activate();
    const releaseSecond = counts.chats.activate();
    await settle();
    const request = http.expectOne('/_api/chats/unread');
    releaseFirst();
    expect(request.cancelled).toBe(false);
    request.flush(chatTotal(9));
    await settle();
    expect(counts.chats.value()).toBe(9);

    counts.chats.refresh();
    await settle();
    const pending = http.expectOne('/_api/chats/unread');
    releaseSecond();
    expect(pending.cancelled).toBe(true);
    await settle();
    http.expectNone(() => true);
    expect(counts.chats.value()).toBe(9);

    const releaseReturning = counts.chats.activate();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(10));
    await settle();
    releaseReturning();
    counts.chats.activate();
    await settle();
    expect(counts.chats.value()).toBe(10);
    http.expectNone(() => true);
  });

  it('runs separate queries independently, including cancellation, refresh and errors', async () => {
    const releaseChats = counts.chats.activate();
    counts.threads.activate();
    await settle();
    const chats = http.expectOne('/_api/chats/unread');
    const threads = http.expectOne('/_api/threads/unread');
    releaseChats();
    expect(chats.cancelled).toBe(true);
    expect(threads.cancelled).toBe(false);
    threads.flush(topicTotal(12));
    await settle();
    expect(counts.threads.value()).toBe(12);

    counts.chats.activate();
    await settle();
    const returningChats = http.expectOne('/_api/chats/unread');
    counts.threads.refresh();
    await settle();
    http.expectOne('/_api/threads/unread').flush('failed', { status: 500, statusText: 'Error' });
    await settle();
    expect(returningChats.cancelled).toBe(false);
    expect(counts.threads.error()).toBe(true);
    expect(counts.chats.error()).toBe(false);
    returningChats.flush(chatTotal(3));
    await settle();
    expect(counts.chats.value()).toBe(3);
    expect(counts.threads.value()).toBe(12);

    counts.refresh();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(4));
    http.expectOne('/_api/threads/unread').flush(topicTotal(13));
    await settle();
    expect(counts.chats.value()).toBe(4);
    expect(counts.threads.value()).toBe(13);
    expect(counts.threads.error()).toBe(false);
    http.expectNone((request) => request.url === '/_api/chats');
  });

  it('cancels pending requests and releases event subscriptions when the service is destroyed', async () => {
    counts.chats.activate();
    await settle();
    const pending = http.expectOne('/_api/chats/unread');
    scope.destroy();
    expect(pending.cancelled).toBe(true);
    messages.next(testMessage);
    resync.next();
    await settle();
    http.expectNone(() => true);
    scope = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
  });
  it('refreshes only topic counters for replies and only chat counters for ordinary messages', async () => {
    counts.chats.activate();
    counts.threads.activate();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(1));
    http.expectOne('/_api/threads/unread').flush(topicTotal(1));
    await settle();
    messages.next({ ...testMessage, replyRootId: encodeId('100') });
    await settle();
    http.expectOne('/_api/threads/unread').flush(topicTotal(2));
    http.expectNone((request) => request.url.startsWith('/_api/chats'));
    await settle();
    messages.next(testMessage);
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(2));
    http.expectNone('/_api/threads/unread');
    await settle();
  });
  it('refreshes the matching archived counters from writes on the same store', async () => {
    const lists = scope.get(ChatListStore);
    counts.chats.activate();
    counts.threads.activate();
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(0));
    await settle();
    http.expectOne('/_api/threads/unread').flush(topicTotal(0));
    await settle();
    await settle();

    const archivingChat = lists['chatInfo'].setArchived(testChat.id, true);
    http.expectOne(`/_api/chats/${wireChat.id}/archive`).flush(null);
    await archivingChat;
    await settle();
    http.expectOne('/_api/chats/unread').flush(chatTotal(3));
    http.expectNone('/_api/threads/unread');
    await settle();
    expect(counts.chats.value()).toBe(3);

    const rootId = encodeId('100');
    const archivingThread = lists['chatInfo'].setThreadArchived(testChat.id, rootId, true);
    http.expectOne(`/_api/chats/${wireChat.id}/threads/100/archive`).flush(null);
    await settle();
    http.expectOne(`/_api/chats/${wireChat.id}/threads/100/subscribe`).flush({ subscribed: true, archived: true });
    http.expectOne('/_api/threads/unread').flush(topicTotal(4));
    http.expectNone('/_api/chats/unread');
    await archivingThread;
    await settle();
    expect(counts.threads.value()).toBe(4);
    expect(lists['chatInfo'].subscription(testChat.id, rootId)?.archived).toBe(true);
  });
});
