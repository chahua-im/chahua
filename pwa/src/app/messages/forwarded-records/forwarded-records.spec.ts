import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { jsonInterceptor } from '../../api/json.interceptor';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { mockRealtime, wireChat, wireMessage, testUser, testChat, testMessage } from '../../api/testing';
import { Connection, ResyncReason } from '../../api/connection';
import { ChatChangeKind, ChatStore } from '../../chats/chat-store';
import { ServerWsMessageType, type ServerWsMessage } from '../../../generated/models';
import { Subject } from 'rxjs';
import { SessionStore } from '../../session/session-store';
import { By } from '@angular/platform-browser';
import { signal } from '@angular/core';
import { Preferences } from '../../settings/preferences';
import { Message } from '../message/message';
import { ForwardedRecords } from './forwarded-records';

const record = {
  originalMessageId: wireMessage.id,
  originalChatId: wireChat.id,
  originalCreatedAt: wireMessage.createdAt,
  message: 'captured content',
  messageType: 'text',
  sender: wireMessage.sender,
  attachments: [],
};

describe('ForwardedRecords', () => {
  let events: Subject<ServerWsMessage>;
  let resync: Subject<ResyncReason>;
  let changes: Subject<{ kind: ChatChangeKind; chatId: typeof testChat.id; threadId?: typeof testChat.id }>;
  const release = vi.fn();
  const watchReadStates = vi.fn(() => release);
  beforeEach(() => {
    events = new Subject();
    resync = new Subject();
    changes = new Subject();
    release.mockClear();
    watchReadStates.mockClear();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Preferences, useValue: { showAllAvatars: signal(false) } },
        { provide: Connection, useValue: mockRealtime({ events$: events, resync$: resync }) },
        { provide: ChatStore, useValue: { changes$: changes, watchReadStates } },
      ],
    });
    TestBed.inject(SessionStore).user.set(testUser);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders captured internal replies, redacted external replies and navigates only within the authorized root', async () => {
    const fixture = TestBed.createComponent(ForwardedRecords);
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.componentRef.setInput('messageId', wireMessage.id);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}/forwarded-messages`).flush({
      total: 3,
      messages: [
        structuredClone(record),
        {
          ...record,
          originalMessageId: '100',
          message: 'reply',
          reply: { kind: 'internal', originalMessageId: wireMessage.id, preview: structuredClone(record) },
        },
        {
          ...record,
          originalMessageId: '101',
          messageType: 'forwarded',
          forwardedBundleId: '9007199254741999',
          forwardedPreview: { total: 2, containsForwardedMessages: false, messages: [structuredClone(record)] },
          reply: { kind: 'redacted' },
        },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('引用内容已隐藏');
    expect(fixture.nativeElement.querySelector('.reply-preview').textContent).toContain('captured content');
    expect(fixture.nativeElement.querySelector('.reply-button')).toBeNull();
    const locate = vi.fn();
    fixture.nativeElement.querySelector(`[data-message-id="${wireMessage.id}"]`).scrollIntoView = locate;
    fixture.nativeElement.querySelector('.reply-preview').click();
    expect(locate).toHaveBeenCalled();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.nativeElement.querySelector('.forwarded-card').click();
    expect(navigate).toHaveBeenCalledWith([
      '/chats/chat',
      wireChat.id,
      'message',
      wireMessage.id,
      'forwarded',
      '9007199254741999',
    ]);
    http.verify();
  });

  it('loads saved child records using saved ownership without requesting the original chat', async () => {
    const fixture = TestBed.createComponent(ForwardedRecords);
    fixture.componentRef.setInput('savedId', '9223372036854775806');
    fixture.componentRef.setInput('bundleId', '9223372036854775805');
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne('/_api/saved-messages/9223372036854775806/forwarded-bundles/9223372036854775805/messages')
      .flush({ total: 1, messages: [structuredClone(record)] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('captured content');
    http.verify();
  });
  it('uses conversation grouping while disabling profiles and message actions, keeping content browsing', async () => {
    TestBed.inject(SessionStore).user.set(testUser);
    const fixture = TestBed.createComponent(ForwardedRecords);
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.componentRef.setInput('messageId', wireMessage.id);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}/forwarded-messages`).flush({
      total: 2,
      messages: [
        {
          ...record,
          sender: { uid: testUser.uid, name: 'Me' },
          message: '@[uid:2] https://example.com',
          mentions: [{ uid: 2, username: 'Other' }],
        },
        {
          ...record,
          sender: { uid: testUser.uid, name: 'Me' },
          originalMessageId: '102',
          message: '**@[uid:2]**',
          mentions: [{ uid: 2, username: 'Other' }],
        },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const messages = fixture.debugElement.queryAll(By.directive(Message)).map((el) => el.componentInstance as Message);
    expect(messages.map((message) => [message.first(), message.last(), message.own()])).toEqual([
      [true, false, true],
      [false, true, true],
    ]);
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.message-date')).toHaveLength(1);
    expect(element.querySelector('ion-back-button')).not.toBeNull();
    expect(element.querySelector('app-message-composer, .reply-button, button.mention')).toBeNull();
    expect(element.querySelector('a[href="https://example.com"]')).not.toBeNull();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    element.querySelector<HTMLElement>('.sender')!.click();
    element.querySelector<HTMLElement>('.avatar')!.click();
    expect(navigate).not.toHaveBeenCalled();
    for (const message of messages) {
      const menu = vi.fn();
      const reply = vi.fn();
      message.menu.subscribe(menu);
      message.reply.subscribe(reply);
      element.querySelector('.bubble')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      expect(menu).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(message['status']()).toBeUndefined();
    }
    http.verify();
  });
  it('ignores an earlier bundle response after the authorized record scope changes', async () => {
    const fixture = TestBed.createComponent(ForwardedRecords);
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.componentRef.setInput('messageId', wireMessage.id);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const root = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}/forwarded-messages`);
    fixture.componentRef.setInput('bundleId', '103');
    fixture.detectChanges();
    const child = http.expectOne(
      `/_api/chats/${wireChat.id}/messages/${wireMessage.id}/forwarded-bundles/103/messages`,
    );
    child.flush({ total: 1, messages: [{ ...record, message: 'child content' }] });
    await fixture.whenStable();
    root.flush({ total: 1, messages: [structuredClone(record)] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('child content');
    expect(fixture.nativeElement.textContent).not.toContain('captured content');
    http.verify();
  });

  function root() {
    const fixture = TestBed.createComponent(ForwardedRecords);
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.componentRef.setInput('messageId', wireMessage.id);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const url = `/_api/chats/${wireChat.id}/messages/${wireMessage.id}/forwarded-messages`;
    const request = http.expectOne(url);
    return { fixture, http, url, request };
  }

  it.each(['single', 'bulk', 'membership'])(
    'clears loaded records on %s revocation and rejects an in-flight refresh',
    async (kind) => {
      const { fixture, http, url, request } = root();
      request.flush({ total: 1, messages: [record] });
      await fixture.whenStable();
      fixture.detectChanges();
      const node = fixture.nativeElement.querySelector('app-message');
      resync.next(ResyncReason.Connected);
      const refresh = http.expectOne(url);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
      if (kind === 'single')
        events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
      else if (kind === 'bulk')
        events.next({
          type: ServerWsMessageType.messagesBulkDeleted,
          payload: {
            chatId: testChat.id,
            messageIds: [testMessage.id],
          },
        });
      else changes.next({ kind: ChatChangeKind.Removed, chatId: testChat.id });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-message')).toBeNull();
      expect(fixture.componentInstance['unavailable']()).toBe(true);
      refresh.flush({ total: 1, messages: [record] });
      await fixture.whenStable();
      expect(fixture.componentInstance['data']()).toBeUndefined();
      http.verify();
    },
  );

  it('keeps known records and DOM during reconnect and transient failures, but clears confirmed access loss', async () => {
    const { fixture, http, url, request } = root();
    request.flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    fixture.detectChanges();
    const node = fixture.nativeElement.querySelector('app-message');
    resync.next(ResyncReason.Connected);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    http.expectOne(url).flush('Temporary failure', { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    resync.next(ResyncReason.Connected);
    http.expectOne(url).flush('Forbidden', { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBeNull();
    expect(fixture.componentInstance['unavailable']()).toBe(true);
    http.verify();
  });

  it('drops old account data and ignores its delayed response', async () => {
    const { fixture, http, url, request } = root();
    TestBed.inject(SessionStore).user.set({ ...testUser, uid: 2 });
    fixture.detectChanges();
    const current = http.expectOne(url);
    expect(fixture.componentInstance['data']()).toBeUndefined();
    current.flush({ total: 1, messages: [{ ...record, message: 'new account' }] });
    await fixture.whenStable();
    request.flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    expect(fixture.componentInstance['data']()?.messages[0].message).toBe('new account');
    http.verify();
  });

  it('defers reconnect validation while covered and releases its membership watch', async () => {
    const { fixture, http, url, request } = root();
    request.flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    expect(watchReadStates).toHaveBeenCalledWith([{ chatId: testChat.id }]);
    fixture.componentInstance.ionViewWillLeave();
    fixture.detectChanges();
    expect(release).toHaveBeenCalled();
    resync.next(ResyncReason.Connected);
    http.expectNone(url);
    fixture.componentInstance.ionViewWillEnter();
    http.expectOne(url).flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    http.verify();
  });

  it('keeps saved records readable after source deletion or membership loss', async () => {
    const fixture = TestBed.createComponent(ForwardedRecords);
    fixture.componentRef.setInput('savedId', '123');
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/_api/saved-messages/123/forwarded-messages').flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    changes.next({ kind: ChatChangeKind.Removed, chatId: testChat.id });
    expect(fixture.componentInstance['data']()?.messages).toHaveLength(1);
    expect(watchReadStates).not.toHaveBeenCalled();
    http.verify();
  });
});
