import { HttpTestingController } from '@angular/common/http/testing';
import { DestroyRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, takeUntil } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { FriendsService } from '../../generated/endpoints/friends/friends.service';
import type { FriendRelationshipResponse } from '../../generated/models';
import { GroupRole, GroupVisibility } from '../../generated/models';
import { activeQuery } from '../api/query';
import { testChat, testUser, wireChat } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { ChatDetails } from './chat-details/chat-details';
import { ChatListStore } from './chat-list-store';
import { ChatStore } from './chat-store';
import { DirectorySearch } from './directory-search/directory-search';
import { StartChat, StartChatKind } from './start-chat/start-chat';
import { AlertController } from '@ionic/angular';
describe('Chat feature requests', () => {
  let http: HttpTestingController;
  const lists = { refreshChats: vi.fn() };
  const relationships = new Map<number, ReturnType<typeof activeQuery<FriendRelationshipResponse | undefined>>>();
  const store = {
    relationship: (uid: number) => {
      let query = relationships.get(uid);
      if (!query) {
        query = activeQuery<FriendRelationshipResponse | undefined>(
          TestBed.inject(DestroyRef),
          (cancel) => firstValueFrom(TestBed.inject(FriendsService).getFriendRelationship(uid).pipe(takeUntil(cancel))),
          undefined,
        );
        relationships.set(uid, query);
      }
      return query;
    },
    get: vi.fn(),
    isMuted: () => false,
    mutedUntil: () => undefined,
    chatState: vi.fn(),
    invalidate: vi.fn(),
    ensureDetails: vi.fn().mockResolvedValue(undefined),
  };
  beforeEach(() => {
    relationships.clear();
    TestBed.configureTestingModule({
      providers: [
        provideChahuaBaseUrl('/_api'),
        { provide: ChatListStore, useValue: lists },
        { provide: ChatStore, useValue: store },
        { provide: SessionStore, useValue: { user: signal(testUser), token: signal(undefined) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  it('loads verification on demand and only sends a friend request after confirmation', async () => {
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => undefined,
      onDidDismiss: async () => ({ role: 'confirm', data: { values: { message: '我是小明' } } }),
    } as unknown as HTMLIonAlertElement);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    await Promise.resolve();
    http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: false, canDm: false });
    await vi.waitFor(() => expect(fixture.componentInstance['relationship']()).toBeTruthy());
    http.expectNone('/_api/friends/add-info/2');
    http.expectNone((req) => req.method === 'POST');
    const sending = fixture.componentInstance['addFriend']();
    http.expectOne('/_api/friends/add-info/2').flush({ mode: 'need_message' });
    await vi.waitFor(() => {
      const request = http.expectOne((req) => req.method === 'POST');
      expect(request.request.body).toEqual({ toUid: 2, message: '我是小明' });
      request.flush({ id: 1, status: 'pending' });
    });
    await vi.waitFor(() =>
      http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: false, hasPendingOutgoingRequest: true }),
    );
    await sending;
    expect(fixture.componentInstance['relationship']()?.hasPendingOutgoingRequest).toBe(true);
  });
  it('does not send a friend request when its confirmation is cancelled', async () => {
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => undefined,
      onDidDismiss: async () => ({ role: 'cancel' }),
    } as unknown as HTMLIonAlertElement);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    await Promise.resolve();
    http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: false, canDm: false });
    await vi.waitFor(() => expect(fixture.componentInstance['relationship']()).toBeTruthy());
    const adding = fixture.componentInstance['addFriend']();
    http.expectOne('/_api/friends/add-info/2').flush({ mode: 'direct' });
    await adding;
    http.expectNone((req) => req.method === 'POST');
    expect(fixture.componentInstance['busy']()).toBe(false);
  });
  it.each([false, true])('refreshes the shared relationship after changing blocking from %s', async (blocking) => {
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => undefined,
      onDidDismiss: async () => ({ role: 'confirm' }),
    } as unknown as HTMLIonAlertElement);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    await Promise.resolve();
    http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true, canDm: !blocking, blocking });
    await vi.waitFor(() => expect(fixture.componentInstance['relationship']()).toBeTruthy());
    const changing = fixture.componentInstance['blockUser']();
    await vi.waitFor(() => {
      const request = http.expectOne((req) => req.method === (blocking ? 'DELETE' : 'POST'));
      expect(request.request.url).toBe(blocking ? '/_api/blocks/2' : '/_api/blocks');
      if (!blocking) expect(request.request.body).toEqual({ uid: 2 });
      request.flush(null);
    });
    await vi.waitFor(() =>
      http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true, canDm: blocking, blocking: !blocking }),
    );
    await changing;
    expect(fixture.componentInstance['relationship']()?.blocking).toBe(!blocking);
    expect(fixture.componentInstance['busy']()).toBe(false);
  });
  it('shares an existing relationship and reflects refreshes without a second profile snapshot', async () => {
    const query = store.relationship(2);
    const release = query.activate();
    await Promise.resolve();
    http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true, canDm: true });
    await vi.waitFor(() => expect(query.loading()).toBe(false));
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    http.expectNone('/_api/friends/add-info/2');
    http.expectNone('/_api/friends/2');
    expect(fixture.componentInstance['relationship']()).toBe(query.value());
    const refresh = query.refresh();
    await Promise.resolve();
    http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: false, canDm: false, blocking: true });
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
    http
      .expectOne((req) => req.method === 'GET')
      .flush({ chat: { ...wireChat }, invite: { code: 'abcdefghij' }, alreadyMember: false });
    await loading;
    fixture.componentInstance['values'].update((v) => ({ ...v, code: '0123456789' }));
    await fixture.componentInstance['submit']();
    expect(http.match((req) => req.method === 'POST')).toHaveLength(0);
  });
  it('updates group metadata through the existing patch endpoint and refreshes the chat cache', async () => {
    store.get.mockReturnValue({ ...testChat, myRole: GroupRole.admin, description: '旧简介' });
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    await fixture.whenStable();
    fixture.componentInstance['values'].set({
      name: '新群名',
      description: '新简介',
      visibility: GroupVisibility.public,
    });
    const saving = fixture.componentInstance['save']();
    const request = http.expectOne((req) => req.method === 'PATCH');
    expect(request.request.body).toEqual({ name: '新群名', description: '新简介', visibility: GroupVisibility.public });
    request.flush({ ...wireChat, name: '新群名', description: '新简介' });
    await saving;
    expect(store.invalidate).toHaveBeenCalled();
    expect(lists.refreshChats).toHaveBeenCalled();
  });
  it('discards outdated directory results instead of replacing a newer search', async () => {
    const fixture = TestBed.createComponent(DirectorySearch);
    fixture.componentRef.setInput('query', 'old');
    fixture.detectChanges();
    const old = http.match((req) => req.method === 'GET');
    expect(old).toHaveLength(2);
    fixture.componentRef.setInput('query', 'new');
    fixture.detectChanges();
    const newer = http.match((req) => req.method === 'GET');
    for (const request of newer)
      request.flush(
        request.request.url.includes('/users/')
          ? { members: [{ uid: 3, username: '新结果', gender: 0 }], excluded: [] }
          : { groups: [] },
      );
    for (const request of old)
      request.flush(
        request.request.url.includes('/users/')
          ? { members: [{ uid: 2, username: '旧结果', gender: 0 }], excluded: [] }
          : { groups: [] },
      );
    await vi.waitFor(() => expect(fixture.componentInstance['people']()[0]?.uid).toBe(3));
  });
  it('clears a failed directory search when the query is removed', async () => {
    const fixture = TestBed.createComponent(DirectorySearch);
    fixture.componentRef.setInput('query', '查询');
    fixture.detectChanges();
    for (const request of http.match((req) => req.method === 'GET'))
      request.flush({}, { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(fixture.componentInstance['error']()).toBe(true));
    fixture.componentRef.setInput('query', '');
    fixture.detectChanges();
    expect(fixture.componentInstance['error']()).toBe(false);
    expect(fixture.componentInstance['loading']()).toBe(false);
    http.expectNone((req) => req.method === 'GET');
  });
});
