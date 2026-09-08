import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, IonActionSheet } from '@ionic/angular';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { GroupKind, ServerWsMessageType, type ServerWsMessage } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../../api/testing';
import { SessionStore } from '../../session/session-store';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { ChatDetails } from './chat-details';

describe('ChatDetails', () => {
  let http: HttpTestingController;
  const events = new Subject<ServerWsMessage>();
  const realtime = mockRealtime({ events$: events });
  const alert = { present: vi.fn(), onDidDismiss: vi.fn() };
  beforeEach(() => {
    vi.spyOn(IonActionSheet.prototype, 'present').mockResolvedValue();
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockResolvedValue({ role: 'selected', data: { seconds: 3600 } });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: realtime },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: ChatListStore, useValue: { refreshChats: vi.fn() } },
        { provide: AlertController, useValue: { create: vi.fn().mockResolvedValue(alert) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function open(chat = { ...wireChat, mutedUntil: undefined as string | undefined }) {
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http.expectOne(`/_api/group/${wireChat.id}`).flush(chat);
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('places topics and members before media and loads only the selected content', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    const labels = () =>
      [...fixture.nativeElement.querySelectorAll('ion-segment-button')].map((el: Element) => el.textContent?.trim());
    expect(labels()).toEqual(['话题', '成员', '图片', '视频', '文件']);
    http.expectNone((req) => req.url.endsWith('/members') || req.url.endsWith('/messages'));
    component['changeTab']('members');
    fixture.detectChanges();
    http
      .expectOne((req) => req.url === `/_api/group/${wireChat.id}/members`)
      .flush({ members: [], canManageMembers: false });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-chat-members')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-chat-attachments')).toBeNull();
    component['changeTab']('threads');
    fixture.detectChanges();
    http
      .expectOne((req) => req.url === `/_api/chats/${wireChat.id}/messages`)
      .flush({ messages: [{ ...wireMessage, threadInfo: { replyCount: 2 } }] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-chat-threads').textContent).toContain('测试消息');
    component['changeTab']('video');
    fixture.detectChanges();
    http
      .expectOne((req) => req.url.endsWith('/attachments') && req.params.get('kind') === 'video')
      .flush({ attachments: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('ion-segment')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('app-chat-threads')).toBeNull();
  });

  it('shows cached information and loads media while details are still pending', async () => {
    const store = TestBed.inject(ChatStore);
    store.acceptChats([{ ...testChat, mutedUntil: '9999-12-31T23:59:59Z' }], store.snapshot());
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const details = http.expectOne(`/_api/group/${wireChat.id}`);
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testChat.name);
    expect(fixture.componentInstance['chat']()).toBe(store.get(testChat.id));
    expect(fixture.componentInstance['busy']()).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('.quick-actions ion-button')[1].textContent.trim()).toBe('永久');
    expect(fixture.nativeElement.querySelector('ion-content > .loading-status')).toBeNull();
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    details.flush({ ...wireChat, description: '群介绍' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.profile p').textContent.trim()).toBe('群介绍');
  });

  it('reuses shared details when the panel is reopened', async () => {
    const first = await open();
    first.destroy();
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testChat.name);
    http.expectNone(`/_api/group/${wireChat.id}`);
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('keeps cached information and media available after detail loading fails', async () => {
    TestBed.inject(ChatStore).remember([testChat]);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    http.expectOne(`/_api/group/${wireChat.id}`).flush({}, { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(fixture.componentInstance['error']()).toBe(true));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testChat.name);
    expect(fixture.nativeElement.querySelector('app-chat-threads').textContent).toContain('暂无话题');
    expect(fixture.componentInstance['error']()).toBe(true);
    const retry = fixture.componentInstance['load']();
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat });
    await retry;
    expect(fixture.componentInstance['error']()).toBe(false);
    http.expectNone((req) => req.url.endsWith('/messages'));
  });

  it('loads a known peer relationship in parallel without blocking the profile or media', async () => {
    const peer = { uid: 2, username: '朋友', gender: 0 };
    TestBed.inject(ChatStore).remember([{ ...testChat, kind: GroupKind.dm, peer }]);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const details = http.expectOne(`/_api/group/${wireChat.id}`);
    await Promise.resolve();
    const relationship = http.expectOne('/_api/friends/2');
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe('朋友');
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    details.flush({ ...wireChat, kind: GroupKind.dm, peer });
    await vi.waitFor(() => expect(fixture.componentInstance['chat']()?.kind).toBe(GroupKind.dm));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-content > .loading-status')).toBeNull();
    relationship.flush({ peerUid: 2, isFriend: true });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-actions').textContent).toContain('删除好友');
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-segment-button')].map((el: Element) => el.textContent?.trim()),
    ).toEqual(['话题', '图片', '视频', '文件']);
  });

  it('shows an uncached profile before its friend relationship arrives', async () => {
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-content > .loading-status')).not.toBeNull();
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    http
      .expectOne(`/_api/group/${wireChat.id}`)
      .flush({ ...wireChat, kind: GroupKind.dm, peer: { uid: 2, username: '朋友', gender: 0 } });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.profile h2')?.textContent.trim()).toBe('朋友');
    });
    expect(fixture.nativeElement.querySelector('ion-content > .loading-status')).toBeNull();
    http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true });
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('shares mute updates with the list and reflects websocket changes without another detail request', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    const muting = component['toggleMute']();
    await component['toggleMute'](); // A second tap while busy must not submit a duplicate.
    await vi.waitFor(() => {
      const request = http.expectOne({ method: 'PUT', url: `/_api/group/${wireChat.id}/mute` });
      expect(request.request.body).toEqual({ durationSeconds: 3600 });
      request.flush({ mutedUntil: '9999-12-31T23:59:59Z', archived: false });
    });
    await muting;
    expect(component['muted']()).toBe(true);
    expect(TestBed.inject(ChatStore).chatState(testChat.id)?.mutedUntil).toBe('9999-12-31T23:59:59Z');
    events.next({
      type: ServerWsMessageType.chatArchiveStateChanged,
      payload: { chatId: testChat.id, archived: false },
    });
    expect(component['muted']()).toBe(false);
  });

  it('uses detail mute state when opening a chat missing from the list', async () => {
    const fixture = await open({ ...wireChat, mutedUntil: '9999-12-31T23:59:59Z' });
    expect(fixture.componentInstance['muted']()).toBe(true);
    realtime.accept(testMessage); // A message preview does not provide mute state.
    expect(fixture.componentInstance['muted']()).toBe(true);
    const unmuting = fixture.componentInstance['toggleMute']();
    http.expectOne({ method: 'DELETE', url: `/_api/group/${wireChat.id}/mute` }).flush(null);
    await unmuting;
    expect(fixture.componentInstance['muted']()).toBe(false);
  });

  it('keeps the newest chat when a previous detail request completes later', async () => {
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const previous = http.expectOne(`/_api/group/${wireChat.id}`);
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    const nextId = encodeId('9007199254741993');
    fixture.componentRef.setInput('chatId', nextId);
    fixture.detectChanges();
    http.expectOne(`/_api/group/${decodeId(nextId)}`).flush({ ...wireChat, id: decodeId(nextId), name: '当前群' });
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    previous.flush({ ...wireChat });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['chat']()?.name).toBe('当前群');
  });

  it('shows the thread author badge and title without fetching the root again', async () => {
    const fixture = await open();
    fixture.componentRef.setInput('threadId', testMessage.id);
    fixture.componentRef.setInput('threadRoot', testMessage);
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/attachments')).flush({ attachments: [] });
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testMessage.message);
    http
      .expectOne(`/_api/chats/${wireChat.id}/threads/${decodeId(testMessage.id)}/subscribe`)
      .flush({ subscribed: true, archived: false });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-actions').textContent).toContain('取消订阅');
    expect(fixture.nativeElement.querySelector('.quick-actions').textContent).not.toContain('静音');
    expect(fixture.nativeElement.querySelector('.avatar-badge').textContent.trim()).toBe('测');
    expect(fixture.nativeElement.querySelector('app-chat-avatar').style.getPropertyValue('--avatar-size')).toBe('88px');
  });

  it('deletes a confirmed friend through the friend endpoint, not the group member endpoint', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http
      .expectOne(`/_api/group/${wireChat.id}`)
      .flush({ ...wireChat, kind: GroupKind.dm, peer: { uid: 2, username: '朋友', gender: 0 } });
    await Promise.resolve();
    await vi.waitFor(() => http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true }));
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/messages')).flush({ messages: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-actions').textContent).toContain('删除好友');
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-segment-button')].map((el: Element) => el.textContent?.trim()),
    ).toEqual(['话题', '图片', '视频', '文件']);
    alert.onDidDismiss.mockResolvedValue({ role: 'confirm' });
    const deleting = fixture.componentInstance['leave']();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne({ method: 'DELETE', url: '/_api/friends/2' }).flush(null);
    await deleting;
    expect(navigate).toHaveBeenCalledWith(['/chats']);
    expect(fixture.componentInstance['error']()).toBe(false);
  });

  it('does not leave a group when the confirmation is cancelled', async () => {
    const fixture = await open();
    alert.onDidDismiss.mockResolvedValue({ role: 'cancel' });
    await fixture.componentInstance['leave']();
    http.expectNone((req) => req.method === 'DELETE');
    expect(fixture.componentInstance['busy']()).toBe(false);
  });
});
