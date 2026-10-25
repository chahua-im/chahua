import { MembershipMessageVisibility, SystemMessageKind } from '../../generated/models';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { GroupKind, GroupRole, MessageType, ServerWsMessageType, type ServerWsMessage } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../api/testing';
import { ChatChangeKind, ChatStore } from './chat-store';
import { SessionStore } from '../session/session-store';

describe('ChatStore', () => {
  let store: ChatStore;
  let http: HttpTestingController;
  let scope: EnvironmentInjector;
  let resync: Subject<void>;
  let events: Subject<ServerWsMessage>;
  const url = `/_api/group/${decodeId(testChat.id)}`;
  const response = {
    id: wireChat.id,
    kind: 'group',
    name: '小群',
    description: '群介绍',
    myRole: 'admin',
    visibility: 'private',
    createdAt: '2026-09-05T12:00:00Z',
  };

  beforeEach(() => {
    resync = new Subject();
    events = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        {
          provide: Connection,
          useValue: mockRealtime({ resync$: resync, events$: events }),
        },
      ],
    });
    scope = createEnvironmentInjector([ChatStore], TestBed.inject(EnvironmentInjector));
    store = scope.get(ChatStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    scope.destroy();
    vi.useRealTimers();
    http.verify();
  });

  it('revokes cached membership previews, rejects old policy snapshots and keeps ordinary messages visible', async () => {
    const session = TestBed.inject(SessionStore);
    session.user.set(testUser);
    const message = {
      ...testMessage,
      mentions: [],
      messageType: MessageType.system,
      systemKind: SystemMessageKind.member_joined,
    };
    store.acceptChats([{ ...testChat, lastMessage: message, lastMessageAt: message.createdAt }], store.snapshot());
    const staleVersion = store.snapshot();
    const policyGeneration = store.membershipPolicyRequestGeneration();
    for (let i = 0; i < 2; i++) {
      events.next({ type: ServerWsMessageType.membershipMessagePolicyChanged, payload: { chatId: testChat.id } });
    }
    await Promise.resolve();
    http.expectOne(url).flush({
      ...response,
      myRole: GroupRole.member,
      membershipMessagePolicy: { visibility: MembershipMessageVisibility.admins, canView: false },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get(testChat.id)?.myRole).toBe(GroupRole.member);
    expect(store.isChatMessageVisible(message)).toBe(false);
    expect(store.isChatMessageVisible(testMessage)).toBe(true);
    expect(store.chat(testChat.id).lastMessage).toBeUndefined();
    store.acceptChats([{ ...testChat, lastMessage: message }], staleVersion, policyGeneration);
    expect(store.membershipPolicy(testChat.id)?.canView).toBe(false);
    expect(store.chat(testChat.id).lastMessage).toBeUndefined();
    session.user.set({ ...testUser, uid: 2 });
    expect(store.membershipPolicy(testChat.id)).toBeUndefined();
  });

  it.each([undefined, MessageType.system, MessageType.text])(
    'applies a restricted list preview before notifying consumers, preserving newer visible arrivals (%s)',
    (arrivalType) => {
      TestBed.inject(SessionStore).user.set(testUser);
      const membership = {
        ...testMessage,
        id: encodeId('100'),
        mentions: [],
        messageType: MessageType.system,
        systemKind: SystemMessageKind.member_joined,
        createdAt: '2026-10-25T11:00:00Z',
      };
      store.acceptChats(
        [{ ...testChat, lastMessage: membership, lastMessageAt: membership.createdAt }],
        store.snapshot(),
      );
      const version = store.snapshot();
      const arrival = {
        ...testMessage,
        id: encodeId('200'),
        messageType: arrivalType ?? MessageType.text,
        systemKind: arrivalType === MessageType.system ? SystemMessageKind.member_added : undefined,
        createdAt: '2026-10-25T12:00:00Z',
      };
      if (arrivalType) TestBed.inject(Connection).accept(arrival);
      const visible = { ...testMessage, id: encodeId('90'), mentions: [], createdAt: '2026-10-25T10:00:00Z' };
      const expected = arrivalType === MessageType.text ? arrival : visible;
      const observed: ReturnType<ChatStore['chat']>[] = [];
      const subscription = store.changes$.subscribe(({ kind }) => {
        if (kind === ChatChangeKind.MembershipMessagePolicy) observed.push(store.chat(testChat.id));
      });
      store.acceptChats(
        [
          {
            ...testChat,
            membershipMessagePolicy: { visibility: MembershipMessageVisibility.admins, canView: false },
            lastMessage: visible,
            lastMessageAt: visible.createdAt,
          },
        ],
        version,
      );
      subscription.unsubscribe();
      expect(store.chat(testChat.id).lastMessage?.id).toBe(expected.id);
      expect(store.chat(testChat.id).lastMessageAt).toBe(expected.createdAt);
      expect(observed.map((chat) => chat.lastMessage?.id)).toEqual([expected.id]);
      expect(store.membershipPolicy(testChat.id)?.canView).toBe(false);
    },
  );

  it('keeps the server cursor when a visible read confirmation also covers a hidden tail', async () => {
    vi.useFakeTimers();
    store.acceptChats([{ ...testChat, lastReadMessageId: encodeId('100'), unreadCount: 1 }], store.snapshot());
    const reading = store.markRead(testChat.id, encodeId('150'));
    await vi.advanceTimersByTimeAsync(1000);
    const request = http.expectOne(`/_api/chats/${decodeId(testChat.id)}/read`);
    expect(request.request.body.messageId).toBe('150');
    request.flush({ lastReadMessageId: '200', unreadCount: 0, unreadMentions: 0, unreadReactions: 0 });
    await reading;
    expect(store.chat(testChat.id).lastReadMessageId).toBe(encodeId('200'));
    expect(store.chat(testChat.id).unreadCount).toBe(0);
    await store.markRead(testChat.id, encodeId('150'));
    http.expectNone(() => true);
    vi.useRealTimers();
  });

  it('ignores hidden activity for previews without creating a separate read boundary', async () => {
    TestBed.inject(SessionStore).user.set({ ...testUser, showMembershipMessages: false });
    const visible = { ...testMessage, id: encodeId('100'), mentions: [] };
    const hidden = {
      ...testMessage,
      id: encodeId('200'),
      createdAt: '2026-10-24T12:00:00Z',
      messageType: MessageType.system,
      systemKind: SystemMessageKind.member_joined,
      message: 'joined',
      mentions: [],
    };
    store.acceptChats([{ ...testChat, lastMessage: visible, lastMessageAt: visible.createdAt }], store.snapshot());
    const version = store.snapshot();
    TestBed.inject(Connection).accept({ ...hidden, id: encodeId('201') });
    store.acceptChats([{ ...testChat, lastMessage: visible, lastMessageAt: visible.createdAt }], version);
    expect(store.chat(testChat.id).lastMessage?.id).toBe(visible.id);
    expect(store.chat(testChat.id).lastMessageAt).toBe(visible.createdAt);
    // A newer visible message can arrive after the hidden event with a higher ID.
    TestBed.inject(Connection).accept({ ...visible, id: encodeId('150') });
    store.acceptChats([{ ...testChat, lastMessage: visible }], version);
    expect(store.chat(testChat.id).lastMessage?.id).toBe(encodeId('150'));
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...visible, id: encodeId('150'), message: 'edited preview' },
    });
    expect(store.chat(testChat.id).lastMessage?.message).toBe('edited preview');
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...visible, id: encodeId('150'), isDeleted: true },
    });
    expect(store.chat(testChat.id).lastMessage?.isDeleted).toBe(true);
  });

  it('retains projected chat information independently of later list results', async () => {
    store.remember([testChat]);
    store.remember([]);
    await store.ensure(testChat.id);
    expect(store.get(testChat.id)).toEqual({
      kind: testChat.kind,
      name: testChat.name,
      avatar: testChat.avatar,
      peer: testChat.peer,
    });
    http.expectNone(url);
  });

  it('carries chat-level unread reactions and clears them on acknowledge', () => {
    store.acceptChats([{ ...testChat, unreadReactions: 2 }], store.snapshot());
    expect(store.unreadReactions(testChat.id)).toBe(2);
    expect(store.chat(testChat.id).unreadReactions).toBe(2);

    store.applyReactionRead(testChat.id, undefined, 0);
    expect(store.unreadReactions(testChat.id)).toBe(0);
    expect(store.chat(testChat.id).unreadReactions).toBe(0);
    http.expectNone(url);
  });

  it('preserves temporary mute while archiving, unarchiving and rolling back a failed archive', async () => {
    const mutedUntil = new Date(Date.now() + 3600_000).toISOString();
    store.acceptChats([{ ...testChat, mutedUntil }], store.snapshot());
    const archiveUrl = `/_api/chats/${wireChat.id}/archive`;
    const archived = store.setArchived(testChat.id, true);
    expect(store.chat(testChat.id).archived).toBe(true);
    expect(store.mutedUntil(testChat.id)).toBe(mutedUntil);
    http.expectOne(archiveUrl).flush(null);
    await archived;
    const unarchived = store.setArchived(testChat.id, false);
    expect(store.chat(testChat.id).archived).toBe(false);
    expect(store.mutedUntil(testChat.id)).toBe(mutedUntil);
    http.expectOne(archiveUrl).flush(null);
    await unarchived;
    const failed = store.setArchived(testChat.id, true);
    const rejection = expect(failed).rejects.toBeDefined();
    http.expectOne(archiveUrl).flush('failed', { status: 500, statusText: 'Failed' });
    await rejection;
    expect(store.chat(testChat.id).archived).toBe(false);
    expect(store.mutedUntil(testChat.id)).toBe(mutedUntil);
  });

  describe('peer receipt invalidation', () => {
    const receiptUrl = `/_api/chats/${wireChat.id}/read-receipt`;
    const rootId = encodeId('9007199254741999');
    const threadUrl = `${receiptUrl}?threadId=${decodeId(rootId)}`;
    const thread = {
      chatId: testChat.id,
      chatKind: GroupKind.dm,
      chatName: 'DM',
      threadRootMessage: { ...testMessage, id: rootId, mentions: [] },
      participants: [],
      replyCount: 1,
      lastReplyAt: testMessage.createdAt,
      subscribedAt: testMessage.createdAt,
      archived: false,
      unreadCount: 0,
      peerLastReadMessageId: testMessage.id,
    };
    beforeEach(() => TestBed.inject(SessionStore).user.set(testUser));

    it('merges conversation receipts by scope and rejects responses older than a list snapshot or privacy change', async () => {
      const dm = { ...testChat, kind: GroupKind.dm };
      store.acceptChats([dm], store.snapshot());
      store.acceptThreads([thread], store.snapshot(), store.subscriptionSnapshot());
      store.acceptPeerRead(testChat.id, undefined, testMessage.id, store.snapshot());
      store.acceptPeerRead(testChat.id, rootId, encodeId('100'), store.snapshot());
      expect(store.chat(testChat.id).peerLastReadMessageId).toBe(testMessage.id);
      expect(store.thread(rootId)?.peerLastReadMessageId).toBe(encodeId('100'));

      const oldVersion = store.snapshot();
      store.acceptChats([dm], store.snapshot());
      store.acceptPeerRead(testChat.id, undefined, testMessage.id, oldVersion);
      expect(store.chat(testChat.id).peerLastReadMessageId).toBeUndefined();

      const beforePrivacy = store.snapshot();
      store.applyPeerRead({ chatId: testChat.id, privacyChanged: true });
      store.acceptPeerRead(testChat.id, undefined, testMessage.id, beforePrivacy);
      store.acceptPeerRead(testChat.id, rootId, testMessage.id, beforePrivacy);
      expect(store.chat(testChat.id).peerLastReadMessageId).toBeUndefined();
      expect(store.thread(rootId)?.peerLastReadMessageId).toBeUndefined();
      http.expectOne(receiptUrl).flush({});
      http.expectOne(threadUrl).flush({});
      await Promise.resolve();
    });

    it('discards an in-flight receipt and old list snapshot after privacy is revoked', async () => {
      const dm = { ...testChat, kind: GroupKind.dm, peerLastReadMessageId: testMessage.id };
      store.acceptChats([dm], store.snapshot());
      store.applyPeerRead({ chatId: testChat.id, readerUid: 2 });
      const pending = http.expectOne(receiptUrl);
      const listVersion = store.snapshot();
      store.applyPeerRead({ chatId: testChat.id, privacyChanged: true });
      expect(store.chat(testChat.id).peerLastReadMessageId).toBeUndefined();
      store.acceptChats([dm], listVersion);
      pending.flush({ lastReadMessageId: wireMessage.id });
      await Promise.resolve();
      expect(store.chat(testChat.id).peerLastReadMessageId).toBeUndefined();
      http.expectOne(receiptUrl).flush({ lastReadMessageId: null });
      await Promise.resolve();
      expect(store.chat(testChat.id).peerLastReadMessageId).toBeNull();
    });

    it('clears and reauthorizes all thread scopes without a loaded parent chat', async () => {
      store.acceptThreads([thread], store.snapshot(), store.subscriptionSnapshot());
      store.applyPeerRead({ chatId: testChat.id, threadRootId: rootId, readerUid: 2 });
      const pending = http.expectOne(threadUrl);
      const version = store.snapshot();
      store.applyPeerRead({ chatId: testChat.id, privacyChanged: true });
      expect(store.thread(rootId)?.peerLastReadMessageId).toBeUndefined();
      store.acceptThreads([thread], version, store.subscriptionSnapshot());
      pending.flush({ lastReadMessageId: wireMessage.id });
      await Promise.resolve();
      expect(store.thread(rootId)?.peerLastReadMessageId).toBeUndefined();
      http.expectOne(threadUrl).flush({ lastReadMessageId: null });
      await Promise.resolve();
      expect(store.thread(rootId)?.peerLastReadMessageId).toBeNull();
      http.expectNone(receiptUrl);
    });

    it('does not expose a thread first loaded from a snapshot predating privacy invalidation', () => {
      const version = store.snapshot();
      store.applyPeerRead({ chatId: testChat.id, privacyChanged: true });
      store.acceptThreads([thread], version, store.subscriptionSnapshot());
      expect(store.thread(rootId)?.peerLastReadMessageId).toBeUndefined();
    });

    it('restores the authorized receipt when sharing is enabled again', async () => {
      store.acceptChats([{ ...testChat, kind: GroupKind.dm }], store.snapshot());
      store.applyPeerRead({ chatId: testChat.id, privacyChanged: true });
      http.expectOne(receiptUrl).flush({ lastReadMessageId: wireMessage.id });
      await Promise.resolve();
      expect(store.chat(testChat.id).peerLastReadMessageId).toBe(testMessage.id);
    });

    it('coalesces successive peer reads and prevents an older result from replacing a newer list result', async () => {
      store.acceptChats([{ ...testChat, kind: GroupKind.dm }], store.snapshot());
      store.applyPeerRead({ chatId: testChat.id, readerUid: 2 });
      const pending = http.expectOne(receiptUrl);
      store.applyPeerRead({ chatId: testChat.id, readerUid: 2 });
      store.applyPeerRead({ chatId: testChat.id, readerUid: 2 });
      http.expectNone(receiptUrl);
      pending.flush({ lastReadMessageId: '100' });
      await Promise.resolve();
      const next = http.expectOne(receiptUrl);
      store.acceptChats([{ ...testChat, kind: GroupKind.dm, peerLastReadMessageId: testMessage.id }], store.snapshot());
      next.flush({ lastReadMessageId: '200' });
      await Promise.resolve();
      expect(store.chat(testChat.id).peerLastReadMessageId).toBe(testMessage.id);
    });

    it('rechecks privacy after a failed in-flight refresh', async () => {
      store.acceptChats([{ ...testChat, kind: GroupKind.dm, peerLastReadMessageId: testMessage.id }], store.snapshot());
      store.applyPeerRead({ chatId: testChat.id, readerUid: 2 });
      const pending = http.expectOne(receiptUrl);
      store.applyPeerRead({ chatId: testChat.id, privacyChanged: true });
      pending.flush({}, { status: 500, statusText: 'Failed' });
      await Promise.resolve();
      http.expectOne(receiptUrl).flush({ lastReadMessageId: null });
      await Promise.resolve();
      expect(store.chat(testChat.id).peerLastReadMessageId).toBeNull();
    });

    it('applies a locally saved privacy change to cached chat and thread receipts', async () => {
      store.acceptChats(
        [{ ...testChat, kind: GroupKind.dm, peer: { uid: 2, gender: 0 }, peerLastReadMessageId: testMessage.id }],
        store.snapshot(),
      );
      store.acceptThreads([thread], store.snapshot(), store.subscriptionSnapshot());
      store.invalidateReadReceiptPrivacy(2);
      expect(store.chat(testChat.id).peerLastReadMessageId).toBeUndefined();
      expect(store.thread(rootId)?.peerLastReadMessageId).toBeUndefined();
      http.expectOne(receiptUrl).flush({ lastReadMessageId: null });
      http.expectOne(threadUrl).flush({ lastReadMessageId: null });
      await Promise.resolve();
    });
  });

  it('refreshes a loaded DM preview receipt when the peer reads', async () => {
    store.acceptChats([{ ...testChat, kind: GroupKind.dm }], store.snapshot());
    store.applyPeerRead({ chatId: testChat.id, readerUid: 2 });
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/read-receipt`).flush({ lastReadMessageId: wireMessage.id });
    await Promise.resolve();
    expect(store.chat(testChat.id).peerLastReadMessageId).toBe(testMessage.id);
  });

  it('keeps thread reaction counts independent from the chat scope', () => {
    const rootId = encodeId('9007199254741999');
    const thread = {
      chatId: testChat.id,
      chatKind: testChat.kind,
      chatName: testChat.name ?? '测试群',
      threadRootMessage: { ...testMessage, id: rootId, mentions: [] },
      participants: [],
      replyCount: 1,
      lastReplyAt: '2026-09-05T12:00:00Z',
      subscribedAt: '2026-09-05T12:00:00Z',
      archived: false,
      unreadCount: 3,
      unreadMentions: 0,
      unreadReactions: 2,
    };
    store.acceptThreads([thread], store.snapshot(), store.subscriptionSnapshot());
    expect(store.thread(rootId)?.unreadReactions).toBe(2);

    store.applyReactionRead(testChat.id, rootId, 0);
    expect(store.thread(rootId)?.unreadReactions).toBe(0);
    http.expectNone(url);
  });

  it('carries chat and thread unread mentions from list snapshots', () => {
    store.acceptChats([{ ...testChat, unreadMentions: 2 }], store.snapshot());
    expect(store.unreadMentions(testChat.id)).toBe(2);
    expect(store.chat(testChat.id).unreadMentions).toBe(2);

    const rootId = encodeId('9007199254741998');
    store.acceptThreads(
      [
        {
          chatId: testChat.id,
          chatKind: testChat.kind,
          chatName: testChat.name ?? '测试群',
          threadRootMessage: { ...testMessage, id: rootId, mentions: [] },
          participants: [],
          replyCount: 1,
          lastReplyAt: '2026-09-05T12:00:00Z',
          subscribedAt: '2026-09-05T12:00:00Z',
          archived: false,
          unreadCount: 0,
          unreadMentions: 1,
          unreadReactions: 0,
        },
      ],
      store.snapshot(),
      store.subscriptionSnapshot(),
    );
    expect(store.unreadMentions(testChat.id, rootId)).toBe(1);
    expect(store.thread(rootId)?.unreadMentions).toBe(1);
    http.expectNone(url);
  });

  it('deduplicates detail requests and retains the fields used by the info panel', async () => {
    const first = store.ensure(testChat.id);
    expect(store.ensure(testChat.id)).toBe(first);
    http.expectOne(url).flush(response);
    await first;
    expect(store.get(testChat.id)).toEqual({
      kind: GroupKind.group,
      name: '小群',
      avatar: undefined,
      peer: undefined,
      myRole: GroupRole.admin,
      description: response.description,
      visibility: response.visibility,
      mutedUntil: undefined,
    });
    await store.ensure(testChat.id);
    http.expectNone(url);
  });

  it('keeps displayed metadata during invalidation and fetches it only when requested', async () => {
    store.remember([testChat]);
    resync.next();
    expect(store.get(testChat.id)?.name).toBe(testChat.name);
    http.expectNone(url);
    const refresh = store.ensure(testChat.id);
    http.expectOne(url).flush({ ...response, name: '新名字' });
    await refresh;
    expect(store.get(testChat.id)?.name).toBe('新名字');
  });

  it('does not replace a newer ingested list value with an older pending lookup', async () => {
    const request = store.ensure(testChat.id);
    const old = http.expectOne(url);
    store.remember([{ ...testChat, name: '列表里的新名字' }]);
    old.flush(response);
    await request;
    expect(store.get(testChat.id)?.name).toBe('列表里的新名字');
  });

  it('revalidates after a reconnect during the first lookup instead of committing that old response', async () => {
    const request = store.ensure(testChat.id);
    const old = http.expectOne(url);
    resync.next();
    expect(store.ensure(testChat.id)).toBe(request);
    old.flush(response);
    await Promise.resolve();
    http.expectOne(url).flush({ ...response, name: '重连后的名字' });
    await request;
    expect(store.get(testChat.id)?.name).toBe('重连后的名字');
  });

  it('loads permissions despite a fresh list entry and preserves them when the list updates', async () => {
    store.remember([testChat]);
    await store.ensure(testChat.id);
    http.expectNone(url);
    expect(store.get(testChat.id)?.myRole).toBeUndefined();

    const details = store.ensureDetails(testChat.id);
    expect(store.ensureDetails(testChat.id)).toBe(details);
    http.expectOne(url).flush(response);
    await details;
    expect(store.get(testChat.id)?.name).toBe(response.name);
    expect(store.get(testChat.id)?.myRole).toBe(GroupRole.admin);
    store.remember([{ ...testChat, name: '新的列表名称' }]);
    expect(store.get(testChat.id)?.name).toBe('新的列表名称');
    expect(store.get(testChat.id)?.description).toBe(response.description);
    expect(store.get(testChat.id)?.visibility).toBe(response.visibility);
    expect(store.get(testChat.id)?.myRole).toBe(GroupRole.admin);
    await store.ensureDetails(testChat.id);
    http.expectNone(url);
  });

  it('shares a details lookup with display loading and refreshes permissions after invalidation', async () => {
    const display = store.ensure(testChat.id);
    expect(store.ensureDetails(testChat.id)).toBe(display);
    http.expectOne(url).flush(response);
    await display;
    resync.next();
    store.remember([testChat]);
    const details = store.ensureDetails(testChat.id);
    http.expectOne(url).flush({ ...response, myRole: GroupRole.member });
    await details;
    expect(store.get(testChat.id)?.myRole).toBe(GroupRole.member);
  });

  it('allows retry after failure and cancels the retry when the service is destroyed', async () => {
    const first = store.ensure(testChat.id);
    const failed = expect(first).rejects.toBeDefined();
    http.expectOne(url).flush('', { status: 503, statusText: 'Unavailable' });
    await failed;
    const retry = store.ensure(testChat.id);
    const cancelled = expect(retry).rejects.toBeDefined();
    const pending = http.expectOne(url);
    scope.destroy();
    expect(pending.cancelled).toBe(true);
    await cancelled;
    scope = createEnvironmentInjector([ChatStore], TestBed.inject(EnvironmentInjector));
    expect(scope.get(ChatStore).get(testChat.id)).toBeUndefined();
  });
});

describe('mute expiry', () => {
  it('expires an active mute without discarding unread data or fetching message history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: Connection, useValue: mockRealtime() }],
    });
    const store = TestBed.inject(ChatStore);
    const http = TestBed.inject(HttpTestingController);
    store.acceptChats([{ ...testChat, mutedUntil: '2026-09-08T10:00:02Z' }], store.snapshot());
    TestBed.tick();
    expect(store.isMuted(testChat.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(2001);
    TestBed.tick();
    expect(store.isMuted(testChat.id)).toBe(false);
    expect(store.chat(testChat.id).unreadCount).toBe(testChat.unreadCount);
    http.expectNone(() => true);
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });
});
