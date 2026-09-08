import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { GroupVisibility } from '../../generated/models';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { ChatListStore } from './chat-list-store';
import { ChatStore } from './chat-store';
import { SessionStore } from '../session/session-store';
import { testUser, testChat, wireChat } from '../api/testing';
import { UserProfile } from './user-profile/user-profile';
import { StartChat, StartChatKind } from './start-chat/start-chat';
import { ChatDetails } from './chat-details/chat-details';
import { DirectorySearch } from './directory-search/directory-search';
describe('Chat feature requests', () => {
  let http: HttpTestingController;
  const lists = { refreshChats: vi.fn() };
  const store = { chatState: vi.fn(), invalidate: vi.fn(), ensureDetails: vi.fn().mockResolvedValue(undefined) };
  beforeEach(() => {
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
  it('only submits a friend request after explicit action and includes the verification message', async () => {
    const fixture = TestBed.createComponent(UserProfile);
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.detectChanges();
    const requests = http.match((req) => req.method === 'GET');
    expect(requests).toHaveLength(2);
    for (const request of requests)
      request.flush(
        request.request.url.includes('add-info')
          ? { mode: 'need_message' }
          : {
              peerUid: 2,
              isFriend: false,
              blocking: false,
              blockedBy: false,
              canDm: false,
              hasPendingOutgoingRequest: false,
            },
      );
    await vi.waitFor(() => expect(fixture.componentInstance['busy']()).toBe(false));
    expect(http.match((req) => req.method === 'POST')).toHaveLength(0);
    fixture.componentInstance['data'].set({ message: '我是小明' });
    const sending = fixture.componentInstance['send']();
    const request = http.expectOne((req) => req.method === 'POST');
    expect(request.request.body).toEqual({ toUid: 2, message: '我是小明' });
    request.flush({ id: 1, status: 'pending' });
    await Promise.resolve();
    await Promise.resolve();
    for (const request of http.match((req) => req.method === 'GET'))
      request.flush(
        request.request.url.includes('add-info')
          ? { mode: 'need_message' }
          : { peerUid: 2, isFriend: false, hasPendingOutgoingRequest: true },
      );
    await sending;
    expect(fixture.componentInstance['sent']()).toBe(true);
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
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http.expectOne((req) => req.method === 'GET').flush({ ...wireChat, myRole: 'admin', description: '旧简介' });
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.includes('/attachments')).flush({ attachments: [] });
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
});
