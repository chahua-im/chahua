import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { GroupKind, GroupRole, type ServerWsMessage } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../api/testing';
import { ChatStore } from './chat-store';
import { SessionStore } from '../session/session-store';

describe('ChatStore', () => {
  let store: ChatStore;
  let http: HttpTestingController;
  let scope: EnvironmentInjector;
  let resync: Subject<void>;
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
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        {
          provide: Connection,
          useValue: mockRealtime({ resync$: resync, events$: new Subject<ServerWsMessage>() }),
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
