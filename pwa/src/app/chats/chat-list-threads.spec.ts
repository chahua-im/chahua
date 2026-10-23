import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import {
  type FriendRequestHistoryEntry,
  type MessageResponse,
  type ServerWsMessage,
  type ThreadListItem,
  FriendRequestDirection,
  FriendRequestStatus,
  NotificationType,
  ServerWsMessageType,
} from '../../generated/models';
import { Connection, ResyncReason } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { ChatListError, ChatListStore, FriendRequestAction } from './chat-list-store';
import { ChatStore } from './chat-store';

const rootId = encodeId('100');
const thread: ThreadListItem = {
  archived: false,
  chatId: testChat.id,
  chatKind: testChat.kind,
  chatName: '测试群',
  threadRootMessage: { ...testMessage, id: rootId, mentions: [] },
  participants: [],
  replyCount: 2,
  unreadCount: 2,
  unreadMentions: 0,
  unreadReactions: 0,
  lastReplyAt: testMessage.createdAt,
  subscribedAt: testMessage.createdAt,
};
const request: FriendRequestHistoryEntry = {
  id: encodeId('9007199254740999'),
  from: { uid: 2, username: '来访者', gender: 0 },
  to: { uid: 1, username: '我', gender: 0 },
  createdAt: testMessage.createdAt,
  status: FriendRequestStatus.pending,
  direction: FriendRequestDirection.incoming,
};
const wireThread = { ...thread, chatId: wireChat.id, threadRootMessage: { ...wireMessage, id: '100', mentions: [] } };
const wireRequest = { ...request, id: decodeId(request.id) };
const activeRequestsUrl = '/_api/friends/requests?archived=false';
const historyUrl = '/_api/friends/requests?archived=true';
const activeThreadsUrl = '/_api/threads?limit=20&archived=false';
const archivedThreadsUrl = '/_api/threads?limit=20&archived=true';
const topicUrl = '/_api/chats/' + decodeId(testChat.id) + '/threads/100';

describe('ChatListStore threads and friend requests', () => {
  let inbox: ChatListStore;
  let http: HttpTestingController;
  let scope: EnvironmentInjector;
  let disposed: boolean;
  let requests: ReturnType<ChatListStore['friendRequests']>;
  let threads: ReturnType<ChatListStore['threads']>;
  let releaseList: () => void;
  let events: Subject<ServerWsMessage>;
  let messages: Subject<MessageResponse>;
  let resync: Subject<ResyncReason | void>;
  let refreshChats: ReturnType<typeof vi.fn>;
  let refreshCounts: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    events = new Subject<ServerWsMessage>();
    messages = new Subject<MessageResponse>();
    resync = new Subject<ResyncReason | void>();
    refreshChats = vi.fn();
    refreshCounts = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ messages$: messages, events$: events, resync$: resync }) },
      ],
    });
    scope = createEnvironmentInjector([ChatListStore, ChatStore], TestBed.inject(EnvironmentInjector));
    disposed = false;
    inbox = scope.get(ChatListStore);
    refreshChats = vi.spyOn(inbox, 'refreshChats');
    refreshCounts = vi.spyOn(inbox.viewUnread, 'refresh');
    requests = inbox.friendRequests(false);
    threads = inbox.threads(false);
    releaseList = () => {};
    http = TestBed.inject(HttpTestingController);
    TestBed.tick();
  });

  afterEach(() => {
    if (!disposed) scope.destroy();
    http.verify();
    vi.useRealTimers();
  });

  async function flushReads() {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100);
    else await new Promise((resolve) => setTimeout(resolve, 110));
    await settle();
  }

  async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    TestBed.tick();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  async function showRequests(history = false) {
    releaseList();
    requests = inbox.friendRequests(history);
    releaseList = requests.activate();
    await settle();
  }

  async function showThreads(archived = false) {
    releaseList();
    threads = inbox.threads(archived);
    releaseList = threads.activate();
    await settle();
  }

  async function hideLists() {
    releaseList();
    releaseList = () => {};
    await settle();
  }

  async function startThreads() {
    await showThreads();
    http.expectOne(activeThreadsUrl).flush(structuredClone({ threads: [wireThread], nextCursor: 'older' }));
    await settle();
  }

  it.each([true, false])(
    'recovers thread unread errors from accepted WS state (HTTP fails first: %s)',
    async (failsFirst) => {
      TestBed.inject(SessionStore).user.set(testUser);
      const watch = vi.spyOn(TestBed.inject(Connection), 'watchConversationStates');
      await startThreads();
      updatedThread();
      await flushReads();
      const unread = http.expectOne(topicUrl + '/read-state');
      if (failsFirst) {
        unread.flush('', { status: 503, statusText: 'Unavailable' });
        await settle();
        expect(threads.error()).toBe(ChatListError.Unread);
      }
      const payload = {
        requestId: watch.mock.calls.at(-1)![0],
        full: true,
        states: [
          {
            chatId: testChat.id,
            threadId: rootId,
            accessible: true,
            unreadCount: 1,
            unreadMentions: 0,
            unreadReactions: 0,
          },
        ],
      };
      events.next({
        type: ServerWsMessageType.conversationStates,
        payload: { ...payload, requestId: payload.requestId - 1 },
      });
      await settle();
      const metadata = scope.get(ChatStore);
      expect(metadata.threadReadState(testChat.id, rootId)).toBeUndefined();
      if (failsFirst) expect(threads.error()).toBe(ChatListError.Unread);

      events.next({ type: ServerWsMessageType.conversationStates, payload });
      await settle();
      expect(metadata.unreadCount(testChat.id, rootId)).toBe(1);
      expect(threads.error()).toBeUndefined();
      if (!failsFirst) {
        unread.flush('', { status: 503, statusText: 'Unavailable' });
        await settle();
        expect(threads.error()).toBeUndefined();
      }
      metadata.invalidateThreadReads([rootId]);
      expect(threads.error()).toBeUndefined();
    },
  );

  it('retries a failed thread continuation without rereading the head', async () => {
    await startThreads();
    const pending = threads.loadMore();
    await settle();
    http.expectOne(activeThreadsUrl + '&before=older').flush('', { status: 503, statusText: 'Unavailable' });
    await pending;
    expect(threads.error()).toBe(ChatListError.More);
    expect(threads.items()).toHaveLength(1);
    const retry = threads.retry();
    await settle();
    expect(threads.loadingMore()).toBe(true);
    http.expectNone(activeThreadsUrl);
    http.expectOne(activeThreadsUrl + '&before=older').flush({ threads: [] });
    await retry;
    expect(threads.error()).toBeUndefined();
    expect(threads.items()).toHaveLength(1);
    expect(threads.hasMore()).toBe(false);
  });

  function receivedRequest() {
    events.next({ type: ServerWsMessageType.friendRequestReceived, payload: { fromUid: 2 } });
  }

  it.each([false, true])(
    'keeps a failed thread page retryable when unread also fails (unread first: %s)',
    async (unreadFirst) => {
      await startThreads();
      const paging = threads.loadMore();
      await settle();
      updatedThread();
      await flushReads();
      const pageRequest = http.expectOne(activeThreadsUrl + '&before=older');
      const readRequest = http.expectOne(topicUrl + '/read-state');
      for (const request of unreadFirst ? [readRequest, pageRequest] : [pageRequest, readRequest]) {
        request.flush('', { status: 503, statusText: 'Unavailable' });
        await settle();
      }
      await paging;
      expect(threads.listError()).toBe(ChatListError.More);
      expect(threads.error()).toBe(ChatListError.More);
      const retry = threads.retry();
      await settle();
      http.expectNone(activeThreadsUrl);
      http.expectOne(activeThreadsUrl + '&before=older').flush({ threads: [], nextCursor: 'tail' });
      await retry;
      expect(threads.listError()).toBeUndefined();
      expect(threads.error()).toBe(ChatListError.Unread);
      await flushReads();
      http.expectOne(topicUrl + '/read-state').flush({ unreadCount: 3 });
      await settle();
      expect(threads.error()).toBeUndefined();
      const more = threads.loadMore();
      await settle();
      http.expectOne(activeThreadsUrl + '&before=tail').flush({ threads: [] });
      await more;
      expect(threads.hasMore()).toBe(false);
    },
  );

  function updatedThread() {
    events.next({
      type: ServerWsMessageType.threadUpdate,
      payload: {
        chatId: testChat.id,
        threadRootId: rootId,
        replyCount: 3,
        lastReplyAt: testMessage.createdAt,
      },
    });
  }

  function membershipChanged() {
    events.next({
      type: ServerWsMessageType.threadMembershipChanged,
      payload: { chatId: testChat.id, threadRootId: rootId },
    });
  }

  function destroy() {
    scope.destroy();
    disposed = true;
  }

  it('retains event-backed thread pages on foreground and reloads after reconnect', async () => {
    await startThreads();
    const before = threads.items();
    resync.next(ResyncReason.Foreground);
    await settle();
    http.expectNone(() => true);
    expect(threads.items()).toEqual(before);
    resync.next(ResyncReason.Connected);
    await settle();
    http.expectOne(activeThreadsUrl).flush({ threads: [wireThread] });
    await settle();
  });

  it('still calibrates request history on a healthy foreground', async () => {
    await showRequests(true);
    http.expectOne(historyUrl).flush({ requests: [wireRequest] });
    await settle();
    resync.next(ResyncReason.Foreground);
    await settle();
    expect(requests.items()).toEqual([request]);
    http.expectOne(historyUrl).flush({ requests: [] });
    await settle();
    expect(requests.items()).toEqual([]);
  });

  it('loads only activated request queries and reuses their cached results', async () => {
    http.expectNone(() => true);
    await showRequests();
    http.expectOne(activeRequestsUrl).flush(structuredClone({ requests: [wireRequest] }));
    http.expectNone(historyUrl);
    await settle();
    expect(scope.get(ChatListStore)).toBe(inbox);
    expect(inbox.friendRequests(false)).toBe(requests);
    await showRequests();
    http.expectNone(() => true);
    expect(inbox.friendRequests(false).items()).toEqual([request]);
    await showRequests(true);
    http
      .expectOne(historyUrl)
      .flush(structuredClone({ requests: [{ ...wireRequest, status: FriendRequestStatus.archived }] }));
    http.expectNone(activeRequestsUrl);
    await settle();
    expect(inbox.friendRequests(true).items()[0].status).toBe(FriendRequestStatus.archived);
  });

  it('marks hidden request queries dirty and refreshes only the selected one on return', async () => {
    await showRequests();
    http.expectOne(activeRequestsUrl).flush({ requests: [] });
    await settle();
    await showRequests(true);
    http.expectOne(historyUrl).flush({ requests: [] });
    await settle();
    await hideLists();
    receivedRequest();
    resync.next();
    await settle();
    http.expectNone(() => true);
    await showRequests(true);
    http.expectOne(historyUrl).flush(structuredClone({ requests: [wireRequest] }));
    http.expectNone(activeRequestsUrl);
    await settle();
    await showRequests();
    http.expectOne(activeRequestsUrl).flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(inbox.friendRequests(false).items()).toEqual([request]);
  });

  it('coalesces request invalidations and rejects an obsolete in-flight result', async () => {
    await showRequests();
    const old = http.expectOne(activeRequestsUrl);
    for (let i = 0; i < 10; i++) receivedRequest();
    await settle();
    http.expectNone(activeRequestsUrl);
    old.flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(inbox.friendRequests(false).items()).toEqual([]);
    http.expectOne(activeRequestsUrl).flush({ requests: [] });
    await settle();
    expect(requests.loading()).toBe(false);
    expect(requests.error()).toBe(false);
    http.expectNone(historyUrl);
  });

  it('keeps loading and errors with their request query', async () => {
    await showRequests();
    const active = http.expectOne(activeRequestsUrl);
    const keepActive = inbox.friendRequests(false).activate();
    await showRequests(true);
    http.expectOne(historyUrl).flush({ requests: [] });
    await settle();
    active.flush('error', { status: 500, statusText: 'Error' });
    await settle();
    expect(requests.error()).toBe(false);
    expect(requests.loading()).toBe(false);
    keepActive();
    await showRequests();
    http.expectOne(activeRequestsUrl).flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(inbox.friendRequests(false).items()).toEqual([request]);
  });

  it('refreshes after a request conflict while preserving the failed action', async () => {
    await showRequests();
    http.expectOne(activeRequestsUrl).flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    const failed = expect(inbox.decideRequest(request.id, FriendRequestAction.Accept)).rejects.toBeDefined();
    http
      .expectOne('/_api/friends/requests/' + decodeId(request.id) + '/accept')
      .flush('decided', { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne(activeRequestsUrl).flush({ requests: [] });
    await failed;
    expect(inbox.friendRequests(false).items()).toEqual([]);
    expect(refreshChats).not.toHaveBeenCalled();
    http.expectNone(historyUrl);
  });

  it('refreshes chats after acceptance and leaves hidden requests lazy', async () => {
    const accepted = inbox.decideRequest(request.id, FriendRequestAction.Accept);
    http.expectOne('/_api/friends/requests/' + decodeId(request.id) + '/accept').flush(null);
    await accepted;
    expect(refreshChats).toHaveBeenCalledOnce();
    http.expectNone(() => true);
  });

  it('stops background thread reads after leaving and refreshes a dirty list on return', async () => {
    await startThreads();
    await hideLists();
    updatedThread();
    membershipChanged();
    resync.next();
    await settle();
    http.expectNone(() => true);
    await showThreads();
    http.expectOne(activeThreadsUrl).flush(structuredClone({ threads: [{ ...wireThread, replyCount: 3 }] }));
    await settle();
    expect(threads.items()[0].replyCount).toBe(3);
    await showThreads(true);
    http.expectOne(archivedThreadsUrl).flush({ threads: [] });
    await settle();
    http.expectNone(activeRequestsUrl);
    http.expectNone(historyUrl);
  });

  it('exposes cached resume state only while the matching list is fresh', async () => {
    await startThreads();
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)).toEqual({ lastReadMessageId: undefined });
    expect(inbox['chatInfo'].threadReadState(testChat.id, encodeId('200'))).toBeUndefined();
    await hideLists();
    updatedThread();
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)).toBeUndefined();
    http.expectNone(() => true);
  });

  it('coalesces thread bursts into one follow-up read without overlapping requests', async () => {
    await showThreads();
    const old = http.expectOne(activeThreadsUrl);
    for (let i = 0; i < 10; i++) updatedThread();
    await settle();
    http.expectNone(activeThreadsUrl);
    old.flush(structuredClone({ threads: [wireThread] }));
    await settle();
    expect(threads.items()).toEqual([]);
    http.expectOne(activeThreadsUrl).flush(structuredClone({ threads: [{ ...wireThread, replyCount: 3 }] }));
    await settle();
    expect(threads.items()[0].replyCount).toBe(3);
    expect(threads.loading()).toBe(false);
  });

  it('isolates late active pages from the archive query and its subscription state', async () => {
    await startThreads();
    const keepActive = inbox.threads(false).activate();
    const loading = threads.loadMore();
    await settle();
    const old = http.expectOne(activeThreadsUrl + '&before=older');
    await showThreads(true);
    http.expectOne(archivedThreadsUrl).flush(structuredClone({ threads: [{ ...wireThread, archived: true }] }));
    await settle();
    old.flush(structuredClone({ threads: [wireThread], nextCursor: 'stale' }));
    await loading;
    expect(threads.items()).toHaveLength(1);
    expect(threads.items()[0].archived).toBe(true);
    expect(threads.hasMore()).toBe(false);
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    keepActive();
  });

  it('patches a known thread and refreshes only its read state while paging keeps its cursor', async () => {
    await startThreads();
    const loading = threads.loadMore();
    await settle();
    const old = http.expectOne(activeThreadsUrl + '&before=older');
    updatedThread();
    old.flush(
      structuredClone({
        threads: [{ ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } }],
        nextCursor: 'tail',
      }),
    );
    await loading;
    await flushReads();
    http.expectOne(topicUrl + '/read-state').flush({ unreadCount: 3, unreadMentions: 1, unreadReactions: 0 });
    await settle();
    http.expectNone(activeThreadsUrl);
    expect(threads.items().map((item) => item.threadRootMessage.id)).toEqual([rootId, encodeId('99')]);
    expect(threads.items()[0].replyCount).toBe(3);
    expect(threads.items()[0].unreadCount).toBe(3);
    expect(threads.hasMore()).toBe(true);
    expect(threads.loadingMore()).toBe(false);
  });

  it('updates a hidden thread preview from a reply without a request or activation', async () => {
    await startThreads();
    await hideLists();
    const store = scope.get(ChatStore);
    const version = store.snapshot();
    const subscriptionVersion = store.subscriptionSnapshot();
    const reply = { ...testMessage, replyRootId: rootId, createdAt: '2026-09-06T12:00:00Z', message: '实时话题回复' };
    messages.next(reply);
    expect(threads.items()[0].lastReply?.message).toBe(reply.message);
    expect(threads.items()[0].lastReplyAt).toBe(reply.createdAt);
    // A list response started before the message cannot restore the old preview.
    store.acceptThreads([thread], version, subscriptionVersion);
    messages.next({ ...reply, id: encodeId('9007199254741002'), message: '旧回复' });
    messages.next(reply);
    await settle();
    expect(threads.items()[0].lastReply?.message).toBe(reply.message);
    expect(threads.items()[0].lastReplyAt).toBe(reply.createdAt);
    http.expectNone(() => true);
  });

  it('coalesces replies into one targeted read and defers hidden rows until activation', async () => {
    await startThreads();
    const reply = { ...testMessage, replyRootId: rootId };
    TestBed.inject(Connection).accept(reply);
    messages.next(reply);
    await flushReads();
    http.expectOne(topicUrl + '/read-state').flush({ unreadCount: 3, unreadMentions: 1, unreadReactions: 0 });
    await settle();
    http.expectNone(activeThreadsUrl);
    await hideLists();
    messages.next({ ...reply, id: encodeId('9007199254741004') });
    await flushReads();
    http.expectNone(() => true);
    await showThreads();
    await flushReads();
    http.expectOne(topicUrl + '/read-state').flush({ unreadCount: 4, unreadMentions: 1, unreadReactions: 0 });
    await settle();
    http.expectNone(activeThreadsUrl);
  });

  it('updates a topic root immediately and rejects a list snapshot from before the edit', async () => {
    await startThreads();
    void threads.refresh();
    await settle();
    const stale = http.expectOne(activeThreadsUrl);
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, id: rootId, message: '修改后的话题', isEdited: true },
    });
    expect(threads.items()[0].threadRootMessage.message).toBe('修改后的话题');
    stale.flush(structuredClone({ threads: [wireThread] }));
    await settle();
    expect(threads.items()[0].threadRootMessage.message).toBe('修改后的话题');
    http.expectNone(activeThreadsUrl);
    await settle();
    expect(threads.items()[0].threadRootMessage.message).toBe('修改后的话题');
    expect(refreshChats).not.toHaveBeenCalled();
  });

  it('withdraws the latest reply immediately while keeping unread counts authoritative', async () => {
    await showThreads();
    http.expectOne(activeThreadsUrl).flush(structuredClone({ threads: [{ ...wireThread, lastReply: wireMessage }] }));
    await settle();
    events.next({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...testMessage, replyRootId: rootId, isDeleted: true, message: undefined, attachments: [] },
    });
    expect(threads.items()[0]).toMatchObject({ lastReply: { isDeleted: true }, unreadCount: 2 });
    await settle();
    http.expectOne(`/_api/threads?limit=1&archived=false&rootId=${decodeId(rootId)}`).flush(
      structuredClone({
        threads: [{ ...wireThread, lastReply: { ...wireMessage, isDeleted: true }, unreadCount: 1 }],
      }),
    );
    await settle();
    expect(threads.items()[0]).toMatchObject({ lastReply: { isDeleted: true }, unreadCount: 1 });
  });

  it('coalesces bulk changes and patches both cached topic summaries while hidden lists stay lazy', async () => {
    await showThreads();
    const original = { ...wireThread, lastReply: wireMessage };
    http.expectOne(activeThreadsUrl).flush(structuredClone({ threads: [original] }));
    await settle();
    await showThreads(true);
    http.expectOne(archivedThreadsUrl).flush(structuredClone({ threads: [{ ...original, archived: true }] }));
    await settle();
    const change = {
      type: ServerWsMessageType.messagesBulkDeleted as const,
      payload: { chatId: testChat.id, messageIds: [rootId, testMessage.id] },
    };
    const updates = TestBed.inject(Connection);
    updates.acceptChange(change);
    updates.acceptChange(change);
    expect(threads.items()[0]).toMatchObject({
      threadRootMessage: { isDeleted: true, attachments: [], mentions: [] },
      lastReply: { isDeleted: true, attachments: [], mentions: [] },
      unreadCount: 2,
    });
    await settle();
    http.expectNone(activeThreadsUrl);
    http.expectOne(`/_api/threads?limit=1&archived=true&rootId=${decodeId(rootId)}`).flush(
      structuredClone({
        threads: [
          {
            ...original,
            archived: true,
            threadRootMessage: { ...original.threadRootMessage, isDeleted: true },
            lastReply: { ...wireMessage, isDeleted: true },
            unreadCount: 0,
          },
        ],
      }),
    );
    await settle();
    expect(threads.items()[0].unreadCount).toBe(0);
    await showThreads();
    http.expectOne(`/_api/threads?limit=1&archived=false&rootId=${decodeId(rootId)}`).flush({ threads: [] });
    await settle();
    expect(threads.items()).toEqual([]);
  });

  it('ignores reactions and does not read changed topics while their lists are hidden', async () => {
    await startThreads();
    events.next({
      type: ServerWsMessageType.reactionUpdated,
      payload: { chatId: testChat.id, messageId: rootId, reactions: [] },
    });
    await settle();
    http.expectNone(() => true);
    await hideLists();
    events.next({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...testMessage, id: rootId, isDeleted: true },
    });
    expect(threads.items()[0].threadRootMessage.isDeleted).toBe(true);
    await settle();
    http.expectNone(() => true);
    await showThreads();
    http.expectOne(`/_api/threads?limit=1&archived=false&rootId=${decodeId(rootId)}`).flush({ threads: [] });
    await settle();
    expect(threads.items()).toEqual([]);
  });

  it('reuses list subscription state but can load a deep-linked topic independently', async () => {
    await startThreads();
    await inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    http.expectNone(topicUrl + '/subscribe');
    const other = encodeId('200');
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, other);
    http
      .expectOne('/_api/chats/' + decodeId(testChat.id) + '/threads/200/subscribe')
      .flush({ subscribed: false, archived: false });
    await loading;
    expect(inbox['chatInfo'].subscription(testChat.id, other)).toEqual({ subscribed: false, archived: false });
    expect(threads.items()).toHaveLength(1);
  });

  it('shares subscription requests and exposes failures so the page can retry', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    expect(inbox['chatInfo'].loadSubscription(testChat.id, rootId)).toBe(loading);
    const failed = expect(loading).rejects.toBeDefined();
    http.expectOne(topicUrl + '/subscribe').flush('error', { status: 500, statusText: 'Error' });
    await failed;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toBeUndefined();
    const retry = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    http.expectOne(topicUrl + '/subscribe').flush({ subscribed: false, archived: true });
    await retry;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: true });
  });

  it('applies explicit subscription snapshots without fetching subscription status', async () => {
    await startThreads();
    await hideLists();
    events.next({
      type: ServerWsMessageType.threadMembershipChanged,
      payload: {
        chatId: testChat.id,
        threadRootId: rootId,
        status: { subscribed: false, archived: true },
      },
    });
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: true });
    messages.next({ ...testMessage, id: encodeId('203'), replyRootId: rootId });
    await settle();
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: true });
    http.expectNone(() => true);
  });

  it('invalidates subscription state on membership changes and reconnect without hidden reads', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    http.expectOne(topicUrl + '/subscribe').flush({ subscribed: true, archived: false });
    await loading;
    membershipChanged();
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toBeUndefined();
    http.expectNone(() => true);
    const refresh = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    const stale = http.expectOne(topicUrl + '/subscribe');
    resync.next();
    stale.flush({ subscribed: true, archived: false });
    await settle();
    http.expectOne(topicUrl + '/subscribe').flush({ subscribed: false, archived: true });
    await refresh;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: true });
  });

  it('keeps a newer list subscription when an older subscription read completes', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    const old = http.expectOne(topicUrl + '/subscribe');
    await startThreads();
    old.flush({ subscribed: false, archived: true });
    await loading;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: false });
  });

  it('keeps a newer subscription read when an older list response completes', async () => {
    await showThreads();
    const old = http.expectOne(activeThreadsUrl);
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    http.expectOne(topicUrl + '/subscribe').flush({ subscribed: false, archived: true });
    await loading;
    old.flush(structuredClone({ threads: [wireThread] }));
    await settle();
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: true });
    expect(threads.items()).toEqual([]);
  });

  it('preserves archive state when subscribing and preserves subscription state when archiving', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    http.expectOne(topicUrl + '/subscribe').flush({ subscribed: false, archived: true });
    await loading;
    const archiving = inbox['chatInfo'].setThreadArchived(testChat.id, rootId, false);
    http.expectOne(topicUrl + '/archive').flush(null);
    await archiving;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: false });
    const archiveAgain = inbox['chatInfo'].setThreadArchived(testChat.id, rootId, true);
    http.expectOne(topicUrl + '/archive').flush(null);
    await archiveAgain;
    const subscribing = inbox['chatInfo'].subscribeThread(testChat.id, rootId);
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    http.expectOne(topicUrl + '/subscribe').flush(null);
    await subscribing;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    expect(refreshCounts).not.toHaveBeenCalled();
    http.expectNone(() => true);
  });

  it('reads authoritative subscription state when a command lacks the other field', async () => {
    const subscribing = inbox['chatInfo'].subscribeThread(testChat.id, rootId);
    http.expectOne(topicUrl + '/subscribe').flush(null);
    await settle();
    const status = http.expectOne(topicUrl + '/subscribe');
    expect(status.request.method).toBe('GET');
    status.flush({ subscribed: true, archived: true });
    await subscribing;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    http.expectNone(activeThreadsUrl);
  });

  it('coalesces topic reads and preserves their result over an older list response', async () => {
    await startThreads();
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('101'));
    expect(inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'))).toBe(reading);
    void threads.refresh();
    await settle();
    const stale = http.expectOne(activeThreadsUrl);
    await vi.advanceTimersByTimeAsync(1000);
    const read = http.expectOne(topicUrl + '/read');
    expect(read.request.body).toEqual({ messageId: '102' });
    read.flush({ lastReadMessageId: '102', unreadCount: 0 });
    await settle();
    expect(threads.items()[0].unreadCount).toBe(0);
    stale.flush(structuredClone({ threads: [wireThread] }));
    await settle();

    await reading;
    expect(threads.items()[0].lastReadMessageId).toBe(encodeId('102'));
    http.expectNone('/_api/chats/' + decodeId(testChat.id) + '/read');
  });

  it('reconciles a late read response after a newer reply was already listed', async () => {
    await startThreads();
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    const delayed = http.expectOne(topicUrl + '/read');
    updatedThread();
    await settle();
    await flushReads();
    http
      .expectOne(topicUrl + '/read-state')
      .flush({ lastReadMessageId: '102', unreadCount: 1, unreadMentions: 0, unreadReactions: 0 });
    await settle();
    delayed.flush({ lastReadMessageId: '102', unreadCount: 0 });
    await settle();

    await reading;
    expect(threads.items()[0].unreadCount).toBe(1);
  });

  it('cancels list reads, subscription reads and deferred read receipts on destruction', async () => {
    await showThreads();
    const list = http.expectOne(activeThreadsUrl);
    const subscription = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    const status = http.expectOne(topicUrl + '/subscribe');
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    destroy();
    expect(list.cancelled).toBe(true);
    expect(status.cancelled).toBe(true);
    updatedThread();
    resync.next();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([reading, subscription]);
    http.expectNone(() => true);
    expect(refreshCounts).not.toHaveBeenCalled();
  });

  it('cancels an in-flight read without sending its queued higher watermark after destruction', async () => {
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('101'));
    await vi.advanceTimersByTimeAsync(1000);
    const read = http.expectOne(topicUrl + '/read');
    inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    destroy();
    expect(read.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await reading;
    http.expectNone(() => true);
  });

  it('shares request activation and cancels only after the last consumer leaves', async () => {
    const query = inbox.friendRequests(false);
    const first = query.activate();
    const second = query.activate();
    await settle();
    const old = http.expectOne(activeRequestsUrl);
    first();
    first();
    expect(old.cancelled).toBe(false);
    second();
    expect(old.cancelled).toBe(true);
    expect(query.loading()).toBe(false);
    const returned = query.activate();
    await settle();
    expect(query.loading()).toBe(true);
    http.expectOne(activeRequestsUrl).flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(query.items()).toEqual([request]);
    expect(query.error()).toBe(false);
    returned();
  });

  it('cancels paging on the last release and restarts with a fresh first page', async () => {
    await startThreads();
    const query = inbox.threads(false);
    const second = query.activate();
    const paging = query.loadMore();
    await settle();
    const old = http.expectOne(activeThreadsUrl + '&before=older');
    await hideLists();
    expect(old.cancelled).toBe(false);
    second();
    expect(old.cancelled).toBe(true);
    expect(query.loadingMore()).toBe(false);
    const returned = query.activate();
    await settle();
    expect(query.loading()).toBe(true);
    http.expectOne(activeThreadsUrl).flush(structuredClone({ threads: [wireThread] }));
    await paging;
    await settle();
    expect(query.error()).toBeUndefined();
    expect(query.hasMore()).toBe(false);
    returned();
  });

  it('finds resume state by ID across fresh caches and preserves known-empty read state', async () => {
    await showThreads();
    http.expectOne(activeThreadsUrl).flush(structuredClone({ threads: [{ ...wireThread, lastReadMessageId: '101' }] }));
    await settle();
    await showThreads(true);
    http.expectOne(archivedThreadsUrl).flush(
      structuredClone({
        threads: [{ ...wireThread, archived: true, threadRootMessage: { ...wireThread.threadRootMessage, id: '200' } }],
      }),
    );
    await settle();
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)).toEqual({ lastReadMessageId: encodeId('101') });
    expect(inbox['chatInfo'].threadReadState(testChat.id, encodeId('200'))).toEqual({ lastReadMessageId: undefined });
    expect(inbox['chatInfo'].threadReadState(encodeId('999'), rootId)).toBeUndefined();
    await hideLists();
    updatedThread();
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)).toBeUndefined();
    expect(inbox['chatInfo'].threadReadState(testChat.id, encodeId('200'))).toEqual({ lastReadMessageId: undefined });
    http.expectNone(() => true);
  });

  it('keeps an authoritative read result when returning to an older cached archive', async () => {
    await startThreads();
    await showThreads(true);
    const old = http.expectOne(archivedThreadsUrl);
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    http.expectOne(topicUrl + '/read').flush({ lastReadMessageId: '102', unreadCount: 0 });
    await settle();
    old.flush(structuredClone({ threads: [{ ...wireThread, archived: true }] }));
    await settle();

    await reading;
    expect(threads.items()[0].unreadCount).toBe(0);
    await hideLists();
    const unarchiving = inbox['chatInfo'].setThreadArchived(testChat.id, rootId, false);
    http.expectOne(topicUrl + '/archive').flush(null);
    await unarchiving;
    const cached = inbox.threads(false).items()[0];
    expect(cached.lastReadMessageId).toBe(encodeId('102'));
    expect(cached.unreadCount).toBe(0);
    http.expectNone(activeThreadsUrl);
  });
  it('refreshes a mention on a deep loaded row without reading any list pages', async () => {
    await startThreads();
    const older = { ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } };
    const paging = threads.loadMore();
    await settle();
    http.expectOne(activeThreadsUrl + '&before=older').flush({ threads: [older], nextCursor: 'tail' });
    await paging;
    for (let i = 0; i < 3; i++)
      events.next({
        type: ServerWsMessageType.notification,
        payload: {
          chatId: testChat.id,
          threadRootId: encodeId('99'),
          messageId: testMessage.id,
          actorUid: 2,
          notificationType: NotificationType.mention,
        },
      });
    await flushReads();
    http
      .expectOne('/_api/chats/' + decodeId(testChat.id) + '/threads/99/read-state')
      .flush({ unreadCount: 3, unreadMentions: 1, unreadReactions: 0 });
    await settle();
    expect(threads.items()).toHaveLength(2);
    expect(threads.items()[1].unreadMentions).toBe(1);
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)).toBeDefined();
    http.expectNone((request) => request.url === '/_api/threads');
  });

  it('adds a new live thread from the head without reloading deeper pages or changing the tail cursor', async () => {
    await startThreads();
    const paging = threads.loadMore();
    await settle();
    http.expectOne(activeThreadsUrl + '&before=older').flush(
      structuredClone({
        threads: [{ ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } }],
        nextCursor: 'tail',
      }),
    );
    await paging;
    messages.next({ ...testMessage, id: encodeId('203'), replyRootId: encodeId('200') });
    await flushReads();
    http.expectNone((request) => request.url === '/_api/threads');
    events.next({
      type: ServerWsMessageType.threadUpdate,
      payload: {
        chatId: testChat.id,
        threadRootId: encodeId('200'),
        replyCount: 1,
        lastReplyAt: testMessage.createdAt,
      },
    });
    await flushReads();
    http.expectOne(activeThreadsUrl).flush(
      structuredClone({
        threads: [{ ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '200' } }, wireThread],
        nextCursor: 'older',
      }),
    );
    await settle();
    expect(threads.items()).toHaveLength(3);
    http.expectNone(activeThreadsUrl + '&before=older');
    const more = threads.loadMore();
    await settle();
    http.expectOne(activeThreadsUrl + '&before=tail').flush({ threads: [] });
    await more;
  });

  it('refreshes the loaded topic depth without shrinking to the first page', async () => {
    await startThreads();
    const olderThread = { ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } };
    const more = threads.loadMore();
    await settle();
    http.expectOne(activeThreadsUrl + '&before=older').flush({ threads: [olderThread], nextCursor: 'tail' });
    await more;
    const refreshing = threads.refresh();
    await settle();
    http
      .expectOne(activeThreadsUrl)
      .flush(structuredClone({ threads: [{ ...wireThread, replyCount: 5 }], nextCursor: 'older' }));
    await settle();
    expect(threads.items()).toHaveLength(2);
    http.expectOne(activeThreadsUrl + '&before=older').flush({ threads: [olderThread], nextCursor: 'tail' });
    await refreshing;
    expect(threads.items()).toHaveLength(2);
    expect(threads.items()[0].replyCount).toBe(5);
    expect(threads.hasMore()).toBe(true);
  });

  it('patches a root summary without reloading lists and ignores unrelated chat edits', async () => {
    await startThreads();
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, id: rootId, message: 'Edited root' },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, id: encodeId('999'), message: 'Unrelated edit' },
    });
    await settle();
    expect(threads.items()[0].threadRootMessage.message).toBe('Edited root');
    http.expectNone(() => true);
  });
  it('shares a settled read result and deduplicates repeated reads', async () => {
    await startThreads();
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    http.expectOne(topicUrl + '/read').flush({ lastReadMessageId: '102', unreadCount: 0 });
    await reading;
    expect(threads.items()[0].unreadCount).toBe(0);
    await inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    http.expectNone(topicUrl + '/read');
  });

  it('keeps the newer read and subscription state after an older overlapping list finishes', async () => {
    await showThreads();
    const old = http.expectOne(activeThreadsUrl);
    const releaseArchive = inbox.threads(true).activate();
    await settle();
    http.expectOne(archivedThreadsUrl).flush(
      structuredClone({
        threads: [{ ...wireThread, archived: true, lastReadMessageId: '102', unreadCount: 1 }],
      }),
    );
    await settle();
    old.flush(structuredClone({ threads: [wireThread] }));
    await settle();
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)?.lastReadMessageId).toBe(encodeId('102'));
    expect(inbox.threads(true).items()[0].unreadCount).toBe(1);
    expect(threads.items()).toEqual([]);
    releaseArchive();
  });

  it('accepts a later list snapshot after reading an unlisted thread', async () => {
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    http.expectOne(topicUrl + '/read').flush({ lastReadMessageId: '102', unreadCount: 0 });
    await reading;
    await showThreads();
    http
      .expectOne(activeThreadsUrl)
      .flush(structuredClone({ threads: [{ ...wireThread, lastReadMessageId: '102', unreadCount: 1 }] }));
    await settle();
    expect(threads.items()[0].unreadCount).toBe(1);
  });
  it('rolls back a failed optimistic thread archive without changing subscription', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    http.expectOne(topicUrl + '/subscribe').flush({ subscribed: true, archived: false });
    await loading;
    const operation = inbox['chatInfo'].setThreadArchived(testChat.id, rootId, true);
    const failed = expect(operation).rejects.toBeDefined();
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    http.expectOne(topicUrl + '/archive').flush('offline', { status: 500, statusText: 'Error' });
    await failed;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: false });
  });
});
