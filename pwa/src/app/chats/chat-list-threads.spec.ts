import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
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
import { RpcErrorCode } from '../api/rpc-error';
import { RpcTestPeer, provideRpcTesting } from '../api/rpc-testing';
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
const threadParams = (extra: Record<string, unknown> = {}) => ({
  chatId: wireChat.id,
  threadRootId: decodeId(rootId),
  ...extra,
});
const listThreadsParams = (archived = false, before?: string, rootId?: string) => ({
  limit: rootId ? 1 : 20,
  archived,
  ...(before ? { before } : {}),
  ...(rootId ? { rootId } : {}),
});

describe('ChatListStore threads and friend requests', () => {
  let inbox: ChatListStore;
  let peer: RpcTestPeer;
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
        provideRpcTesting(),
        { provide: Connection, useValue: mockRealtime({ messages$: messages, events$: events, resync$: resync }) },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    scope = createEnvironmentInjector([ChatListStore, ChatStore], TestBed.inject(EnvironmentInjector));
    disposed = false;
    inbox = scope.get(ChatListStore);
    refreshChats = vi.spyOn(inbox, 'refreshChats');
    refreshCounts = vi.spyOn(inbox.viewUnread, 'refresh');
    requests = inbox.friendRequests(false);
    threads = inbox.threads(false);
    releaseList = () => {};
    TestBed.tick();
  });

  afterEach(() => {
    try {
      if (!disposed) scope.destroy();
      peer.verify();
    } finally {
      vi.useRealTimers();
      TestBed.resetTestingModule();
    }
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
    peer
      .expect('threads.list', listThreadsParams())
      .flush(structuredClone({ threads: [wireThread], nextCursor: 'older' }));
    await settle();
  }

  it.each([true, false])(
    'recovers thread unread errors from accepted WS state (RPC fails first: %s)',
    async (failsFirst) => {
      TestBed.inject(SessionStore).user.set(testUser);
      const watch = vi.spyOn(TestBed.inject(Connection), 'watchConversationStates');
      await startThreads();
      updatedThread();
      await flushReads();
      const unread = peer.expect('threads.getReadState', threadParams());
      if (failsFirst) {
        unread.error(RpcErrorCode.Unavailable);
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
        unread.error(RpcErrorCode.Unavailable);
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
    peer.expect('threads.list', listThreadsParams(false, 'older')).error(RpcErrorCode.Unavailable);
    await pending;
    expect(threads.error()).toBe(ChatListError.More);
    expect(threads.items()).toHaveLength(1);
    const retry = threads.retry();
    await settle();
    expect(threads.loadingMore()).toBe(true);
    peer.expect('threads.list', listThreadsParams(false, 'older')).flush({ threads: [] });
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
      const pageRequest = peer.expect('threads.list', listThreadsParams(false, 'older'));
      const readRequest = peer.expect('threads.getReadState', threadParams());
      for (const request of unreadFirst ? [readRequest, pageRequest] : [pageRequest, readRequest]) {
        request.error(RpcErrorCode.Unavailable);
        await settle();
      }
      await paging;
      expect(threads.listError()).toBe(ChatListError.More);
      expect(threads.error()).toBe(ChatListError.More);
      const retry = threads.retry();
      await settle();
      peer.expect('threads.list', listThreadsParams(false, 'older')).flush({ threads: [], nextCursor: 'tail' });
      await retry;
      expect(threads.listError()).toBeUndefined();
      expect(threads.error()).toBe(ChatListError.Unread);
      await flushReads();
      peer.expect('threads.getReadState', threadParams()).flush({ unreadCount: 3 });
      await settle();
      expect(threads.error()).toBeUndefined();
      const more = threads.loadMore();
      await settle();
      peer.expect('threads.list', listThreadsParams(false, 'tail')).flush({ threads: [] });
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
    peer.verify();
    expect(threads.items()).toEqual(before);
    resync.next(ResyncReason.Connected);
    await settle();
    peer.expect('threads.list', listThreadsParams()).flush({ threads: [wireThread] });
    await settle();
  });

  it('still calibrates request history on a healthy foreground', async () => {
    await showRequests(true);
    peer.expect('friends.listRequests', { archived: true }).flush({ requests: [wireRequest] });
    await settle();
    resync.next(ResyncReason.Foreground);
    await settle();
    expect(requests.items()).toEqual([request]);
    peer.expect('friends.listRequests', { archived: true }).flush({ requests: [] });
    await settle();
    expect(requests.items()).toEqual([]);
  });

  it('loads only activated request queries and reuses their cached results', async () => {
    peer.verify();
    await showRequests();
    peer.expect('friends.listRequests', { archived: false }).flush(structuredClone({ requests: [wireRequest] }));
    peer.expectNone('friends.listRequests');
    await settle();
    expect(scope.get(ChatListStore)).toBe(inbox);
    expect(inbox.friendRequests(false)).toBe(requests);
    await showRequests();
    peer.verify();
    expect(inbox.friendRequests(false).items()).toEqual([request]);
    await showRequests(true);
    peer
      .expect('friends.listRequests', { archived: true })
      .flush(structuredClone({ requests: [{ ...wireRequest, status: FriendRequestStatus.archived }] }));
    peer.expectNone('friends.listRequests');
    await settle();
    expect(inbox.friendRequests(true).items()[0].status).toBe(FriendRequestStatus.archived);
  });

  it('marks hidden request queries dirty and refreshes only the selected one on return', async () => {
    await showRequests();
    peer.expect('friends.listRequests', { archived: false }).flush({ requests: [] });
    await settle();
    await showRequests(true);
    peer.expect('friends.listRequests', { archived: true }).flush({ requests: [] });
    await settle();
    await hideLists();
    receivedRequest();
    resync.next();
    await settle();
    peer.verify();
    await showRequests(true);
    peer.expect('friends.listRequests', { archived: true }).flush(structuredClone({ requests: [wireRequest] }));
    peer.expectNone('friends.listRequests');
    await settle();
    await showRequests();
    peer.expect('friends.listRequests', { archived: false }).flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(inbox.friendRequests(false).items()).toEqual([request]);
  });

  it('coalesces request invalidations and rejects an obsolete in-flight result', async () => {
    await showRequests();
    const old = peer.expect('friends.listRequests', { archived: false });
    for (let i = 0; i < 10; i++) receivedRequest();
    await settle();
    peer.expectNone('friends.listRequests');
    old.flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(inbox.friendRequests(false).items()).toEqual([]);
    peer.expect('friends.listRequests', { archived: false }).flush({ requests: [] });
    await settle();
    expect(requests.loading()).toBe(false);
    expect(requests.error()).toBe(false);
    peer.expectNone('friends.listRequests');
  });

  it('keeps loading and errors with their request query', async () => {
    await showRequests();
    const active = peer.expect('friends.listRequests', { archived: false });
    const keepActive = inbox.friendRequests(false).activate();
    await showRequests(true);
    peer.expect('friends.listRequests', { archived: true }).flush({ requests: [] });
    await settle();
    active.error(RpcErrorCode.Internal);
    await settle();
    expect(requests.error()).toBe(false);
    expect(requests.loading()).toBe(false);
    keepActive();
    await showRequests();
    peer.expect('friends.listRequests', { archived: false }).flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(inbox.friendRequests(false).items()).toEqual([request]);
  });

  it('refreshes after a request conflict while preserving the failed action', async () => {
    await showRequests();
    peer.expect('friends.listRequests', { archived: false }).flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    const failed = expect(inbox.decideRequest(request.id, FriendRequestAction.Accept)).rejects.toBeDefined();
    peer.expect('friends.acceptRequest', { requestId: decodeId(request.id) }).error(RpcErrorCode.Conflict);
    await settle();
    peer.expect('friends.listRequests', { archived: false }).flush({ requests: [] });
    await failed;
    expect(inbox.friendRequests(false).items()).toEqual([]);
    expect(refreshChats).not.toHaveBeenCalled();
    peer.expectNone('friends.listRequests');
  });

  it('refreshes chats after acceptance and leaves hidden requests lazy', async () => {
    const accepted = inbox.decideRequest(request.id, FriendRequestAction.Accept);
    peer.expect('friends.acceptRequest', { requestId: decodeId(request.id) }).flush(null);
    await accepted;
    expect(refreshChats).toHaveBeenCalledOnce();
    peer.verify();
  });

  it('stops background thread reads after leaving and refreshes a dirty list on return', async () => {
    await startThreads();
    await hideLists();
    updatedThread();
    membershipChanged();
    resync.next();
    await settle();
    peer.verify();
    await showThreads();
    peer
      .expect('threads.list', listThreadsParams())
      .flush(structuredClone({ threads: [{ ...wireThread, replyCount: 3 }] }));
    await settle();
    expect(threads.items()[0].replyCount).toBe(3);
    await showThreads(true);
    peer.expect('threads.list', listThreadsParams(true)).flush({ threads: [] });
    await settle();
    peer.expectNone('friends.listRequests');
    peer.expectNone('friends.listRequests');
  });

  it('exposes cached resume state only while the matching list is fresh', async () => {
    await startThreads();
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)).toEqual({ lastReadMessageId: undefined });
    expect(inbox['chatInfo'].threadReadState(testChat.id, encodeId('200'))).toBeUndefined();
    await hideLists();
    updatedThread();
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)).toBeUndefined();
    peer.verify();
  });

  it('coalesces thread bursts into one follow-up read without overlapping requests', async () => {
    await showThreads();
    const old = peer.expect('threads.list', listThreadsParams());
    for (let i = 0; i < 10; i++) updatedThread();
    await settle();
    peer.expectNone('threads.list');
    old.flush(structuredClone({ threads: [wireThread] }));
    await settle();
    expect(threads.items()).toEqual([]);
    peer
      .expect('threads.list', listThreadsParams())
      .flush(structuredClone({ threads: [{ ...wireThread, replyCount: 3 }] }));
    await settle();
    expect(threads.items()[0].replyCount).toBe(3);
    expect(threads.loading()).toBe(false);
  });

  it('isolates late active pages from the archive query and its subscription state', async () => {
    await startThreads();
    const keepActive = inbox.threads(false).activate();
    const loading = threads.loadMore();
    await settle();
    const old = peer.expect('threads.list', listThreadsParams(false, 'older'));
    await showThreads(true);
    peer
      .expect('threads.list', listThreadsParams(true))
      .flush(structuredClone({ threads: [{ ...wireThread, archived: true }] }));
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
    const old = peer.expect('threads.list', listThreadsParams(false, 'older'));
    updatedThread();
    old.flush(
      structuredClone({
        threads: [{ ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } }],
        nextCursor: 'tail',
      }),
    );
    await loading;
    await flushReads();
    peer
      .expect('threads.getReadState', threadParams())
      .flush({ unreadCount: 3, unreadMentions: 1, unreadReactions: 0 });
    await settle();
    peer.expectNone('threads.list');
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
    peer.verify();
  });

  it('coalesces replies into one targeted read and defers hidden rows until activation', async () => {
    await startThreads();
    const reply = { ...testMessage, replyRootId: rootId };
    TestBed.inject(Connection).accept(reply);
    messages.next(reply);
    await flushReads();
    peer
      .expect('threads.getReadState', threadParams())
      .flush({ unreadCount: 3, unreadMentions: 1, unreadReactions: 0 });
    await settle();
    peer.expectNone('threads.list');
    await hideLists();
    messages.next({ ...reply, id: encodeId('9007199254741004') });
    await flushReads();
    peer.verify();
    await showThreads();
    await flushReads();
    peer
      .expect('threads.getReadState', threadParams())
      .flush({ unreadCount: 4, unreadMentions: 1, unreadReactions: 0 });
    await settle();
    peer.expectNone('threads.list');
  });

  it('updates a topic root immediately and rejects a list snapshot from before the edit', async () => {
    await startThreads();
    void threads.refresh();
    await settle();
    const stale = peer.expect('threads.list', listThreadsParams());
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, id: rootId, message: '修改后的话题', isEdited: true },
    });
    expect(threads.items()[0].threadRootMessage.message).toBe('修改后的话题');
    stale.flush(structuredClone({ threads: [wireThread] }));
    await settle();
    expect(threads.items()[0].threadRootMessage.message).toBe('修改后的话题');
    peer.expectNone('threads.list');
    await settle();
    expect(threads.items()[0].threadRootMessage.message).toBe('修改后的话题');
    expect(refreshChats).not.toHaveBeenCalled();
  });

  it('withdraws the latest reply immediately while keeping unread counts authoritative', async () => {
    await showThreads();
    peer
      .expect('threads.list', listThreadsParams())
      .flush(structuredClone({ threads: [{ ...wireThread, lastReply: wireMessage }] }));
    await settle();
    events.next({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...testMessage, replyRootId: rootId, isDeleted: true, message: undefined, attachments: [] },
    });
    expect(threads.items()[0]).toMatchObject({ lastReply: { isDeleted: true }, unreadCount: 2 });
    await settle();
    peer.expect('threads.list', listThreadsParams(false, undefined, decodeId(rootId))).flush(
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
    peer.expect('threads.list', listThreadsParams()).flush(structuredClone({ threads: [original] }));
    await settle();
    await showThreads(true);
    peer
      .expect('threads.list', listThreadsParams(true))
      .flush(structuredClone({ threads: [{ ...original, archived: true }] }));
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
    peer.expect('threads.list', listThreadsParams(true, undefined, decodeId(rootId))).flush(
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
    peer.expect('threads.list', listThreadsParams(false, undefined, decodeId(rootId))).flush({ threads: [] });
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
    peer.verify();
    await hideLists();
    events.next({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...testMessage, id: rootId, isDeleted: true },
    });
    expect(threads.items()[0].threadRootMessage.isDeleted).toBe(true);
    await settle();
    peer.verify();
    await showThreads();
    peer.expect('threads.list', listThreadsParams(false, undefined, decodeId(rootId))).flush({ threads: [] });
    await settle();
    expect(threads.items()).toEqual([]);
  });

  it('reuses list subscription state but can load a deep-linked topic independently', async () => {
    await startThreads();
    await inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    peer.expectNone('threads.getSubscriptionStatus');
    const other = encodeId('200');
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, other);
    peer
      .expect('threads.getSubscriptionStatus', threadParams({ threadRootId: '200' }))
      .flush({ subscribed: false, archived: false });
    await loading;
    expect(inbox['chatInfo'].subscription(testChat.id, other)).toEqual({ subscribed: false, archived: false });
    expect(threads.items()).toHaveLength(1);
  });

  it('shares subscription requests and exposes failures so the page can retry', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    expect(inbox['chatInfo'].loadSubscription(testChat.id, rootId)).toBe(loading);
    const failed = expect(loading).rejects.toBeDefined();
    peer.expect('threads.getSubscriptionStatus', threadParams()).error(RpcErrorCode.Internal);
    await failed;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toBeUndefined();
    const retry = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    peer.expect('threads.getSubscriptionStatus', threadParams()).flush({ subscribed: false, archived: true });
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
    peer.verify();
  });

  it('invalidates subscription state on membership changes and reconnect without hidden reads', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    peer.expect('threads.getSubscriptionStatus', threadParams()).flush({ subscribed: true, archived: false });
    await loading;
    membershipChanged();
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toBeUndefined();
    peer.verify();
    const refresh = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    const stale = peer.expect('threads.getSubscriptionStatus', threadParams());
    resync.next();
    stale.flush({ subscribed: true, archived: false });
    await settle();
    peer.expect('threads.getSubscriptionStatus', threadParams()).flush({ subscribed: false, archived: true });
    await refresh;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: true });
  });

  it('keeps a newer list subscription when an older subscription read completes', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    const old = peer.expect('threads.getSubscriptionStatus', threadParams());
    await startThreads();
    old.flush({ subscribed: false, archived: true });
    await loading;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: false });
  });

  it('keeps a newer subscription read when an older list response completes', async () => {
    await showThreads();
    const old = peer.expect('threads.list', listThreadsParams());
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    peer.expect('threads.getSubscriptionStatus', threadParams()).flush({ subscribed: false, archived: true });
    await loading;
    old.flush(structuredClone({ threads: [wireThread] }));
    await settle();
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: true });
    expect(threads.items()).toEqual([]);
  });

  it('preserves archive state when subscribing and preserves subscription state when archiving', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    peer.expect('threads.getSubscriptionStatus', threadParams()).flush({ subscribed: false, archived: true });
    await loading;
    const archiving = inbox['chatInfo'].setThreadArchived(testChat.id, rootId, false);
    peer.expect('threads.unarchive', threadParams()).flush(null);
    await archiving;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: false, archived: false });
    const archiveAgain = inbox['chatInfo'].setThreadArchived(testChat.id, rootId, true);
    peer.expect('threads.archive', threadParams()).flush(null);
    await archiveAgain;
    const subscribing = inbox['chatInfo'].subscribeThread(testChat.id, rootId);
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    peer.expect('threads.subscribe', threadParams()).flush(null);
    await subscribing;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    expect(refreshCounts).not.toHaveBeenCalled();
    peer.verify();
  });

  it('reads authoritative subscription state when a command lacks the other field', async () => {
    const subscribing = inbox['chatInfo'].subscribeThread(testChat.id, rootId);
    peer.expect('threads.subscribe', threadParams()).flush(null);
    await settle();
    peer.expect('threads.getSubscriptionStatus', threadParams()).flush({ subscribed: true, archived: true });
    await subscribing;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    peer.expectNone('threads.list');
  });

  it('coalesces topic reads and preserves their result over an older list response', async () => {
    await startThreads();
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('101'));
    expect(inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'))).toBe(reading);
    void threads.refresh();
    await settle();
    const stale = peer.expect('threads.list', listThreadsParams());
    await vi.advanceTimersByTimeAsync(1000);
    peer
      .expect('threads.markAsRead', threadParams({ messageId: '102' }))
      .flush({ lastReadMessageId: '102', unreadCount: 0 });
    await settle();
    expect(threads.items()[0].unreadCount).toBe(0);
    stale.flush(structuredClone({ threads: [wireThread] }));
    await settle();

    await reading;
    expect(threads.items()[0].lastReadMessageId).toBe(encodeId('102'));
    peer.expectNone('threads.markAsRead');
  });

  it('reconciles a late read response after a newer reply was already listed', async () => {
    await startThreads();
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    const delayed = peer.expect('threads.markAsRead', threadParams({ messageId: '102' }));
    updatedThread();
    await settle();
    await flushReads();
    peer
      .expect('threads.getReadState', threadParams())
      .flush({ lastReadMessageId: '102', unreadCount: 1, unreadMentions: 0, unreadReactions: 0 });
    await settle();
    delayed.flush({ lastReadMessageId: '102', unreadCount: 0 });
    await settle();

    await reading;
    expect(threads.items()[0].unreadCount).toBe(1);
  });

  it('ignores late list and subscription replies after destruction', async () => {
    await showThreads();
    const list = peer.expect('threads.list', listThreadsParams());
    const subscription = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    const status = peer.expect('threads.getSubscriptionStatus', threadParams());
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    destroy();
    list.flush({ threads: [wireThread] });
    status.flush({ subscribed: false, archived: false });
    updatedThread();
    resync.next();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([reading, subscription]);
    peer.verify();
    expect(refreshCounts).not.toHaveBeenCalled();
  });

  it('ignores a late read without sending its queued higher watermark after destruction', async () => {
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('101'));
    await vi.advanceTimersByTimeAsync(1000);
    const read = peer.expect('threads.markAsRead', threadParams({ messageId: '101' }));
    inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    destroy();
    read.flush({ lastReadMessageId: '101', unreadCount: 0 });
    await vi.advanceTimersByTimeAsync(2000);
    await reading;
    peer.verify();
  });

  it('shares request activation and ignores a late reply after the last consumer leaves', async () => {
    const query = inbox.friendRequests(false);
    const first = query.activate();
    const second = query.activate();
    await settle();
    const old = peer.expect('friends.listRequests', { archived: false });
    first();
    first();
    second();
    expect(query.loading()).toBe(false);
    old.flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(query.items()).toEqual([]);
    const returned = query.activate();
    await settle();
    expect(query.loading()).toBe(true);
    peer.expect('friends.listRequests', { archived: false }).flush(structuredClone({ requests: [wireRequest] }));
    await settle();
    expect(query.items()).toEqual([request]);
    expect(query.error()).toBe(false);
    returned();
  });

  it('ignores a late page after the last consumer leaves and restarts at the first page', async () => {
    await startThreads();
    const query = inbox.threads(false);
    const second = query.activate();
    const paging = query.loadMore();
    await settle();
    const old = peer.expect('threads.list', listThreadsParams(false, 'older'));
    await hideLists();
    second();
    expect(query.loadingMore()).toBe(false);
    const before = structuredClone(query.items());
    old.flush(
      structuredClone({
        threads: [{ ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } }],
      }),
    );
    await paging;
    await settle();
    expect(query.items()).toEqual(before);
    const returned = query.activate();
    await settle();
    expect(query.loading()).toBe(true);
    peer.expect('threads.list', listThreadsParams()).flush(structuredClone({ threads: [wireThread] }));
    await settle();
    expect(query.error()).toBeUndefined();
    expect(query.hasMore()).toBe(false);
    returned();
  });

  it('finds resume state by ID across fresh caches and preserves known-empty read state', async () => {
    await showThreads();
    peer
      .expect('threads.list', listThreadsParams())
      .flush(structuredClone({ threads: [{ ...wireThread, lastReadMessageId: '101' }] }));
    await settle();
    await showThreads(true);
    peer.expect('threads.list', listThreadsParams(true)).flush(
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
    peer.verify();
  });

  it('keeps an authoritative read result when returning to an older cached archive', async () => {
    await startThreads();
    await showThreads(true);
    const old = peer.expect('threads.list', listThreadsParams(true));
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    peer
      .expect('threads.markAsRead', threadParams({ messageId: '102' }))
      .flush({ lastReadMessageId: '102', unreadCount: 0 });
    await settle();
    old.flush(structuredClone({ threads: [{ ...wireThread, archived: true }] }));
    await settle();

    await reading;
    expect(threads.items()[0].unreadCount).toBe(0);
    await hideLists();
    const unarchiving = inbox['chatInfo'].setThreadArchived(testChat.id, rootId, false);
    peer.expect('threads.unarchive', threadParams()).flush(null);
    await unarchiving;
    const cached = inbox.threads(false).items()[0];
    expect(cached.lastReadMessageId).toBe(encodeId('102'));
    expect(cached.unreadCount).toBe(0);
    peer.expectNone('threads.list');
  });
  it('refreshes a mention on a deep loaded row without reading any list pages', async () => {
    await startThreads();
    const older = { ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } };
    const paging = threads.loadMore();
    await settle();
    peer.expect('threads.list', listThreadsParams(false, 'older')).flush({ threads: [older], nextCursor: 'tail' });
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
    peer
      .expect('threads.getReadState', threadParams({ threadRootId: '99' }))
      .flush({ unreadCount: 3, unreadMentions: 1, unreadReactions: 0 });
    await settle();
    expect(threads.items()).toHaveLength(2);
    expect(threads.items()[1].unreadMentions).toBe(1);
    expect(inbox['chatInfo'].threadReadState(testChat.id, rootId)).toBeDefined();
    peer.expectNone('threads.list');
  });

  it('adds a new live thread from the head without reloading deeper pages or changing the tail cursor', async () => {
    await startThreads();
    const paging = threads.loadMore();
    await settle();
    peer.expect('threads.list', listThreadsParams(false, 'older')).flush(
      structuredClone({
        threads: [{ ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } }],
        nextCursor: 'tail',
      }),
    );
    await paging;
    messages.next({ ...testMessage, id: encodeId('203'), replyRootId: encodeId('200') });
    await flushReads();
    peer.expectNone('threads.list');
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
    peer.expect('threads.list', listThreadsParams()).flush(
      structuredClone({
        threads: [{ ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '200' } }, wireThread],
        nextCursor: 'older',
      }),
    );
    await settle();
    expect(threads.items()).toHaveLength(3);
    peer.expectNone('threads.list');
    const more = threads.loadMore();
    await settle();
    peer.expect('threads.list', listThreadsParams(false, 'tail')).flush({ threads: [] });
    await more;
  });

  it('refreshes the loaded topic depth without shrinking to the first page', async () => {
    await startThreads();
    const olderThread = { ...wireThread, threadRootMessage: { ...wireThread.threadRootMessage, id: '99' } };
    const more = threads.loadMore();
    await settle();
    peer
      .expect('threads.list', listThreadsParams(false, 'older'))
      .flush({ threads: [olderThread], nextCursor: 'tail' });
    await more;
    const refreshing = threads.refresh();
    await settle();
    peer
      .expect('threads.list', listThreadsParams())
      .flush(structuredClone({ threads: [{ ...wireThread, replyCount: 5 }], nextCursor: 'older' }));
    await settle();
    expect(threads.items()).toHaveLength(2);
    peer
      .expect('threads.list', listThreadsParams(false, 'older'))
      .flush({ threads: [olderThread], nextCursor: 'tail' });
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
    peer.verify();
  });
  it('shares a settled read result and deduplicates repeated reads', async () => {
    await startThreads();
    vi.useFakeTimers();
    const reading = inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    peer
      .expect('threads.markAsRead', threadParams({ messageId: '102' }))
      .flush({ lastReadMessageId: '102', unreadCount: 0 });
    await reading;
    expect(threads.items()[0].unreadCount).toBe(0);
    await inbox['chatInfo'].markThreadRead(testChat.id, rootId, encodeId('102'));
    await vi.advanceTimersByTimeAsync(1000);
    peer.expectNone('threads.markAsRead');
  });

  it('keeps the newer read and subscription state after an older overlapping list finishes', async () => {
    await showThreads();
    const old = peer.expect('threads.list', listThreadsParams());
    const releaseArchive = inbox.threads(true).activate();
    await settle();
    peer.expect('threads.list', listThreadsParams(true)).flush(
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
    peer
      .expect('threads.markAsRead', threadParams({ messageId: '102' }))
      .flush({ lastReadMessageId: '102', unreadCount: 0 });
    await reading;
    await showThreads();
    peer
      .expect('threads.list', listThreadsParams())
      .flush(structuredClone({ threads: [{ ...wireThread, lastReadMessageId: '102', unreadCount: 1 }] }));
    await settle();
    expect(threads.items()[0].unreadCount).toBe(1);
  });
  it('rolls back a failed optimistic thread archive without changing subscription', async () => {
    const loading = inbox['chatInfo'].loadSubscription(testChat.id, rootId);
    peer.expect('threads.getSubscriptionStatus', threadParams()).flush({ subscribed: true, archived: false });
    await loading;
    const operation = inbox['chatInfo'].setThreadArchived(testChat.id, rootId, true);
    const failed = expect(operation).rejects.toBeDefined();
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: true });
    peer.expect('threads.archive', threadParams()).error(RpcErrorCode.Internal);
    await failed;
    expect(inbox['chatInfo'].subscription(testChat.id, rootId)).toEqual({ subscribed: true, archived: false });
  });
});
