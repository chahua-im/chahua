import { SessionStore } from '../session/session-store';
import { TestBed } from '@angular/core/testing';
import {
  GroupKind,
  MembershipMessageVisibility,
  MessageType,
  ServerWsMessageType,
  SystemMessageKind,
  type ThreadListItem,
} from '../../generated/models';
import { ChatStore } from '../chats/chat-store';
import { Connection } from '../api/connection';
import { RpcErrorCode } from '../api/rpc-error';
import { RpcTestPeer, provideRpcTesting } from '../api/rpc-testing';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testUser, testChat, testMessage, wireChat, wireMessage } from '../api/testing';
import { ConversationError, ConversationStore, PageDirection } from './conversation-store';

const message = (id: string) => ({ ...testMessage, id: encodeId(id) });
const wire = (id: string) => ({ ...wireMessage, id });

describe('ConversationStore', () => {
  let timeline: ConversationStore;
  let peer: RpcTestPeer;
  const messages = (params: Record<string, unknown> = {}) =>
    peer.expect('messages.list', { chatId: decodeId(testChat.id), max: 50, ...params });
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ConversationStore, { provide: Connection, useValue: mockRealtime() }, provideRpcTesting()],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    timeline = TestBed.inject(ConversationStore);
    timeline.reset(testChat.id);
  });
  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });
  it.each([
    { current: undefined, removed: undefined, clears: true },
    { current: '90', removed: undefined, clears: true },
    { current: '90', removed: '90', clears: true },
    { current: '90', removed: '91', clears: false },
    { current: undefined, removed: '90', clears: false },
  ])('invalidates only the revoked conversation scope ($current, $removed)', async ({ current, removed, clears }) => {
    TestBed.inject(SessionStore).user.set(testUser);
    const chats = TestBed.inject(ChatStore);
    const threadId = current ? encodeId(current) : undefined;
    timeline.reset(testChat.id, threadId);
    const params = current ? { threadId: current } : {};
    const opening = timeline.open();
    messages(params).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await opening;
    const loading = timeline.load(PageDirection.Older);
    const held = messages({ ...params, before: '100' });
    const state = {
      chatId: testChat.id,
      threadId: removed ? encodeId(removed) : undefined,
      accessible: false,
      unreadCount: 0,
      unreadMentions: 0,
      unreadReactions: 0,
    };
    chats['acceptReadStates']([state]);
    expect(timeline.items().map(({ id }) => id)).toEqual(clears ? [] : [encodeId('100')]);
    expect(timeline.error()).toBe(clears ? ConversationError.Open : undefined);
    held.flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('50')] });
    await loading;
    expect(timeline.items().map(({ id }) => id)).toEqual((clears ? [] : ['50', '100']).map(encodeId));
    if (clears) {
      chats['acceptReadStates']([{ ...state, accessible: true }]);
      const retry = timeline.open();
      messages(params).flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('110')] });
      expect(await retry).toBe(true);
      expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('110')]);
    }
  });
  it('does not restore an opening response after revocation and permits a fresh retry after access returns', async () => {
    TestBed.inject(SessionStore).user.set(testUser);
    const chats = TestBed.inject(ChatStore);
    const opening = timeline.open();
    const held = messages();
    const state = {
      chatId: testChat.id,
      accessible: false,
      unreadCount: 0,
      unreadMentions: 0,
      unreadReactions: 0,
    };
    chats['acceptReadStates']([state]);
    held.flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    expect(await opening).toBe(false);
    expect(timeline.items()).toEqual([]);
    expect(timeline.error()).toBe(ConversationError.Open);

    const blockedRetry = timeline.open();
    messages().flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('101')] });
    expect(await blockedRetry).toBe(false);
    expect(timeline.items()).toEqual([]);
    expect(timeline.error()).toBe(ConversationError.Open);

    chats['acceptReadStates']([{ ...state, accessible: true }]);
    const retry = timeline.open();
    messages().flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('102')] });
    expect(await retry).toBe(true);
    expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('102')]);
  });

  it.each(
    [
      { change: 'permission revoked', beforeShow: false, afterShow: false, beforeView: true, afterView: false },
      { change: 'permission restored', beforeShow: false, afterShow: false, beforeView: false, afterView: true },
      { change: 'preference disabled', beforeShow: true, afterShow: false, beforeView: false, afterView: false },
      { change: 'preference enabled', beforeShow: false, afterShow: true, beforeView: false, afterView: false },
    ].flatMap((scenario) => [false, true].map((knownBeforeRequest) => ({ ...scenario, knownBeforeRequest }))),
  )(
    'continues history and reconnects with unchanged filtering ($change, known before request: $knownBeforeRequest)',
    async ({ beforeShow, afterShow, beforeView, afterView, knownBeforeRequest }) => {
      const session = TestBed.inject(SessionStore);
      session.user.set({ ...testUser, showMembershipMessages: beforeShow });
      const chats = TestBed.inject(ChatStore);
      const policy = (canView: boolean) => ({ visibility: MembershipMessageVisibility.admins, canView });
      chats.remember([{ ...testChat, membershipMessagePolicy: policy(beforeView) }]);
      const opening = timeline.open(undefined, false, true);
      messages().flush({
        chatSettings: { showMembershipMessages: beforeShow },
        membershipMessagePolicy: policy(beforeView),
        messages: [wire('100')],
        olderCursor: '100',
      });
      await opening;

      const settings = { showMembershipMessages: afterShow };
      const updatedPolicy = policy(afterView);
      if (knownBeforeRequest) {
        session.acceptChatSettings(settings, testUser.uid);
        chats.acceptMembershipPolicy(testChat.id, updatedPolicy);
      }
      for (const [before, id, olderCursor] of [
        ['100', '50', '50'],
        ['50', '25', undefined],
      ] as const) {
        const loading = timeline.load(PageDirection.Older);
        messages({ before: before }).flush({
          chatSettings: settings,
          membershipMessagePolicy: updatedPolicy,
          messages: [wire(id)],
          olderCursor,
        });
        await loading;
        expect(timeline.page()?.olderCursor).toBe(olderCursor ? encodeId(olderCursor) : undefined);
        expect(timeline.page()?.chatSettings).toEqual(settings);
        expect(timeline.page()?.membershipMessagePolicy).toEqual(updatedPolicy);
      }

      const reconnecting = timeline.reconnect();
      messages({ after: '100' }).flush({
        chatSettings: settings,
        membershipMessagePolicy: updatedPolicy,
        messages: [wire('150')],
      });
      await reconnecting;
      timeline.receive(message('200'));
      expect(timeline.items().map(({ id }) => id)).toEqual(['25', '50', '100', '150', '200'].map(encodeId));
      expect(timeline.atLatest()).toBe(true);
      expect(timeline.error()).toBeUndefined();
      expect(session.user()?.showMembershipMessages).toBe(afterShow);
    },
  );

  it('discards an in-flight page authorized before a group restriction and retries using the current policy', async () => {
    TestBed.inject(SessionStore).user.set(testUser);
    const chats = TestBed.inject(ChatStore);
    chats.remember([testChat]);
    const opening = timeline.open();
    const request = messages();
    const policy = { visibility: MembershipMessageVisibility.nobody, canView: false };
    const refreshing = chats.refreshMembershipPolicy(testChat.id);
    await Promise.resolve();
    peer
      .expect('groups.get', { chatId: decodeId(testChat.id) })
      .flush({ ...wireChat, membershipMessagePolicy: policy });
    await refreshing;
    request.flush({
      chatSettings: { showMembershipMessages: true },
      membershipMessagePolicy: testChat.membershipMessagePolicy,
      messages: [{ ...wire('100'), messageType: MessageType.system, systemKind: SystemMessageKind.member_joined }],
    });
    await Promise.resolve();
    await Promise.resolve();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      membershipMessagePolicy: policy,
      messages: [wire('90')],
    });
    expect(await opening).toBe(true);
    expect(timeline.hideMembershipMessages).toBe(true);
    expect(timeline.items().map((message) => message.id)).toEqual([encodeId('90')]);
  });

  const unfilteredScopes = [
    { scope: 'DM', kind: GroupKind.dm, threadId: undefined },
    { scope: 'thread', kind: GroupKind.group, threadId: encodeId('90') },
  ].flatMap((scope) => [true, false].map((savedLocally) => ({ ...scope, savedLocally })));

  it.each(unfilteredScopes)(
    'continues $scope history after membership settings change (saved locally: $savedLocally)',
    async ({ kind, threadId, savedLocally }) => {
      const session = TestBed.inject(SessionStore);
      session.user.set(testUser);
      TestBed.inject(ChatStore).remember([{ ...testChat, kind }]);
      timeline.reset(testChat.id, threadId);
      const threadParams = threadId ? { threadId: decodeId(threadId) } : {};
      const opening = timeline.open();
      messages(threadParams).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [wire('100')],
        olderCursor: '100',
      });
      await opening;
      const settings = { showMembershipMessages: false };
      if (savedLocally) session.acceptChatSettings(settings, testUser.uid);
      const loading = timeline.load(PageDirection.Older);
      messages({ ...threadParams, before: '100' }).flush({
        chatSettings: settings,
        messages: [wire('50')],
      });
      await loading;
      expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('50'), encodeId('100')]);
      expect(timeline.page()?.olderCursor).toBeUndefined();
      expect(timeline.page()?.chatSettings).toEqual(settings);
      expect(timeline.error()).toBeUndefined();
      expect(session.user()?.showMembershipMessages).toBe(false);
    },
  );

  it.each(unfilteredScopes)(
    'resumes $scope live delivery after reconnect with changed membership settings (saved locally: $savedLocally)',
    async ({ kind, threadId, savedLocally }) => {
      const session = TestBed.inject(SessionStore);
      session.user.set(testUser);
      TestBed.inject(ChatStore).remember([{ ...testChat, kind }]);
      timeline.reset(testChat.id, threadId);
      const threadParams = threadId ? { threadId: decodeId(threadId) } : {};
      const opening = timeline.open();
      messages(threadParams).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [wire('100')],
      });
      await opening;
      const settings = { showMembershipMessages: false };
      if (savedLocally) session.acceptChatSettings(settings, testUser.uid);
      const reconnecting = timeline.reconnect();
      messages({ ...threadParams, after: '100' }).flush({
        chatSettings: settings,
        messages: [],
      });
      await reconnecting;
      expect(timeline.atLatest()).toBe(true);
      expect(timeline.error()).toBeUndefined();
      timeline.receive({ ...message('101'), replyRootId: threadId });
      expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('100'), encodeId('101')]);
      expect(session.user()?.showMembershipMessages).toBe(false);
    },
  );

  it('retries the first page with settings discovered from another device', async () => {
    const session = TestBed.inject(SessionStore);
    session.user.set(testUser);
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: false },
      messages: [wire('99')],
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(timeline.items()).toHaveLength(0);
    messages().flush({
      chatSettings: { showMembershipMessages: false },
      messages: [wire('100')],
    });
    expect(await opening).toBe(true);
    expect(timeline.hideMembershipMessages).toBe(true);
    expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('100')]);
  });

  it('rejects a continuation using a different preference without clearing the loaded range', async () => {
    const session = TestBed.inject(SessionStore);
    session.user.set(testUser);
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await opening;
    const loading = timeline.load(PageDirection.Older);
    messages({ before: '100' }).flush({
      chatSettings: { showMembershipMessages: false },
      messages: [wire('50')],
    });
    await loading;
    expect(session.user()?.showMembershipMessages).toBe(false);
    expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('100')]);
  });

  it('reconnects from the last loaded message and completes an empty filtered continuation', async () => {
    const opening = timeline.open(undefined, false, true);
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await opening;
    const older = timeline.load(PageDirection.Older);
    messages({ before: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('50')],
    });
    await older;
    const reconnecting = timeline.reconnect();
    messages({ after: '100' }).flush({ chatSettings: { showMembershipMessages: true }, messages: [] });
    await reconnecting;
    expect(timeline.atLatest()).toBe(true);
    expect(timeline.items().map((message) => message.id)).toEqual([encodeId('50'), encodeId('100')]);
    peer.verify();
  });

  it('drops the old live boundary when a membership event becomes hidden', async () => {
    const opening = timeline.open();
    messages().flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    await opening;
    timeline.receive({
      ...message('200'),
      messageType: MessageType.system,
      systemKind: SystemMessageKind.member_joined,
    });
    const hiding = timeline.open(undefined, false, true);
    messages().flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    await hiding;
    expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('100')]);
    expect(timeline.atLatest()).toBe(true);
    expect(timeline.page()?.newerCursor).toBeUndefined();
    peer.verify();
  });

  it('does not create a forward gap for hidden live events while the latest page is loading', async () => {
    const session = TestBed.inject(SessionStore);
    session.user.set({ ...testUser, showMembershipMessages: false });
    const opening = timeline.open(undefined, false, true);
    timeline.receive({
      ...message('200'),
      messageType: MessageType.system,
      systemKind: SystemMessageKind.member_joined,
    });
    messages().flush({
      chatSettings: { showMembershipMessages: false },
      messages: [wire('100')],
    });
    await opening;
    expect(timeline.atLatest()).toBe(true);
    expect(timeline.page()?.newerCursor).toBeUndefined();
    expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('100')]);
    peer.verify();
  });

  it('retains a confirmed empty filtered range while reconnecting and completes without a synthetic cursor', async () => {
    const opening = timeline.open(undefined, false, true);
    messages().flush({ chatSettings: { showMembershipMessages: true }, messages: [] });
    await opening;
    const previous = timeline.page();
    const reconnecting = timeline.reconnect();
    expect(timeline.page()).toBe(previous);
    messages().flush({ chatSettings: { showMembershipMessages: true }, messages: [] });
    await reconnecting;
    expect(timeline.atLatest()).toBe(true);
    expect(timeline.page()?.newerCursor).toBeUndefined();
    peer.verify();
  });

  it('replaces a filtered range when showing membership messages and cancels obsolete filter responses', async () => {
    const first = timeline.open(undefined, false, true);
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
    });
    await first;
    const showing = timeline.open(undefined, false, false);
    const obsolete = messages();
    expect(timeline.items()).toHaveLength(1);
    const hiding = timeline.open(undefined, false, true);
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
    });
    obsolete.flush({ chatSettings: { showMembershipMessages: false }, messages: [wire('100')] });
    expect(timeline.items()).toEqual([message('100')]);
    expect(await showing).toBe(false);
    await hiding;
    expect(timeline.items()).toEqual([message('100')]);
    const restored = timeline.open(undefined, false, false);
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        wire('100'),
        {
          ...wire('260'),
          messageType: MessageType.system,
          systemKind: SystemMessageKind.member_left,
          message: 'left the chat',
        },
      ],
    });
    await restored;
    expect(timeline.items()).toHaveLength(2);
  });

  it.each([
    { scope: 'latest', show: true, around: undefined, empty: false },
    { scope: 'filtered latest', show: false, around: undefined, empty: false },
    { scope: 'exact link', show: true, around: encodeId('100'), empty: false },
    { scope: 'empty range', show: true, around: undefined, empty: true },
  ])('recovers arrivals when switching back during a preference refresh ($scope)', async ({ show, around, empty }) => {
    const session = TestBed.inject(SessionStore);
    session.user.set({ ...testUser, showMembershipMessages: show });
    const opening = timeline.open(undefined, false, !show);
    messages().flush({
      chatSettings: { showMembershipMessages: show },
      messages: empty ? [] : [wire('100')],
    });
    await opening;
    const previous = timeline.page();
    session.acceptChatSettings({ showMembershipMessages: !show }, testUser.uid);
    const switching = timeline.open(undefined, false, show);
    const obsolete = messages();
    timeline.receive(message('101'));
    const membership = {
      ...wire('102'),
      messageType: MessageType.system,
      systemKind: SystemMessageKind.member_joined,
    };
    timeline.receive({ ...membership, id: encodeId('102'), chatId: testChat.id });
    session.acceptChatSettings({ showMembershipMessages: show }, testUser.uid);
    const restoring = timeline.open(around, around != null, !show);
    expect(timeline.page()).toBe(previous);
    expect(timeline.loading()).toBe(true);
    const expected = [...(empty ? [] : [wire('100')]), wire('101'), ...(show ? [membership] : [])];
    const expectedIds = expected.map(({ id }) => encodeId(id));
    messages(around ? { around: '100' } : {}).flush({
      chatSettings: { showMembershipMessages: show },
      messages: expected,
    });
    obsolete.flush({ chatSettings: { showMembershipMessages: !show }, messages: [wire('100')] });
    expect(timeline.page()).toBe(previous);
    expect(await switching).toBe(false);
    expect(await restoring).toBe(true);
    expect(timeline.items().map(({ id }) => id)).toEqual(expectedIds);
    expect(timeline.atLatest()).toBe(true);
    expect(timeline.page()?.newerCursor).toBeUndefined();
    timeline.receive(message('103'));
    expect(timeline.items().at(-1)?.id).toBe(encodeId('103'));
    peer.verify();
  });

  it('retries a failed read after switching back without treating the retained range as current', async () => {
    const session = TestBed.inject(SessionStore);
    session.user.set(testUser);
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
    });
    await opening;
    const previous = timeline.page();
    session.acceptChatSettings({ showMembershipMessages: false }, testUser.uid);
    const hiding = timeline.open(undefined, false, true);
    const obsolete = messages();
    timeline.receive(message('101'));
    session.acceptChatSettings({ showMembershipMessages: true }, testUser.uid);
    const restoring = timeline.open(undefined, false, false);
    obsolete.flush({ chatSettings: { showMembershipMessages: false }, messages: [wire('100'), wire('101')] });
    expect(timeline.page()).toBe(previous);
    messages().error(RpcErrorCode.Unavailable, 'Unavailable');
    expect(await hiding).toBe(false);
    expect(await restoring).toBe(false);
    expect(timeline.error()).toBe(ConversationError.Open);
    expect(timeline.page()).toBe(previous);
    const retrying = timeline.open();
    expect(timeline.page()).toBe(previous);
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100'), wire('101')],
    });
    expect(await retrying).toBe(true);
    expect(timeline.error()).toBeUndefined();
    expect(timeline.items().map(({ id }) => id)).toEqual([encodeId('100'), encodeId('101')]);
    expect(timeline.atLatest()).toBe(true);
  });

  it('does not mistake an explicitly returned hidden target for a missing message', async () => {
    const opening = timeline.open(encodeId('260'), true, true);
    messages({ around: '260' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        wire('100'),
        {
          ...wire('260'),
          messageType: MessageType.system,
          systemKind: SystemMessageKind.member_joined,
          message: 'joined the chat',
        },
      ],
    });
    expect(await opening).toBe(true);
    expect(timeline.error()).toBeUndefined();
  });

  it('restores a recalled latest summary from the loaded range before any list response', async () => {
    const store = TestBed.inject(ChatStore);
    const previous = { ...message('99'), createdAt: '2026-09-04T12:00:00Z', message: 'previous' };
    const latest = message('100');
    store.acceptChats(
      [{ ...testChat, lastMessage: { ...latest, mentions: [] }, lastMessageAt: latest.createdAt }],
      store.snapshot(),
    );
    const staleVersion = store.snapshot();
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wire('99'), createdAt: previous.createdAt, message: 'previous' }, wire('100')],
      olderCursor: '99',
    });
    await opening;
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...latest, isDeleted: true },
    });
    expect(store.chat(testChat.id).lastMessage?.id).toBe(previous.id);
    expect(store.chat(testChat.id).lastMessageAt).toBe(previous.createdAt);
    store.acceptChats(
      [{ ...testChat, lastMessage: { ...latest, mentions: [] }, lastMessageAt: latest.createdAt }],
      staleVersion,
    );
    expect(store.chat(testChat.id).lastMessage?.id).toBe(previous.id);
    peer.verify();
  });

  for (const edge of ['complete', 'older', 'newer', 'unknown'] as const) {
    it(`does not guess the predecessor beyond a ${edge} range`, async () => {
      const store = TestBed.inject(ChatStore);
      const latest = message(edge === 'unknown' ? '101' : '100');
      store.acceptChats(
        [{ ...testChat, lastMessage: { ...latest, mentions: [] }, lastMessageAt: latest.createdAt }],
        store.snapshot(),
      );
      const opening = timeline.open();
      messages().flush({
        chatSettings: { showMembershipMessages: true },
        messages: [wire('100')],
        olderCursor: edge === 'older' ? '100' : undefined,
        newerCursor: edge === 'newer' ? '100' : undefined,
      });
      await opening;
      TestBed.inject(Connection).acceptChange({
        type: ServerWsMessageType.messageDeleted,
        payload: { ...latest, isDeleted: true },
      });
      if (edge === 'complete') {
        expect(store.chat(testChat.id).lastMessage).toBeUndefined();
        expect(store.chat(testChat.id).lastMessageAt).toBeUndefined();
      } else {
        expect(store.chat(testChat.id).lastMessage?.id).toBe(latest.id);
        expect(store.chat(testChat.id).lastMessageAt).toBe(latest.createdAt);
      }
      peer.verify();
    });
  }

  it('skips every recalled tail message in a bulk event without overwriting a newer summary', async () => {
    const store = TestBed.inject(ChatStore);
    const latest = message('101');
    store.acceptChats(
      [{ ...testChat, lastMessage: { ...latest, mentions: [] }, lastMessageAt: latest.createdAt }],
      store.snapshot(),
    );
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('99'), wire('100'), wire('101')],
    });
    await opening;
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: {
        chatId: testChat.id,
        messageIds: [encodeId('100'), encodeId('101')],
      },
    });
    expect(store.chat(testChat.id).lastMessage?.id).toBe(encodeId('99'));
    TestBed.inject(Connection).accept(message('102'));
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...latest, isDeleted: true },
    });
    expect(store.chat(testChat.id).lastMessage?.id).toBe(encodeId('102'));
  });

  for (const edge of ['previous', 'empty', 'older', 'newer', 'unknown', 'bulk', 'root'] as const) {
    it(`restores a recalled thread preview from a ${edge} range without a list response`, async () => {
      const store = TestBed.inject(ChatStore);
      const rootId = encodeId('90');
      const previous = { ...message('99'), replyRootId: rootId, createdAt: '2026-09-04T12:00:00Z' };
      const latest = { ...message(edge === 'unknown' ? '101' : '100'), replyRootId: rootId };
      const thread: ThreadListItem = {
        archived: false,
        chatId: testChat.id,
        chatKind: testChat.kind,
        chatName: 'Test',
        threadRootMessage: { ...message('90'), mentions: [] },
        lastReply: { ...latest, mentions: [] },
        lastReplyAt: latest.createdAt,
        replyCount: 2,
        unreadCount: 0,
        unreadMentions: 0,
        unreadReactions: 0,
        subscribedAt: previous.createdAt,
      };
      store.acceptThreads([thread], store.snapshot(), store.subscriptionSnapshot());
      const staleVersion = store.snapshot();
      timeline.reset(testChat.id, rootId);
      const opening = timeline.open();
      messages({ threadId: '90' }).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [
          { ...wire('90'), threadInfo: { replyCount: 2 } },
          ...(['previous', 'bulk', 'root'].includes(edge)
            ? [{ ...wire('99'), replyRootId: '90', createdAt: previous.createdAt }]
            : []),
          { ...wire('100'), replyRootId: '90' },
        ],
        olderCursor: edge === 'older' ? '90' : undefined,
        newerCursor: edge === 'newer' ? '100' : undefined,
      });
      await opening;
      const connection = TestBed.inject(Connection);
      if (edge === 'bulk')
        connection.acceptChange({
          type: ServerWsMessageType.messagesBulkDeleted,
          payload: { chatId: testChat.id, messageIds: [previous.id, latest.id] },
        });
      else
        connection.acceptChange({
          type: ServerWsMessageType.messageDeleted,
          payload: { ...(edge === 'root' ? message('90') : latest), isDeleted: true },
        });
      const assertSummary = () => {
        if (edge === 'empty' || edge === 'bulk') {
          expect(store.thread(rootId)).toBeUndefined();
          expect(timeline.items().find((m) => m.id === rootId)?.threadInfo).toBeUndefined();
        } else {
          expect(store.thread(rootId)?.lastReply?.id).toBe(edge === 'previous' ? previous.id : latest.id);
          expect(store.thread(rootId)?.lastReplyAt).toBe(edge === 'previous' ? previous.createdAt : latest.createdAt);
        }
      };
      assertSummary();
      store.acceptThreads([thread], staleVersion, store.subscriptionSnapshot());
      assertSummary();
      if (edge === 'empty' || edge === 'previous') {
        const next = { ...message('102'), replyRootId: rootId };
        connection.accept(next);
        connection.acceptChange({ type: ServerWsMessageType.messageDeleted, payload: { ...latest, isDeleted: true } });
        expect(store.thread(rootId)?.lastReply?.id).toBe(next.id);
      }
      peer.verify();
    });
  }

  it('stores only the message range and current paging edges from RPC responses', async () => {
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
      newerCursor: null,
      nextCursor: '80',
      prevCursor: '120',
    });
    await opening;
    expect(timeline.page()).toEqual({
      chatSettings: { showMembershipMessages: true },
      messages: [message('100')],
      olderCursor: encodeId('100'),
      newerCursor: null,
    });
    const older = timeline.load(PageDirection.Older);
    messages({ before: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('99')],
      olderCursor: null,
      nextCursor: '1',
      prevCursor: '200',
    });
    await older;
    expect(timeline.page()).toEqual({
      chatSettings: { showMembershipMessages: true },
      messages: [message('99'), message('100')],
      olderCursor: null,
      newerCursor: null,
    });
  });

  it('buffers one fetched page until insertion is safe and preserves live arrivals', async () => {
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await opening;
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const older = timeline.load(PageDirection.Older, () => idle);
    messages({ before: '100' }).flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('99')] });
    await Promise.resolve();
    expect(timeline.items()).toEqual([message('100')]);
    expect(timeline.canLoad(PageDirection.Older)).toBe(false);
    timeline.receive(message('101'));
    release();
    await older;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('99'), encodeId('100'), encodeId('101')]);
  });

  it('discards a buffered page after navigation', async () => {
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await opening;
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const older = timeline.load(PageDirection.Older, () => idle);
    messages({ before: '100' }).flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('99')] });
    await Promise.resolve();
    timeline.reset();
    release();
    await older;
    expect(timeline.items()).toEqual([]);
  });

  it('cancels an in-flight RPC request and releases the range when its owner is destroyed', async () => {
    const opening = timeline.open();
    const request = messages();
    TestBed.resetTestingModule();
    request.flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    expect(timeline.items()).toEqual([]);
    expect(await opening).toBe(false);
    expect(timeline.items()).toEqual([]);
    expect(timeline.error()).toBeUndefined();
  });

  it('cancels pagination without discarding the parent range and can catch up on return', async () => {
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await opening;
    const page = timeline.page();
    const loading = timeline.load(PageDirection.Older);
    const request = messages({ before: '100' });
    timeline.cancelLoading();
    request.flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('99')] });
    expect(timeline.page()).toBe(page);
    await loading;
    expect(timeline.page()).toBe(page);
    expect(timeline.paging()).toBe(false);
    expect(timeline.error()).toBeUndefined();
    const reconnecting = timeline.reconnect();
    messages({ after: '100' }).flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('101')] });
    await reconnecting;
    expect(timeline.items().map((message) => message.id)).toEqual([encodeId('100'), encodeId('101')]);
  });

  it('jumps directly to a distant message and keeps both paging edges independent', async () => {
    expect(timeline.atLatest()).toBe(false);
    expect(timeline.canLoad(PageDirection.Older)).toBe(false);
    const opening = timeline.open(encodeId('100'), true);
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100'), wire('101')],
      olderCursor: '100',
      newerCursor: '101',
    });
    await opening;
    expect(timeline.atLatest()).toBe(false);
    expect(timeline.canLoad(PageDirection.Older)).toBe(true);
    expect(timeline.canLoad(PageDirection.Newer)).toBe(true);
    const older = timeline.load(PageDirection.Older);
    expect(timeline.canLoad(PageDirection.Older)).toBe(false);
    expect(timeline.canLoad(PageDirection.Newer)).toBe(false);
    messages({ before: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('99')],
      olderCursor: null,
      newerCursor: null,
    });
    await older;
    expect(timeline.page()?.newerCursor).toBe(encodeId('101'));
    const newer = timeline.load(PageDirection.Newer);
    messages({ after: '101' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('102')],
      newerCursor: null,
      olderCursor: '1',
    });
    await newer;
    expect(timeline.items().map((item) => item.id)).toEqual([
      encodeId('99'),
      encodeId('100'),
      encodeId('101'),
      encodeId('102'),
    ]);
    expect(timeline.page()?.olderCursor).toBeNull();
    expect(timeline.page()?.newerCursor).toBeNull();
    expect(timeline.atLatest()).toBe(true);
    expect(timeline.canLoad(PageDirection.Older)).toBe(false);
    expect(timeline.canLoad(PageDirection.Newer)).toBe(false);
  });

  it('preserves the current range if around only returns a deleted target’s neighbours', async () => {
    const initial = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage }],
      olderCursor: wireMessage.id,
    });
    await initial;
    const jump = timeline.open(encodeId('100'), true);
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('99'), wire('101')],
    });
    expect(await jump).toBe(false);
    expect(timeline.items()).toEqual([testMessage]);
    expect(timeline.error()).toBe(ConversationError.Missing);
  });

  it('does not stitch live messages onto a historical range or fetch the entire gap on reconnect', async () => {
    const opening = timeline.open(encodeId('100'));
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      newerCursor: '100',
      olderCursor: '100',
    });
    await opening;
    timeline.receive(testMessage);
    await timeline.reconnect();
    expect(timeline.items()).toEqual([message('100')]);
    const latest = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage }],
      olderCursor: wireMessage.id,
    });
    await latest;
    expect(timeline.items()).toEqual([testMessage]);
  });

  it('fetches only one reconnect batch and retains previously loaded history', async () => {
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await opening;
    const reconnect = timeline.reconnect();
    messages({ after: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('101')],
      newerCursor: '101',
    });
    await reconnect;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('100'), encodeId('101')]);
    expect(timeline.page()?.newerCursor).toBe(encodeId('101'));
  });

  it('cancels old navigation and pagination requests after a later jump', async () => {
    const opening = timeline.open(encodeId('100'));
    const staleOpen = messages({ around: '100' });
    const latest = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wireMessage }],
      olderCursor: wireMessage.id,
    });
    await latest;
    staleOpen.flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    expect(timeline.items()).toEqual([testMessage]);
    await opening;
    const paging = timeline.load(PageDirection.Older);
    const stalePage = messages({ before: wireMessage.id });
    await timeline.open(testMessage.id, true);
    stalePage.flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('99')] });
    expect(timeline.items()).toEqual([testMessage]);
    await paging;
    expect(timeline.items()).toEqual([testMessage]);
    expect(timeline.loading()).toBe(false);
  });

  it('keeps a forward cursor for live messages arriving during an initial or reconnect request', async () => {
    const opening = timeline.open();
    timeline.receive(message('102'));
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      newerCursor: null,
    });
    await opening;
    expect(timeline.page()?.newerCursor).toBe(encodeId('100'));
    const newer = timeline.load(PageDirection.Newer);
    timeline.receive(message('103'));
    messages({ after: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('101'), wire('102')],
      newerCursor: null,
    });
    await newer;
    expect(timeline.page()?.newerCursor).toBe(encodeId('102'));
  });

  it('merges live messages arriving while older pages load without losing or duplicating them', async () => {
    const opening = timeline.open();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await opening;
    const older = timeline.load(PageDirection.Older);
    expect(timeline.atLatest()).toBe(true);
    timeline.receive(message('101'));
    timeline.receive(message('101'));
    messages({ before: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('99')],
      olderCursor: null,
    });
    await older;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('99'), encodeId('100'), encodeId('101')]);
    timeline.reset();
    expect(timeline.items()).toEqual([]);
  });
  it('reconciles a reconnect received while the initial request was in flight', async () => {
    const opening = timeline.open();
    await timeline.reconnect();
    messages().flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
    });
    await Promise.resolve();
    messages({ after: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('101')],
      newerCursor: null,
    });
    await opening;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('100'), encodeId('101')]);
  });

  it('recovers the first live message when an empty initial snapshot arrives late', async () => {
    const opening = timeline.open();
    timeline.receive(message('100'));
    messages().flush({ chatSettings: { showMembershipMessages: true }, messages: [] });
    await Promise.resolve();
    messages().flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    await opening;
    expect(timeline.items()).toEqual([message('100')]);
  });
  it('can reach the end after a historical range receives a reconnect event', async () => {
    const opening = timeline.open(encodeId('100'));
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      newerCursor: '100',
    });
    await opening;
    await timeline.reconnect();
    const newer = timeline.load(PageDirection.Newer);
    messages({ after: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('101')],
      newerCursor: null,
    });
    await newer;
    expect(timeline.page()?.newerCursor).toBeNull();
  });

  it('scopes every topic page and reconnect request with the backend camelCase parameter', async () => {
    timeline.reset(testChat.id, encodeId('100'));
    const opening = timeline.open(encodeId('102'));
    messages({ around: '102', threadId: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wire('102'), replyRootId: '100' }],
      olderCursor: '102',
    });
    await opening;
    const older = timeline.load(PageDirection.Older);
    messages({ before: '102', threadId: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
    });
    await older;
    timeline.receive(message('105'));
    timeline.receive({ ...message('104'), replyRootId: encodeId('99') });
    timeline.receive({ ...message('103'), replyRootId: encodeId('100') });
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('100'), encodeId('102'), encodeId('103')]);
    const reconnect = timeline.reconnect();
    messages({ after: '103', threadId: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wire('106'), replyRootId: '100' }],
    });
    await reconnect;
    expect(timeline.items().map((item) => item.id)).toEqual([
      encodeId('100'),
      encodeId('102'),
      encodeId('103'),
      encodeId('106'),
    ]);
  });

  it('rejects a previous topic response when changing topics inside the same chat', async () => {
    timeline.reset(testChat.id, encodeId('100'));
    const oldOpening = timeline.open(encodeId('100'));
    const oldRequest = messages({ around: '100', threadId: '100' });
    timeline.reset(testChat.id, encodeId('200'));
    const opening = timeline.open(encodeId('200'));
    messages({ around: '200', threadId: '200' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('200')],
    });
    await opening;
    oldRequest.flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('200')]);
    await oldOpening;
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('200')]);
  });

  it('patches edits and single or bulk deletions in historical ranges without adding unrelated messages', async () => {
    const opening = timeline.open(encodeId('100'));
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100'), wire('101'), wire('102')],
      olderCursor: '100',
      newerCursor: '102',
    });
    await opening;
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...message('100'), message: 'edited', isEdited: true },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...message('101'), isDeleted: true },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: {
        chatId: testChat.id,
        messageIds: [encodeId('102'), encodeId('99')],
      },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...message('99'), message: 'outside the loaded range' },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...message('100'), chatId: encodeId('999'), isDeleted: true },
    });
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: encodeId('999'), messageIds: [encodeId('100')] },
    });
    expect(timeline.items().map((item) => item.id)).toEqual([encodeId('100'), encodeId('101'), encodeId('102')]);
    expect(timeline.items()[0]).toMatchObject({
      message: 'edited',
      isEdited: true,
      isDeleted: false,
    });
    expect(
      timeline
        .items()
        .slice(1)
        .every((item) => item.isDeleted),
    ).toBe(true);
    expect(timeline.page()).toMatchObject({
      olderCursor: encodeId('100'),
      newerCursor: encodeId('102'),
    });
  });

  it('preserves personal reaction state omitted from broadcasts and honors explicit changes and removals', async () => {
    const opening = timeline.open(encodeId('100'));
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wire('100'),
          reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
        },
      ],
      newerCursor: '100',
    });
    await opening;
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.reactionUpdated,
      payload: {
        chatId: testChat.id,
        messageId: encodeId('100'),
        reactions: [{ emoji: '👍', count: 2 }],
      },
    });
    expect(timeline.items()[0].reactions).toEqual([{ emoji: '👍', count: 2, reactedByMe: true }]);
    timeline.update({
      ...message('100'),
      message: 'edited',
      reactions: [{ emoji: '👍', count: 3 }],
    });
    expect(timeline.items()[0].reactions).toEqual([{ emoji: '👍', count: 3, reactedByMe: true }]);
    timeline.updateReactions(encodeId('100'), [{ emoji: '👍', count: 2, reactedByMe: false }]);
    expect(timeline.items()[0].reactions).toEqual([{ emoji: '👍', count: 2, reactedByMe: false }]);
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.reactionUpdated,
      payload: {
        chatId: encodeId('999'),
        messageId: encodeId('100'),
        reactions: [],
      },
    });
    expect(timeline.items()[0].reactions).toHaveLength(1);
    timeline.updateReactions(encodeId('100'), []);
    expect(timeline.items()[0].reactions).toEqual([]);
  });

  it('replays edits and deletions received before the initial or older-page snapshot arrives', async () => {
    const opening = timeline.open(encodeId('100'));
    timeline.update({ ...message('100'), message: 'edited while loading' });
    timeline.updateReactions(encodeId('100'), [{ emoji: '👍', count: 1, reactedByMe: true }]);
    expect(timeline.items()).toEqual([]);
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100')],
      olderCursor: '100',
      newerCursor: '100',
    });
    await opening;
    expect(timeline.items()[0]).toMatchObject({
      message: 'edited while loading',
      reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
    });
    const older = timeline.load(PageDirection.Older);
    timeline.update({
      ...message('99'),
      message: 'edited before paging completed',
    });
    timeline.delete(encodeId('98'));
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: testChat.id, messageIds: [encodeId('97')] },
    });
    messages({ before: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('97'), wire('98'), wire('99'), wire('100')],
    });
    await older;
    expect(timeline.items().map((item) => item.id)).toEqual([
      encodeId('97'),
      encodeId('98'),
      encodeId('99'),
      encodeId('100'),
    ]);
    expect(
      timeline
        .items()
        .slice(0, 2)
        .every((item) => item.isDeleted),
    ).toBe(true);
    expect(timeline.items()[2].message).toBe('edited before paging completed');
    expect(timeline.items()[3].message).toBe('edited while loading');
  });

  it('keeps live edits and known reaction ownership during a jump but accepts a later fresh snapshot', async () => {
    const opening = timeline.open(encodeId('100'));
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wire('100'),
          reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
        },
      ],
      newerCursor: '100',
    });
    await opening;
    const jump = timeline.open(encodeId('100'));
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageUpdated,
      payload: {
        ...message('100'),
        message: 'new edit',
        reactions: [{ emoji: '👍', count: 2 }],
      },
    });
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        {
          ...wire('100'),
          reactions: [{ emoji: '👍', count: 1, reactedByMe: false }],
        },
      ],
      newerCursor: '100',
    });
    await jump;
    expect(timeline.items()[0]).toMatchObject({
      message: 'new edit',
      reactions: [{ emoji: '👍', count: 2, reactedByMe: true }],
    });
    const fresh = timeline.open(encodeId('100'));
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wire('100'), message: 'later server state', reactions: [] }],
    });
    await fresh;
    expect(timeline.items()[0]).toMatchObject({
      message: 'later server state',
      reactions: [],
    });
  });

  it('reports a deleted exact target when its deletion arrives during the request', async () => {
    const opening = timeline.open(encodeId('100'), true);
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: { ...message('100'), isDeleted: true },
    });
    messages({ around: '100' }).flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    expect(await opening).toBe(false);
    expect(timeline.error()).toBe(ConversationError.Missing);
    expect(timeline.items()).toEqual([]);
  });

  it('keeps a recalled thread root as an exact target', async () => {
    const opening = timeline.open(encodeId('100'), true);
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wire('100'), isDeleted: true, message: null, threadInfo: { replyCount: 2 } }],
    });
    expect(await opening).toBe(true);
    expect(timeline.error()).toBeUndefined();
    expect(timeline.items()).toHaveLength(1);
    expect(await timeline.open(encodeId('100'), true)).toBe(true);
  });

  it('drops the recalled body and the quote snapshots that reference it', async () => {
    const opening = timeline.open(encodeId('100'));
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100'), { ...wire('101'), replyToMessage: { ...wire('100'), mentions: [] } }],
    });
    await opening;
    expect(timeline.items()[1].replyToMessage?.message).toBe('测试消息');
    TestBed.inject(Connection).acceptChange({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: { chatId: testChat.id, messageIds: [encodeId('100')] },
    });
    expect(timeline.items()[0]).toMatchObject({
      isDeleted: true,
      message: undefined,
      attachments: [],
      mentions: [],
      sticker: undefined,
    });
    expect(timeline.items()[1].replyToMessage).toMatchObject({
      isDeleted: true,
      message: undefined,
      attachments: [],
      mentions: [],
      sticker: undefined,
    });
  });

  it('redacts quote snapshots in a page that arrives after the recall event', async () => {
    const opening = timeline.open(encodeId('100'));
    timeline.update({ ...message('100'), isDeleted: true, message: undefined, attachments: [] });
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100'), { ...wire('101'), replyToMessage: { ...wire('100'), mentions: [] } }],
    });
    await opening;
    expect(timeline.items()[1].replyToMessage?.isDeleted).toBe(true);
    expect(timeline.items()[1].replyToMessage?.message).toBeUndefined();
  });

  it('refreshes quote snapshots when the cited message is edited', async () => {
    const opening = timeline.open(encodeId('100'));
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100'), { ...wire('101'), replyToMessage: { ...wire('100'), mentions: [] } }],
    });
    await opening;
    timeline.update({ ...message('100'), message: '编辑后的消息', isEdited: true });
    expect(timeline.items()[0].message).toBe('编辑后的消息');
    expect(timeline.items()[1].replyToMessage).toEqual({
      id: encodeId('100'),
      clientGeneratedId: 'test-message',
      createdAt: '2026-09-05T12:00:00Z',
      sender: { uid: 1, name: '测试用户', gender: 0 },
      message: '编辑后的消息',
      messageType: MessageType.text,
      sticker: undefined,
      attachments: [],
      isDeleted: false,
      mentions: [],
    });
  });

  it('refreshes quote snapshots in a page that arrives after the edit event', async () => {
    const opening = timeline.open(encodeId('100'));
    timeline.update({ ...message('100'), message: '编辑后的消息', isEdited: true });
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('100'), { ...wire('101'), replyToMessage: { ...wire('100'), mentions: [] } }],
    });
    await opening;
    expect(timeline.items()[1].replyToMessage?.message).toBe('编辑后的消息');
  });

  it('keeps updates scoped to the active topic and clears pending updates after navigation', async () => {
    timeline.reset(testChat.id, encodeId('100'));
    const oldOpening = timeline.open(encodeId('100'));
    const oldRequest = messages({ around: '100', threadId: '100' });
    timeline.delete(encodeId('100'));
    timeline.reset(testChat.id, encodeId('200'));
    const opening = timeline.open(encodeId('200'));
    messages({ around: '200', threadId: '200' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [wire('200'), { ...wire('201'), replyRootId: '200' }],
      newerCursor: '201',
    });
    await opening;
    timeline.update({
      ...message('201'),
      replyRootId: encodeId('100'),
      message: 'another topic',
    });
    timeline.update({
      ...message('201'),
      replyRootId: encodeId('200'),
      message: 'this topic',
    });
    oldRequest.flush({ chatSettings: { showMembershipMessages: true }, messages: [wire('100')] });
    expect(timeline.items()[0].isDeleted).toBe(false);
    await oldOpening;
    expect(timeline.items()[0].isDeleted).toBe(false);
    expect(timeline.items()[1].message).toBe('this topic');
  });

  it('preserves reply counts received during loading and removes thread metadata after the last reply is deleted', async () => {
    const update = {
      chatId: testChat.id,
      threadRootId: encodeId('100'),
      replyCount: 3,
      lastReplyAt: testMessage.createdAt,
    };
    const opening = timeline.open(encodeId('100'));
    timeline.updateThread(update);
    messages({ around: '100' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wire('100'), threadInfo: { replyCount: 1 } }],
      newerCursor: '100',
    });
    await opening;
    expect(timeline.items()[0].threadInfo).toEqual({ replyCount: 3 });
    timeline.updateThread({ ...update, chatId: encodeId('999'), replyCount: 0 });
    expect(timeline.items()[0].threadInfo).toEqual({ replyCount: 3 });
    timeline.updateThread({ ...update, replyCount: 0 });
    expect(timeline.items()[0].threadInfo).toBeUndefined();
  });

  it('replays reply count changes for roots arriving in an older page without restoring cleared threads', async () => {
    const oldInfo = { replyCount: 1 };
    const opening = timeline.open(encodeId('101'));
    messages({ around: '101' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [{ ...wire('101'), threadInfo: oldInfo }],
      olderCursor: '101',
      newerCursor: '101',
    });
    await opening;
    const older = timeline.load(PageDirection.Older);
    timeline.updateThread({
      chatId: testChat.id,
      threadRootId: encodeId('100'),
      replyCount: 2,
      lastReplyAt: testMessage.createdAt,
    });
    timeline.updateThread({
      chatId: testChat.id,
      threadRootId: encodeId('101'),
      replyCount: 0,
      lastReplyAt: testMessage.createdAt,
    });
    messages({ before: '101' }).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        { ...wire('100'), threadInfo: oldInfo },
        { ...wire('101'), threadInfo: oldInfo },
      ],
    });
    await older;
    expect(timeline.items()[0].threadInfo).toEqual({ replyCount: 2 });
    expect(timeline.items()[1].threadInfo).toBeUndefined();
    expect(timeline.page()?.newerCursor).toBe(encodeId('101'));
  });
});
