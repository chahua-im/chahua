import { DestroyRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController } from '@ionic/angular';
import { EMPTY, firstValueFrom, takeUntil } from 'rxjs';
import { vi } from 'vitest';
import { RpcApi } from '../../generated/rpc-api';
import { FriendPresenceOverride, GroupRole, type FriendRelationshipResponse } from '../../generated/models';
import { Connection } from '../api/connection';
import { RpcErrorCode } from '../api/rpc-error';
import { RpcTestPeer, provideRpcTesting } from '../api/rpc-testing';
import { activeQuery } from '../api/query';
import { mockRealtime, testChat, testUser, wireChat } from '../api/testing';
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
    const loading = fixture.componentInstance['lookup']();
    (await peer.expectAsync('invites.getByCode', { inviteCode: 'abcdefghij' })).flush({
      chat: { ...wireChat },
      invite: { code: 'abcdefghij' },
      alreadyMember: false,
    });
    await loading;
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
