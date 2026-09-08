import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController } from '@ionic/angular';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { Subject } from 'rxjs';
import { Router } from '@angular/router';
import { GroupKind, ServerWsMessageType, type ServerWsMessage } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat } from '../../api/testing';
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
    http.expectOne((req) => req.url.includes('/attachments')).flush({ attachments: [] });
    await fixture.whenStable();
    return fixture;
  }

  it('shares mute updates with the list and reflects websocket changes without another detail request', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    const muting = component['toggleMute']();
    await component['toggleMute'](); // A second tap while busy must not submit a duplicate.
    http
      .expectOne({ method: 'PUT', url: `/_api/group/${wireChat.id}/mute` })
      .flush({ mutedUntil: '9999-12-31T23:59:59Z', archived: false });
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
    const nextId = encodeId('9007199254741993');
    fixture.componentRef.setInput('chatId', nextId);
    fixture.detectChanges();
    http.expectOne(`/_api/group/${decodeId(nextId)}`).flush({ ...wireChat, id: decodeId(nextId), name: '当前群' });
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.includes('/attachments')).flush({ attachments: [] });
    previous.flush({ ...wireChat });
    await fixture.whenStable();
    expect(fixture.componentInstance['chat']()?.name).toBe('当前群');
  });

  it('shows the thread author badge and title without fetching the root again', async () => {
    const fixture = await open();
    fixture.componentRef.setInput('threadId', testMessage.id);
    fixture.componentRef.setInput('threadRoot', testMessage);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testMessage.message);
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
    http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true });
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.includes('/attachments')).flush({ attachments: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-actions').textContent).toContain('删除好友');
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
