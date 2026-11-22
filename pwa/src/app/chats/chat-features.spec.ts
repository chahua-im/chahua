import { DestroyRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController } from '@ionic/angular';
import { EMPTY, firstValueFrom, takeUntil } from 'rxjs';
import { vi } from 'vitest';
import { RpcApi } from '../../generated/rpc-api';
import {
  FriendPresenceOverride,
  GroupRole,
  ServerWsMessageType,
  type FriendRelationshipResponse,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { RpcErrorCode } from '../api/rpc-error';
import { RpcTestPeer, provideRpcTesting } from '../api/rpc-testing';
import { activeQuery } from '../api/query';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { ChatDetails } from './chat-details/chat-details';
import { ChatSearch } from './chat-search/chat-search';
import { ChatListStore } from './chat-list-store';
import { ChatStore } from './chat-store';
import { DirectorySearch } from './directory-search/directory-search';
import { StartChat, StartChatKind } from './start-chat/start-chat';

describe('Chat feature requests', () => {
  let peer: RpcTestPeer;
  const lists = { refreshChats: vi.fn() };
  const relationships = new Map<number, ReturnType<typeof activeQuery<FriendRelationshipResponse | undefined>>>();
  const store = {
    privacyOverrides$: EMPTY,
    publishPrivacyOverride: vi.fn(),
    relationship: (uid: number) => {
      let query = relationships.get(uid);
      if (!query) {
        query = activeQuery<FriendRelationshipResponse | undefined>(
          TestBed.inject(DestroyRef),
          (cancel) => firstValueFrom(TestBed.inject(RpcApi).friends.getRelationship({ uid }).pipe(takeUntil(cancel))),
          undefined,
        );
        relationships.set(uid, query);
      }
      return query;
    },
    get: vi.fn(),
    membershipPolicy: () => testChat.membershipMessagePolicy,
    isMuted: () => false,
    mutedUntil: () => undefined,
    chatState: vi.fn(),
    invalidate: vi.fn(),
    invalidateReadReceiptPrivacy: vi.fn(),
    ensureDetails: vi.fn().mockResolvedValue(undefined),
  };
  beforeEach(() => {
    relationships.clear();
    lists.refreshChats.mockClear();
    store.get.mockReset();
    store.invalidate.mockClear();
    TestBed.configureTestingModule({
      providers: [
        ...provideRpcTesting(),
        { provide: Connection, useValue: mockRealtime() },
        { provide: ChatListStore, useValue: lists },
        { provide: ChatStore, useValue: store },
        {
          provide: SessionStore,
          useValue: {
            requireChatSettings: SessionStore.prototype.requireChatSettings,
            acceptChatSettings: SessionStore.prototype.acceptChatSettings,
            user: signal(testUser),
            token: signal(undefined),
          },
        },
        { provide: AlertController, useValue: { create: vi.fn() } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('keeps a relationship query inactive until a consumer reads it', async () => {
    const query = activeQuery(
      TestBed.inject(DestroyRef),
      (cancel) => firstValueFrom(TestBed.inject(RpcApi).friends.getRelationship({ uid: 2 }).pipe(takeUntil(cancel))),
      undefined,
    );
    const release = query.activate();
    (await peer.expectAsync('friends.getRelationship', { uid: 2 })).flush({
      peerUid: 2,
      isFriend: false,
      canDm: false,
    });
    await vi.waitFor(() => expect(query.value()?.peerUid).toBe(2));
    release();
  });

  it('fills the search page when only Ionic overscroll extends beyond the viewport', async () => {
    const fixture = TestBed.createComponent(ChatSearch);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const content: HTMLIonContentElement = fixture.nativeElement.querySelector('ion-content');
    const scroll = document.createElement('div');
    Object.defineProperties(scroll, { clientHeight: { value: 600 }, scrollHeight: { value: 601 } });
    vi.spyOn(content, 'getScrollElement').mockResolvedValue(scroll);
    fixture.componentInstance['query'].set('消息');
    fixture.detectChanges();
    (
      await peer.expectAsync('messages.search', (params) => params['q'] === '消息' && !Object.hasOwn(params, 'offset'))
    ).flush({
      chatSettings: { showMembershipMessages: true },
      messages: [],
      nextOffset: 40,
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      peer
        .expect('messages.search', (params) => params['q'] === '消息' && params['offset'] === 40)
        .flush({ chatSettings: { showMembershipMessages: true }, messages: [] });
    });
    await fixture.whenStable();
    peer.expectNone('messages.search');
  });

  it('loads verification on demand and only sends a friend request after confirmation', async () => {
    vi.mocked(TestBed.inject(AlertController).create).mockResolvedValue({
      present: async () => undefined,
      onDidDismiss: async () => ({ role: 'confirm', data: { values: { message: '我是小明' } } }),
    } as unknown as HTMLIonAlertElement);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    (await peer.expectAsync('friends.getRelationship', { uid: 2 })).flush({
      peerUid: 2,
      isFriend: false,
      canDm: false,
    });
    await vi.waitFor(() => expect(fixture.componentInstance['relationship']()).toBeTruthy());
    peer.expectNone('friends.getAddInfo');
    peer.expectNone('friends.createRequest');
    const sending = fixture.componentInstance['addFriend']();
    (await peer.expectAsync('friends.getAddInfo', { uid: 2 })).flush({ mode: 'need_message' });
    (await peer.expectAsync('friends.createRequest', { toUid: 2, message: '我是小明' })).flush({
      id: 1,
      status: 'pending',
    });
    (await peer.expectAsync('friends.getRelationship', { uid: 2 })).flush({
      peerUid: 2,
      isFriend: false,
      hasPendingOutgoingRequest: true,
    });
    await sending;
    expect(fixture.componentInstance['relationship']()?.hasPendingOutgoingRequest).toBe(true);
  });

  it('does not send a friend request when its confirmation is cancelled', async () => {
    vi.mocked(TestBed.inject(AlertController).create).mockResolvedValue({
      present: async () => undefined,
      onDidDismiss: async () => ({ role: 'cancel' }),
    } as unknown as HTMLIonAlertElement);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    (await peer.expectAsync('friends.getRelationship', { uid: 2 })).flush({
      peerUid: 2,
      isFriend: false,
      canDm: false,
    });
    await vi.waitFor(() => expect(fixture.componentInstance['relationship']()).toBeTruthy());
    const adding = fixture.componentInstance['addFriend']();
    (await peer.expectAsync('friends.getAddInfo', { uid: 2 })).flush({ mode: 'direct' });
    await adding;
    peer.expectNone('friends.createRequest');
    expect(fixture.componentInstance['busy']()).toBe(false);
  });

  it.each([false, true])('refreshes the shared relationship after changing blocking from %s', async (blocking) => {
    vi.mocked(TestBed.inject(AlertController).create).mockResolvedValue({
      present: async () => undefined,
      onDidDismiss: async () => ({ role: 'confirm' }),
    } as unknown as HTMLIonAlertElement);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    (await peer.expectAsync('friends.getRelationship', { uid: 2 })).flush({
      peerUid: 2,
      isFriend: true,
      canDm: !blocking,
      blocking,
    });
    await vi.waitFor(() => expect(fixture.componentInstance['relationship']()).toBeTruthy());
    (await peer.expectAsync('friends.getPresenceSettings', { uid: 2 })).flush({
      override: FriendPresenceOverride.inherit,
    });
    (await peer.expectAsync('friends.getReadReceiptSettings', { uid: 2 })).flush({ override: 'inherit' });
    const changing = fixture.componentInstance['blockUser']();
    (await peer.expectAsync(blocking ? 'blocks.delete' : 'blocks.create', { uid: 2 })).flush(null);
    (await peer.expectAsync('friends.getRelationship', { uid: 2 })).flush({
      peerUid: 2,
      isFriend: true,
      canDm: blocking,
      blocking: !blocking,
    });
    await changing;
    expect(fixture.componentInstance['relationship']()?.blocking).toBe(!blocking);
    expect(fixture.componentInstance['busy']()).toBe(false);
  });

  it('shares an existing relationship and reflects refreshes without a second profile snapshot', async () => {
    const query = store.relationship(2);
    const release = query.activate();
    (await peer.expectAsync('friends.getRelationship', { uid: 2 })).flush({ peerUid: 2, isFriend: true, canDm: true });
    await vi.waitFor(() => expect(query.loading()).toBe(false));
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    (await peer.expectAsync('friends.getPresenceSettings', { uid: 2 })).flush({
      override: FriendPresenceOverride.inherit,
    });
    (await peer.expectAsync('friends.getReadReceiptSettings', { uid: 2 })).flush({ override: 'inherit' });
    peer.expectNone('friends.getAddInfo');
    peer.expectNone('friends.getRelationship');
    expect(fixture.componentInstance['relationship']()).toBe(query.value());
    const refresh = query.refresh();
    (await peer.expectAsync('friends.getRelationship', { uid: 2 })).flush({
      peerUid: 2,
      isFriend: false,
      canDm: false,
      blocking: true,
    });
    await refresh;
    expect(fixture.componentInstance['relationship']()?.blocking).toBe(true);
    fixture.destroy();
    release();
  });

  it('does not redeem an invite after its displayed code has been changed', async () => {
    const fixture = TestBed.createComponent(StartChat);
    fixture.componentRef.setInput('kind', StartChatKind.Join);
    fixture.detectChanges();
    fixture.componentInstance['values'].set({ name: '', code: 'abcdefghij' });
    fixture.detectChanges();
    (await peer.expectAsync('invites.getByCode', { inviteCode: 'abcdefghij' })).flush({
      chat: { ...wireChat },
      invite: { code: 'abcdefghij' },
      alreadyMember: false,
      canJoin: true,
    });
    fixture.componentInstance['values'].update((v) => ({ ...v, code: '0123456789' }));
    await fixture.componentInstance['submit']();
    peer.expectNone('invites.redeem');
  });

  it('updates group metadata and refreshes the chat cache', async () => {
    store.get.mockReturnValue({ ...testChat, myRole: GroupRole.admin, description: '旧简介' });
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    (await peer.expectAsync('threads.listForChat', { chatId: wireChat.id, limit: 50, order: 'newest' })).flush({
      threads: [],
    });
    await fixture.whenStable();
    const component = fixture.componentInstance;
    const field = component['Field'].Name;
    component['edit'](field);
    component['fields'].name!.value().value.set('新群名');
    const saving = component['save'](field);
    (await peer.expectAsync('groups.update', { chatId: wireChat.id, name: '新群名' })).flush({
      ...wireChat,
      name: '新群名',
      description: '新简介',
    });
    await saving;
    expect(store.invalidate).toHaveBeenCalled();
    expect(lists.refreshChats).toHaveBeenCalled();
  });

  it('discards outdated directory results instead of replacing a newer search', async () => {
    const fixture = TestBed.createComponent(DirectorySearch);
    fixture.componentRef.setInput('query', 'old');
    fixture.detectChanges();
    const oldGroups = await peer.expectAsync('groups.list', (params) => params['q'] === 'old');
    const oldUsers = await peer.expectAsync('users.search', { q: 'old', limit: 40 });
    fixture.componentRef.setInput('query', 'new');
    fixture.detectChanges();
    (await peer.expectAsync('groups.list', (params) => params['q'] === 'new')).flush({ groups: [] });
    (await peer.expectAsync('users.search', { q: 'new', limit: 40 })).flush({
      members: [{ uid: 3, username: '新结果', gender: 0 }],
      excluded: [],
    });
    oldGroups.flush({ groups: [] });
    oldUsers.flush({ members: [{ uid: 2, username: '旧结果', gender: 0 }], excluded: [] });
    await vi.waitFor(() => expect(fixture.componentInstance['people']()[0]?.uid).toBe(3));
  });

  it('clears a failed directory search when the query is removed', async () => {
    const fixture = TestBed.createComponent(DirectorySearch);
    fixture.componentRef.setInput('query', '查询');
    fixture.detectChanges();
    (await peer.expectAsync('groups.list', (params) => params['q'] === '查询')).error(RpcErrorCode.Unavailable);
    (await peer.expectAsync('users.search', { q: '查询', limit: 40 })).error(RpcErrorCode.Unavailable);
    await vi.waitFor(() => expect(fixture.componentInstance['error']()).toBe(true));
    fixture.componentRef.setInput('query', '');
    fixture.detectChanges();
    expect(fixture.componentInstance['error']()).toBe(false);
    expect(fixture.componentInstance['loading']()).toBe(false);
    peer.expectNone('groups.list');
    peer.expectNone('users.search');
  });
});

it('updates search results after a recall and redacts references in a delayed search page', async () => {
  TestBed.configureTestingModule({ providers: [provideRpcTesting()] });
  const peer = TestBed.inject(RpcTestPeer);
  peer.authenticate();
  const fixture = TestBed.createComponent(ChatSearch);
  const search = fixture.componentInstance;
  const reply = {
    ...wireMessage,
    id: '9007199254741004',
    message: '引用回复',
    replyToMessage: { ...wireMessage, mentions: [] },
  };
  fixture.componentRef.setInput('chatId', testChat.id);
  search['query'].set('消息');
  fixture.detectChanges();
  (
    await peer.expectAsync('messages.search', (params) => params['q'] === '消息' && !Object.hasOwn(params, 'offset'))
  ).flush({ messages: [wireMessage, reply], nextOffset: 40 });
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const preview = element.querySelector('.reply-text');
  expect(preview?.textContent).toBe(wireMessage.message);

  const loading = search['load'](true);
  const delayed = await peer.expectAsync('messages.search', (params) => params['offset'] === 40);
  TestBed.inject(Connection).acceptChange({
    type: ServerWsMessageType.messagesBulkDeleted,
    payload: { chatId: testChat.id, messageIds: [testMessage.id] },
  });
  fixture.detectChanges();
  expect(element.querySelectorAll('app-message')).toHaveLength(1);
  expect(element.querySelector('.reply-text')).toBe(preview);
  expect(preview?.textContent).toBe('消息已删除');

  delayed.flush({ messages: [wireMessage, { ...reply, id: '9007199254741005' }] });
  const checked = await peer.expectAsync('messages.search', (params) => params['offset'] === 39);
  checked.flush({ messages: [reply, { ...reply, id: '9007199254741005' }] });
  await loading;
  fixture.detectChanges();
  expect(element.querySelectorAll('app-message')).toHaveLength(2);
  expect(Array.from(element.querySelectorAll('.reply-text'), (node) => node.textContent)).toEqual([
    '消息已删除',
    '消息已删除',
  ]);
  peer.verify();
});

it.each([false, true])('refills search results after a recall (index already updated: %s)', async (indexUpdated) => {
  TestBed.configureTestingModule({ providers: [provideRpcTesting()] });
  const peer = TestBed.inject(RpcTestPeer);
  peer.authenticate();
  const fixture = TestBed.createComponent(ChatSearch);
  const search = fixture.componentInstance;
  fixture.componentRef.setInput('chatId', testChat.id);
  fixture.detectChanges();
  const content = fixture.nativeElement.querySelector('ion-content') as HTMLIonContentElement;
  const scroll = document.createElement('div');
  const readHeight = vi.fn(() => 1100);
  Object.defineProperties(scroll, { clientHeight: { value: 600 }, scrollHeight: { get: readHeight } });
  vi.spyOn(content, 'getScrollElement').mockResolvedValue(scroll);
  search['query'].set('消息');
  fixture.detectChanges();
  (await peer.expectAsync('messages.search', (params) => params['q'] === '消息')).flush({
    messages: [wireMessage],
    nextOffset: 40,
  });
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(readHeight).toHaveReturnedWith(1100);
  });
  await fixture.whenStable();
  peer.expectNone('messages.search');

  readHeight.mockReturnValue(600);
  TestBed.inject(Connection).acceptChange({
    type: ServerWsMessageType.messagesBulkDeleted,
    payload: { chatId: testChat.id, messageIds: [testMessage.id] },
  });
  fixture.detectChanges();
  const refill = await vi.waitFor(() => {
    fixture.detectChanges();
    return peer.expect('messages.search', (params) => params['offset'] === 39);
  });
  const element = fixture.nativeElement as HTMLElement;
  expect(element.querySelector('.page-loading ion-spinner')).not.toBeNull();
  const older = { ...wireMessage, id: '9007199254741002', message: '仍可搜索到的旧消息' };
  refill.flush({ messages: [older], nextOffset: indexUpdated ? null : 79 });
  if (!indexUpdated) {
    const later = await vi.waitFor(() => {
      fixture.detectChanges();
      return peer.expect('messages.search', (params) => params['offset'] === 78);
    });
    later.flush({ messages: [older, { ...older, id: '9007199254741001', message: '下一页的匹配消息' }] });
  }
  await fixture.whenStable();
  fixture.detectChanges();
  expect(search['messages']().filter(({ message }) => message === older.message)).toHaveLength(1);
  expect(search['messages']()).toHaveLength(indexUpdated ? 1 : 2);
  expect(element.querySelector('.page-loading')).toBeNull();
  peer.verify();
});

it('continues search past a full page of overlapping hits after a batch recall', async () => {
  TestBed.configureTestingModule({ providers: [provideRpcTesting()] });
  const peer = TestBed.inject(RpcTestPeer);
  peer.authenticate();
  const fixture = TestBed.createComponent(ChatSearch);
  const search = fixture.componentInstance;
  fixture.componentRef.setInput('chatId', testChat.id);
  search['query'].set('消息');
  fixture.detectChanges();
  const hits = Array.from({ length: 81 }, (_, index) => ({ ...wireMessage, id: String(1000 + index) }));
  const recalled = hits.slice(0, 40);
  const retained = hits.slice(40, 80);
  (await peer.expectAsync('messages.search')).flush({ messages: recalled, nextOffset: 40 });
  await fixture.whenStable();

  const second = search['load'](true);
  (await peer.expectAsync('messages.search', (params) => params['offset'] === 40)).flush({
    messages: retained,
    nextOffset: 80,
  });
  await second;
  peer.notify('events.messagesBulkDeleted', { chatId: wireChat.id, messageIds: recalled.map(({ id }) => id) });

  const more = search['load'](true);
  // The index still orders the retained hits after the recalled ones.
  (await peer.expectAsync('messages.search', (params) => params['offset'] === 40)).flush({
    messages: retained,
    nextOffset: 80,
  });
  (await peer.expectAsync('messages.search', (params) => params['offset'] === 80)).flush({ messages: hits.slice(80) });
  await more;
  expect(search['messages']()).toHaveLength(41);
  expect(search['cursor']()).toBeUndefined();
  peer.verify();
});
