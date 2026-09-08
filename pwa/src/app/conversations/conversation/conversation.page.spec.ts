import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, RouterLink } from '@angular/router';
import { IonContent, IonModal, IonTextarea } from '@ionic/angular';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { PinsService } from '../../../generated/endpoints/pins/pins.service';
import {
  AttachmentUploadPurpose,
  GroupRole,
  MessageType,
  ServerWsMessageType,
  type MessageResponse,
  type ServerWsMessage,
  type ThreadSubscriptionStatusResponse,
} from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../../api/testing';
import { ChatStore } from '../../chats/chat-store';
import { MessageDelivery } from '../../messages/message-delivery';
import { MessageAction } from '../../messages/message-menu/message-menu';
import { MessageNotice } from '../../messages/message-notice';
import { MessageOutbox } from '../../messages/message-outbox';
import { Message, type MessageContent } from '../../messages/message/message';
import { UploadStatus, type AttachmentUpload } from '../../messages/upload';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ConversationNavigation, ConversationTargetKind } from '../conversation-navigation';
import { ConversationError, PageDirection } from '../conversation-store';
import { DraftStore } from '../draft-store';
import { ConversationPage, ThreadError } from './conversation.page';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ConversationPage', () => {
  let component: ConversationPage;
  let fixture: ComponentFixture<ConversationPage>;
  let http: HttpTestingController;
  let incoming: Subject<MessageResponse>;
  let events: Subject<ServerWsMessage>;
  let resync: Subject<void>;
  let subscriptions: WritableSignal<Map<SnowflakeID, ThreadSubscriptionStatusResponse>>;
  let scroll: HTMLElement;
  const avatars = signal(false);
  beforeEach(async () => {
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.spyOn(IonModal.prototype, 'isOpen', 'set').mockImplementation(() => {});
    avatars.set(false);
    incoming = new Subject<MessageResponse>();
    events = new Subject<ServerWsMessage>();
    resync = new Subject<void>();
    subscriptions = signal(new Map());
    scroll = document.createElement('div');
    vi.spyOn(IonContent.prototype, 'getScrollElement').mockResolvedValue(scroll);
    await TestBed.configureTestingModule({
      imports: [ConversationPage],
      providers: [
        provideRouter([]),
        { provide: Connection, useValue: mockRealtime({ messages$: incoming, events$: events, resync$: resync }) },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: Preferences, useValue: { showAllAvatars: avatars } },
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
      ],
    }).compileComponents();
    vi.spyOn(TestBed.inject(PinsService), 'listPins').mockImplementation((() =>
      of({ pins: [] })) as unknown as PinsService['listPins']);
    vi.spyOn(TestBed.inject(PinsService), 'listThreadPins').mockImplementation((() =>
      of({ pins: [] })) as unknown as PinsService['listThreadPins']);
    vi.spyOn(TestBed.inject(Router), 'isActive').mockReturnValue(true);
    Object.assign(TestBed.inject(ChatStore), {
      threadReadState: vi.fn().mockReturnValue(undefined),
      subscription: (_chatId: SnowflakeID, rootId: SnowflakeID) => subscriptions().get(rootId),
      loadSubscription: vi.fn().mockResolvedValue(undefined),
      markThreadRead: vi.fn().mockResolvedValue(undefined),
      setThreadArchived: vi.fn().mockResolvedValue(undefined),
      subscribeThread: vi.fn().mockResolvedValue(undefined),
      cachedReadState: vi
        .fn()
        .mockReturnValue({ lastReadMessageId: testChat.lastReadMessageId, unreadCount: testChat.unreadCount }),
      refreshChats: vi.fn(),
      markRead: vi.fn().mockResolvedValue(undefined),
      getReadState: vi.fn().mockResolvedValue({ unreadCount: 0 }),
    });
    TestBed.inject(ChatStore).remember([testChat]);
    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.detectChanges();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
      .flush({ messages: [{ ...wireMessage }], olderCursor: wireMessage.id });
    await fixture.whenStable();
    fixture.detectChanges();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    http.verify();
  });

  function typeText(text: string) {
    const textarea = fixture.debugElement.query(By.directive(IonTextarea));
    expect((textarea.componentInstance as IonTextarea).disabled).toBeFalsy();
    textarea.nativeElement.value = text;
    textarea.nativeElement.dispatchEvent(new CustomEvent('ionInput', { bubbles: true, detail: { value: text } }));
    fixture.detectChanges();
  }

  function pendingUpload(fileName = 'edit.png') {
    const result = deferred<SnowflakeID | undefined>();
    const state = signal<{ status: UploadStatus; progress: number; id?: SnowflakeID }>({
      status: UploadStatus.Uploading,
      progress: 0.25,
    });
    const upload = {
      file: new File(['photo'], fileName, { type: 'image/png' }),
      url: `data:image/png;base64,iVBORw0KGgo=#${encodeURIComponent(fileName)}`,
      purpose: AttachmentUploadPurpose.media,
      state,
      retry: vi.fn(() => result.promise),
      dispose: vi.fn(),
    };
    return {
      upload: upload as unknown as AttachmentUpload,
      progress(value: number) {
        state.update((current) => ({ ...current, progress: value }));
      },
      finish(id: SnowflakeID) {
        state.set({ status: UploadStatus.Ready, progress: 1, id });
        result.resolve(id);
      },
    };
  }

  async function enterThread(rootId = '100', read: { lastReadMessageId?: string } = { lastReadMessageId: '101' }) {
    fixture.componentRef.setInput('threadId', rootId);
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/messages/${rootId}`).flush({
      ...wireMessage,
      id: rootId,
      clientGeneratedId: `root-${rootId}`,
    });
    expect(TestBed.inject(ChatStore).loadSubscription).toHaveBeenCalledWith(testChat.id, encodeId(rootId));
    subscriptions.update((statuses) => new Map(statuses).set(encodeId(rootId), { subscribed: false, archived: false }));
    http.expectOne(`/_api/chats/${wireChat.id}/threads/${rootId}/read-state`).flush({ ...read });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http
      .expectOne(
        `/_api/chats/${wireChat.id}/messages?max=50&around=${read.lastReadMessageId ?? rootId}&threadId=${rootId}`,
      )
      .flush({
        messages: [
          { ...wireMessage, id: rootId, clientGeneratedId: `root-${rootId}` },
          { ...wireMessage, id: '101', clientGeneratedId: `reply-${rootId}-101`, replyRootId: rootId },
          { ...wireMessage, id: '102', clientGeneratedId: `reply-${rootId}-102`, replyRootId: rootId },
        ],
      });
    await fixture.whenStable();
  }

  async function reenter() {
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    const threadId = component.threadId();
    if (threadId) {
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(threadId)}`))
        req.flush({ ...wireMessage, id: decodeId(threadId) });
      http
        .expectOne(`/_api/chats/${wireChat.id}/threads/${decodeId(threadId)}/read-state`)
        .flush({ lastReadMessageId: '101' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    http
      .expectOne(
        `/_api/chats/${wireChat.id}/messages?max=50${threadId ? `&around=101&threadId=${decodeId(threadId)}` : ''}`,
      )
      .flush({
        messages: [{ ...wireMessage, ...(threadId ? { replyRootId: decodeId(threadId) } : {}) }],
        olderCursor: wireMessage.id,
      });
    await fixture.whenStable();
  }

  it.each(['loading', 'failed'])(
    'accepts input and renders a send before the initial page is available: %s',
    async (state) => {
      fixture.destroy();
      fixture = TestBed.createComponent(ConversationPage);
      component = fixture.componentInstance;
      fixture.componentRef.setInput('id', wireChat.id);
      fixture.detectChanges();
      const initial = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`);
      if (state === 'failed') {
        initial.flush('', { status: 503, statusText: 'Unavailable' });
        await fixture.whenStable();
        expect(component['conversation'].error()).toBe(ConversationError.Open);
      } else {
        expect(component['conversation'].loading()).toBe(true);
      }
      expect(component['conversation'].page()).toBeUndefined();
      typeText('页面未加载也能发送');
      expect(component['draft']()).toBe('页面未加载也能发送');
      const send: HTMLButtonElement = fixture.nativeElement.querySelector('.send-button');
      expect(send.disabled).toBe(false);
      send.click();
      fixture.detectChanges();
      const item = component['outbox'].items()[0];
      const operation = item.operation;
      const request = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body.message).toBe('页面未加载也能发送');
      expect(component['conversation'].page()).toBeUndefined();
      expect(component['draft']()).toBe('');
      expect(component['rows']()).toHaveLength(1);
      const local = fixture.debugElement.query(By.directive(Message));
      expect(local.nativeElement.textContent).toContain('页面未加载也能发送');
      expect((local.componentInstance as Message<MessageContent>).delivery()).toBe(MessageDelivery.Sending);
      expect(component['pendingNavigation']()?.type).toBe(ConversationTargetKind.Latest);
      const latest = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`);
      if (state === 'loading') expect(initial.cancelled).toBe(true);
      typeText('继续输入下一条');
      expect((fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).disabled).toBe(false);
      latest.flush('', { status: 503, statusText: 'Unavailable' });
      request.flush({
        ...wireMessage,
        id: '9007199254741005',
        clientGeneratedId: item.clientGeneratedId,
        message: '页面未加载也能发送',
      });
      await operation;
      await fixture.whenStable();
      expect(component['conversation'].page()).toBeUndefined();
      expect(component['conversation'].error()).toBe(ConversationError.Open);
      expect(component['rows']()).toHaveLength(1);
      expect(fixture.debugElement.query(By.directive(Message)).nativeElement).toBe(local.nativeElement);
      expect((local.componentInstance as Message<MessageContent>).message().message).toBe('页面未加载也能发送');
      expect((local.componentInstance as Message<MessageContent>).delivery()).toBe(MessageDelivery.Sent);
      expect(component['draft']()).toBe('继续输入下一条');
      expect(component['composer']()!.text()).toBe('继续输入下一条');
      typeText('加载失败后仍能继续输入');
      expect(component['draft']()).toBe('加载失败后仍能继续输入');
    },
  );

  it('encodes route IDs and prepends older messages in chronological order', async () => {
    fixture.detectChanges();
    expect(component.id()).toBe(testChat.id);
    expect(fixture.nativeElement.querySelector('app-message').getAttribute('data-message-id')).toBe(wireMessage.id);
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    const older = { ...testMessage, id: encodeId('9007199254741001'), message: '更早的消息' };
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`)
      .flush({ messages: [{ ...wireMessage, id: decodeId(older.id), message: older.message }], olderCursor: null });
    await loading;
    expect(component['conversation'].items().map((message) => message.id)).toEqual([older.id, testMessage.id]);
  });

  it('waits for finger release and inertia before inserting an older page', async () => {
    const content: HTMLElement = fixture.nativeElement.querySelector('ion-content');
    content.dispatchEvent(new Event('touchstart'));
    content.dispatchEvent(new Event('ionScrollStart'));
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`)
      .flush({ messages: [{ ...wireMessage, id: '100' }] });
    await Promise.resolve();
    content.dispatchEvent(new Event('touchend'));
    await Promise.resolve();
    expect(component['conversation'].items()).toEqual([testMessage]);
    content.dispatchEvent(new Event('ionScrollEnd'));
    await loading;
    expect(component['conversation'].items().map((item) => item.id)).toEqual([encodeId('100'), testMessage.id]);
  });

  it('prefetches older messages within one and a half viewports', async () => {
    component.ionViewDidEnter();
    await fixture.whenStable();
    Object.defineProperties(scroll, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 3000 },
    });
    scroll.scrollTop = 700;
    await component['onScroll']();
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`)
      .flush({ messages: [{ ...wireMessage, id: '100' }] });
    await fixture.whenStable();
    expect(component['conversation'].items()).toHaveLength(2);
  });

  function pinMessage(id: string, message = testMessage) {
    events.next({
      type: component.threadId() ? ServerWsMessageType.threadPinAdded : ServerWsMessageType.pinAdded,
      payload: {
        chatId: testChat.id,
        threadRootId: component.threadId(),
        messageId: message.id,
        pinId: encodeId(id),
        pin: { id: encodeId(id), chatId: testChat.id, message, pinnedBy: 1, pinnedAt: message.createdAt },
      },
    });
  }

  it('keeps the current messages while locating a pin and clears feedback after failure', async () => {
    const older = { ...testMessage, id: encodeId('100') };
    pinMessage('201', older);
    fixture.detectChanges();
    const list = fixture.nativeElement.querySelector('.message-list');
    const pending = component['locatePin']();
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.pinned-preview');
    expect(button.disabled).toBe(true);
    expect(button.querySelector('ion-spinner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.message-list')).toBe(list);
    expect(component['conversation'].items()).toEqual([testMessage]);
    await component['locatePin']();
    http
      .expectOne((req) => req.url.endsWith('/messages') && req.params.get('around') === '100')
      .flush('', { status: 503, statusText: 'Unavailable' });
    await pending;
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    expect(button.querySelector('ion-spinner')).toBeNull();
    expect(component['selectedPin']()?.message.id).toBe(older.id);
    expect(fixture.nativeElement.querySelector('.message-list')).toBe(list);
  });

  it('shows pins below the title, cycles navigation and removes the bar when unpinned', async () => {
    expect(TestBed.inject(PinsService).listPins).toHaveBeenCalledWith(testChat.id);
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBeNull();
    pinMessage('201');
    const newer = { ...testMessage, id: encodeId('9007199254741010'), message: '较新的置顶' };
    pinMessage('202', newer);
    await fixture.whenStable();
    const bar: HTMLElement = fixture.nativeElement.querySelector('.pinned-bar');
    expect(bar.previousElementSibling?.tagName).toBe('ION-TOOLBAR');
    expect(bar.textContent).toContain('较新的置顶');
    const jump = vi
      .spyOn(component as unknown as { goTo: (typeof component)['goTo'] }, 'goTo')
      .mockResolvedValue(undefined);
    await component['locatePin']();
    expect(jump).toHaveBeenCalledWith({ type: ConversationTargetKind.Message, messageId: newer.id });
    expect(component['selectedPin']()?.message.id).toBe(testMessage.id);
    await component['locatePin']();
    expect(component['selectedPin']()?.message.id).toBe(newer.id);
    for (const id of ['201', '202'])
      events.next({
        type: ServerWsMessageType.pinRemoved,
        payload: { chatId: testChat.id, pinId: encodeId(id), messageId: testMessage.id },
      });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.pinned-bar')).toBeNull();
  });

  it('uses this topic pin collection and resets the selected preview on entry', async () => {
    pinMessage('201');
    await enterThread();
    expect(TestBed.inject(PinsService).listThreadPins).toHaveBeenCalledWith(testChat.id, encodeId('100'));
    expect(component['selectedPin']()).toBeUndefined();
    pinMessage('202');
    await fixture.whenStable();
    const link = fixture.debugElement.query(By.directive(RouterLink)).injector.get(RouterLink).urlTree!;
    expect(TestBed.inject(Router).serializeUrl(link)).toBe(`/chats/chat/${wireChat.id}/thread/100/pins`);
  });

  it('keeps the fixed button mounted while scrolling across the latest-message threshold', async () => {
    await component['positionAndRead']();
    await fixture.whenStable();
    Object.defineProperties(scroll, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 500 },
    });
    scroll.scrollTop = 200;
    await component['onScroll']();
    await fixture.whenStable();
    const content: HTMLElement = fixture.nativeElement.querySelector('ion-content');
    const fab: HTMLElement = content.querySelector('ion-fab')!;
    expect(fab).not.toBeNull();
    for (const top of [470, 200, 470]) {
      scroll.scrollTop = top;
      await component['onScroll']();
      await fixture.whenStable();
      expect(content.querySelector('ion-fab')).toBe(fab);
      expect(getComputedStyle(fab).visibility).toBe(top === 470 ? 'hidden' : 'visible');
      expect(scroll.scrollTop).toBe(top);
    }
  });

  it('reads the badge from shared state, keeps its node mounted and hides it with the button', async () => {
    const data = TestBed.inject(ChatStore);
    const badge: HTMLElement = fixture.nativeElement.querySelector('.history-navigation ion-badge');
    data.acceptChats([{ ...testChat, unreadCount: 37 }], data.snapshot());
    Object.defineProperties(scroll, { scrollHeight: { value: 3000 }, clientHeight: { value: 500 } });
    scroll.scrollTop = 1000;
    await component['trackScroll']();
    await fixture.whenStable();
    expect(badge.textContent?.trim()).toBe('37');
    expect(badge.style.opacity).toBe('1');
    expect(component['showDownButton']()).toBe(true);
    component['composer']()!.voiceActive.set(true);
    expect(component['showDownButton']()).toBe(false);
    component['composer']()!.voiceActive.set(false);
    data.acceptChats([{ ...testChat, unreadCount: 0 }], data.snapshot());
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.history-navigation ion-badge')).toBe(badge);
    expect(badge.style.opacity).toBe('0');
  });

  it('uses topic counts without mixing in the parent chat or fetching the thread list', async () => {
    const data = TestBed.inject(ChatStore);
    data.acceptChats([{ ...testChat, unreadCount: 37 }], data.snapshot());
    data.acceptThreads(
      [
        {
          chatId: testChat.id,
          threadRootMessage: { ...testMessage, mentions: [] },
          chatName: '测试群',
          participants: [],
          replyCount: 5,
          subscribedAt: testMessage.createdAt,
          archived: false,
          unreadCount: 5,
          lastReadMessageId: testMessage.id,
          lastReplyAt: testMessage.createdAt,
        },
      ],
      data.snapshot(),
      data.subscriptionSnapshot(),
    );
    expect(data.unreadCount(testChat.id, testMessage.id)).toBe(5);
    expect(data.unreadCount(testChat.id, encodeId('999'))).toBe(0);
    expect(data.unreadCount(testChat.id)).toBe(37);
    http.expectNone(() => true);
  });

  it('returns through nested reply jumps before going to the latest loaded messages', async () => {
    Object.defineProperty(Element.prototype, 'animate', { value: vi.fn(), configurable: true });
    try {
      const opening = component['conversation'].open(encodeId('200'));
      http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=200`).flush({
        messages: [100, 200, 300].map((id) => ({ ...wireMessage, id: String(id) })),
      });
      await opening;
      await fixture.whenStable();
      fixture.debugElement.queryAll(By.directive(Message))[2].componentInstance.jump.emit(encodeId('200'));
      await fixture.whenStable();
      fixture.debugElement.queryAll(By.directive(Message))[1].componentInstance.jump.emit(encodeId('100'));
      await fixture.whenStable();
      expect(component['returnMessageIds']()).toEqual([encodeId('300'), encodeId('200')]);
      await component['navigateDown']();
      expect(component['returnMessageIds']()).toEqual([encodeId('300')]);
      await component['navigateDown']();
      expect(component['returnMessageIds']()).toEqual([]);
      await component['navigateDown']();
      expect(component['navigatingDown']()).toBe(false);
      http.expectNone(() => true);
      component.ionViewDidLeave();
      expect(component['returnMessageIds']()).toEqual([]);
    } finally {
      fixture.destroy();
      Reflect.deleteProperty(Element.prototype, 'animate');
    }
  });

  it('retains a failed return for retry and skips a deleted return target', async () => {
    component['returnMessageIds'].set([encodeId('300')]);
    const returning = component['navigateDown']();
    expect(component['navigatingDown']()).toBe(true);
    expect(component['pendingNavigation']()).toEqual({
      type: ConversationTargetKind.Message,
      messageId: encodeId('300'),
    });
    await component['navigateDown']();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=300`)
      .flush('', { status: 503, statusText: 'Unavailable' });
    await returning;
    expect(component['navigatingDown']()).toBe(false);
    expect(component['returnMessageIds']()).toEqual([encodeId('300')]);
    const retrying = component['navigateDown']();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=300`)
      .flush({ messages: [{ ...wireMessage, id: '299' }] });
    await retrying;
    expect(component['returnMessageIds']()).toEqual([]);
    expect(component['conversation'].error()).toBe(ConversationError.Missing);
    await component['navigateDown']();
    expect(component['conversation'].error()).toBeUndefined();
    http.expectNone(() => true);
  });

  it('forgets return points reached by manual scrolling and on leaving the conversation', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const element: HTMLElement = fixture.nativeElement.querySelector('app-message');
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20, 300, 100));
    const later = encodeId('9007199254741999');
    component['returnMessageIds'].set([later, testMessage.id]);
    component.ionViewDidEnter();
    await component['trackScroll']();
    expect(component['returnMessageIds']()).toEqual([later]);
    component.ionViewDidLeave();
    expect(component['returnMessageIds']()).toEqual([]);
  });

  it('refreshes an offscreen conversation count on incoming messages without jumping down', async () => {
    const data = TestBed.inject(ChatStore);
    component['atBottom'].set(false);
    incoming.next({ ...testMessage, id: encodeId('9007199254741999') });
    expect(data.getReadState).toHaveBeenCalledWith(testChat.id);
    expect(component['position']()).toBeUndefined();
  });

  it('preserves the message bottom when prepending removes its author header', async () => {
    await component['positionAndRead']();
    await fixture.whenStable();
    const message: HTMLElement = fixture.nativeElement.querySelector('app-message');
    scroll.scrollTop = 80;
    vi.spyOn(message, 'getBoundingClientRect').mockImplementation(() => {
      const prepended = fixture.nativeElement.querySelectorAll('app-message').length > 1;
      return new DOMRect(
        0,
        100 + (prepended ? 200 : 0) - scroll.scrollTop,
        300,
        message.querySelector('.sender') ? 64 : 44,
      );
    });
    const bottom = message.getBoundingClientRect().bottom;
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    http
      .expectOne((req) => req.url.endsWith('/messages') && req.params.has('before'))
      .flush({ messages: [{ ...wireMessage, id: '100', clientGeneratedId: 'older-100' }], olderCursor: '100' });
    await loading;
    await fixture.whenStable();
    expect(message.querySelector('.sender')).toBeNull();
    expect(message.getBoundingClientRect().height).toBe(44);
    expect(message.getBoundingClientRect().bottom).toBe(bottom);
    expect(scroll.scrollTop).toBe(260);
  });

  it('keeps the pagination button, spinner and content slots mounted while loading older messages', async () => {
    await component['positionAndRead']();
    await fixture.whenStable();
    const content: HTMLElement = fixture.nativeElement.querySelector('ion-content');
    const children = [...content.children];
    const button = content.querySelector('button.pagination-control')!;
    const spinner = button.querySelector('ion-spinner')!;
    expect(button.textContent?.trim()).toBe('');
    expect(spinner.paused).toBe(true);
    scroll.scrollTop = 50;
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`);
    await fixture.whenStable();
    expect(component['conversation'].pagingDirection()).toBe(PageDirection.Older);
    expect(button.querySelector('ion-spinner')).toBe(spinner);
    expect(spinner.paused).toBe(false);
    expect([...content.children]).toEqual(children);
    expect(scroll.scrollTop).toBe(50);
    request.flush({ messages: [{ ...wireMessage, id: '9007199254741001' }], olderCursor: '9007199254741001' });
    await loading;
    await fixture.whenStable();
    expect([...content.children]).toEqual(children);
    expect(button.querySelector('ion-spinner')).toBe(spinner);
    expect(spinner.paused).toBe(true);
    expect(component['conversation'].items()).toHaveLength(2);
  });

  it('confirms unpin in the normal message menu before removing it', async () => {
    const details = TestBed.inject(ChatStore).ensureDetails(testChat.id);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...structuredClone(wireChat), myRole: GroupRole.admin });
    const pinId = encodeId('200');
    events.next({
      type: ServerWsMessageType.pinAdded,
      payload: {
        chatId: testChat.id,
        messageId: testMessage.id,
        pinId,
        pin: { id: pinId, chatId: testChat.id, pinnedAt: testMessage.createdAt, pinnedBy: 1, message: testMessage },
      },
    });
    await details;
    const select = () =>
      component['menu']()!['selection'].set({
        messageId: testMessage.id,
        element: document.createElement('div'),
        rect: new DOMRect(),
        own: false,
        first: true,
        last: true,
      });
    select();
    await component['menu']()!['choose'](MessageAction.Pin);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message-menu ion-alert').header).toBe('取消置顶');
    expect(fixture.nativeElement.querySelector('app-message-menu ion-alert').isOpen).toBe(true);
    http.expectNone((request) => request.method === 'DELETE');
    await component['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'cancel' } }));
    expect(component['pins']().items()).toHaveLength(1);
    select();
    await component['menu']()!['choose'](MessageAction.Pin);
    const removing = component['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'confirm' } }));
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/pins/200`).flush(null);
    await removing;
    expect(component['menu']()!['notice']()).toBe(MessageNotice.Unpinned);
  });

  it('blocks pin actions when membership no longer permits them', async () => {
    const details = TestBed.inject(ChatStore).ensureDetails(testChat.id);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...structuredClone(wireChat), myRole: GroupRole.member });
    await details;
    component['menu']()!['selection'].set({
      messageId: testMessage.id,
      element: document.createElement('div'),
      rect: new DOMRect(),
      own: false,
      first: true,
      last: true,
    });
    await component['menu']()!['choose'](MessageAction.Pin);
    expect(component['menu']()!['confirmation']()).toBeUndefined();
    component['menu']()!['confirmation'].set({ action: MessageAction.Pin, message: testMessage, pinned: true });
    await component['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'confirm' } }));
    http.expectNone((request) => request.url.includes('/pins'));
    component['menu']()!['selection'].set(undefined);
  });

  it('saves the previous draft on navigation and ignores the old conversation pagination response', async () => {
    component['draft'].set('旧会话草稿');
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    const oldPage = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`);
    fixture.componentRef.setInput('id', '9007199254740995');
    fixture.detectChanges();
    http.expectOne('/_api/group/9007199254740995').flush({ ...wireChat, id: '9007199254740995' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('/_api/chats/9007199254740995/messages?max=50').flush({ messages: [], olderCursor: null });
    await Promise.resolve();
    fixture.detectChanges();
    expect(oldPage.cancelled).toBe(true);
    await loading;
    expect(component['conversation'].items()).toEqual([]);
    expect(component['draft']()).toBe('');
    expect(TestBed.inject(DraftStore).get(testChat.id)?.text).toBe('旧会话草稿');
    expect(TestBed.inject(DraftStore).get(encodeId('9007199254740995'))).toBeUndefined();
  });

  it('keeps typing and reply selection local, persisting once when navigation starts', () => {
    const drafts = TestBed.inject(DraftStore);
    const write = vi.spyOn(window.localStorage, 'setItem');
    for (const text of ['未', '未发', '未发送']) component['updateDraft'](text);
    component['startReply'](testMessage);
    expect(drafts.get(testChat.id)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    component.ionViewWillLeave();
    expect(drafts.get(testChat.id)).toMatchObject({ text: '未发送', replyTo: wireMessage.id });
    expect(write).toHaveBeenCalledOnce();
    component.ionViewDidLeave();
    expect(write).toHaveBeenCalledOnce();
  });

  it('saves on backgrounding or pagehide, without saving on a visible event or after leaving', () => {
    const drafts = TestBed.inject(DraftStore);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    component['updateDraft']('后台保留');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(drafts.get(testChat.id)).toBeUndefined();
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(drafts.get(testChat.id)?.text).toBe('后台保留');
    component['updateDraft']('刷新保留');
    window.dispatchEvent(new Event('pagehide'));
    const saved = drafts.get(testChat.id);
    expect(saved?.text).toBe('刷新保留');
    component.ionViewDidLeave();
    window.dispatchEvent(new Event('pagehide'));
    expect(drafts.get(testChat.id)).toBe(saved);
  });

  it('retains unsent text when cancelling an edit and saves that text when leaving during another edit', () => {
    const drafts = TestBed.inject(DraftStore);
    component['updateDraft']('还没有发送');
    component['startReply'](testMessage);
    component['startEdit'](testMessage);
    component['updateDraft']('编辑已发送的消息');
    expect(drafts.get(testChat.id)).toBeUndefined();
    expect(component['draft']()).toBe('还没有发送');
    component['cancelEdit']();
    expect(component['draft']()).toBe('还没有发送');
    component['startEdit'](testMessage);
    component['updateDraft']('另一次编辑');
    component.ionViewWillLeave();
    expect(drafts.get(testChat.id)).toMatchObject({ text: '还没有发送', replyTo: wireMessage.id });
  });

  it.each(['background', 'transition', 'left'])(
    'persists only the next draft while an earlier send finishes: %s',
    async (mode) => {
      const drafts = TestBed.inject(DraftStore);
      component['updateDraft']('正在发送');
      const sending = component['sendMessage']();
      const request = http.expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'));
      expect(component['draft']()).toBe('');
      expect(drafts.get(testChat.id)).toBeUndefined();
      component['updateDraft']('下一条草稿');
      component['startReply'](testMessage);
      if (mode === 'background') {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        component.ionViewWillLeave();
        vi.mocked(TestBed.inject(Router).isActive).mockReturnValue(false);
        if (mode === 'left') component.ionViewDidLeave();
      }
      const saved = drafts.get(testChat.id);
      expect(saved).toMatchObject({ text: '下一条草稿', replyTo: wireMessage.id });
      request.flush({
        ...wireMessage,
        id: '9007199254741005',
        clientGeneratedId: request.request.body.clientGeneratedId,
        message: '正在发送',
      });
      await sending;
      expect(drafts.get(testChat.id)).toBe(saved);
      if (mode !== 'left') {
        expect(component['draft']()).toBe('下一条草稿');
        expect(component['replyTo']()).toBe(testMessage);
      }
      component.ionViewDidLeave();
      expect(drafts.get(testChat.id)).toBe(saved);
    },
  );

  it('restores a draft after leaving and clears persisted text as soon as it is enqueued', async () => {
    component['updateDraft']('保留草稿');
    component.ionViewDidLeave();
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    await fixture.whenStable();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({ messages: [structuredClone(wireMessage)] });
    await fixture.whenStable();
    expect(component['draft']()).toBe('保留草稿');
    const sending = component['sendMessage']();
    expect(component['draft']()).toBe('');
    expect(TestBed.inject(DraftStore).get(testChat.id)).toBeUndefined();
    const request = http.expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'));
    request.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: request.request.body.clientGeneratedId,
      message: '保留草稿',
    });
    await sending;
    expect(TestBed.inject(DraftStore).get(testChat.id)).toBeUndefined();
  });

  it('preserves the reply ID while typing during draft restoration and does not restore a cancelled reply', async () => {
    const drafts = TestBed.inject(DraftStore);
    component.ionViewDidLeave();
    drafts.save(testChat.id, undefined, '回复草稿', testMessage.id);
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    await fixture.whenStable();
    const replyRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({ messages: [structuredClone(wireMessage)] });
    component['updateDraft']('继续编辑');
    expect(drafts.get(testChat.id)?.replyTo).toBe(wireMessage.id);
    component['cancelReply']();
    replyRequest.flush(structuredClone(wireMessage));
    await fixture.whenStable();
    expect(component['replyTo']()).toBeUndefined();
    expect(drafts.get(testChat.id)).toMatchObject({ text: '回复草稿', replyTo: wireMessage.id });
    component.ionViewWillLeave();
    expect(drafts.get(testChat.id)).toMatchObject({ text: '继续编辑', replyTo: undefined });
  });

  it('keeps a failed row in the root outbox across leaving and reentry without restoring submitted input', async () => {
    component['updateDraft']('待重试');
    const sending = component['sendMessage']();
    const item = component['outbox'].items()[0];
    expect(component['draft']()).toBe('');
    expect(component['rows']().at(-1)?.outgoing).toBe(item);
    http.expectOne(`/_api/chats/${wireChat.id}/messages`).flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    fixture.detectChanges();
    const row: HTMLElement = fixture.nativeElement.querySelector('app-message:last-child');
    expect(row.textContent).toContain('待重试');
    expect(row.querySelector('.retry-button')).not.toBeNull();
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(component['draft']()).toBe('');
    component.ionViewDidLeave();
    expect(TestBed.inject(DraftStore).get(testChat.id)).toBeUndefined();
    expect(TestBed.inject(MessageOutbox).items()).toEqual([item]);
    await reenter();
    expect(component['draft']()).toBe('');
    expect(component['rows']().at(-1)?.outgoing).toBe(item);
    expect(fixture.nativeElement.querySelector('app-message:last-child .retry-button')).not.toBeNull();
  });

  it.each(['http', 'websocket'])(
    'retries the failed row with the same UUID and renders one confirmation when %s arrives first',
    async (firstAcknowledgement) => {
      component['draft'].set('  新消息  ');
      const sending = component['sendMessage']();
      const item = component['outbox'].items()[0];
      const first = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      expect(first.request.method).toBe('POST');
      expect(first.request.body.message).toBe('新消息');
      const body = structuredClone(first.request.body);
      expect(body.clientGeneratedId).toBe(item.clientGeneratedId);
      expect(component['draft']()).toBe('');
      fixture.detectChanges();
      const local = fixture.debugElement.queryAll(By.directive(Message)).at(-1)!;
      const message = local.componentInstance as Message<MessageContent>;
      expect(message.message().id).toBeUndefined();
      expect(message.delivery()).toBe(MessageDelivery.Sending);
      expect(local.nativeElement.textContent).toContain('新消息');
      first.flush('', { status: 503, statusText: 'Unavailable' });
      await sending;
      fixture.detectChanges();
      expect(component['draft']()).toBe('');
      expect(message.delivery()).toBe(MessageDelivery.Failed);
      expect(local.nativeElement.querySelector('.retry-button')).not.toBeNull();

      component['updateDraft']('确认期间继续写');
      component['startReply'](testMessage);
      const retrying = component['outbox'].retry(item);
      expect(component['outbox'].retry(item)).toBe(retrying);
      const retry = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      expect(retry.request.body).toEqual(body);
      const response = {
        ...wireMessage,
        id: '9007199254741005',
        clientGeneratedId: retry.request.body.clientGeneratedId,
        message: '新消息',
      };
      const echoed = { ...response, id: encodeId(response.id), chatId: testChat.id };
      if (firstAcknowledgement === 'websocket') {
        incoming.next(echoed);
        fixture.detectChanges();
        expect(fixture.debugElement.queryAll(By.directive(Message))).toHaveLength(2);
      }
      if (firstAcknowledgement === 'websocket') expect(retry.cancelled).toBe(true);
      else retry.flush(structuredClone(response));
      await retrying;
      if (firstAcknowledgement === 'http') incoming.next(echoed);
      await fixture.whenStable();
      expect(component['conversation'].items()).toHaveLength(2);
      expect(component['rows']().filter((row) => row.key === item.clientGeneratedId)).toHaveLength(1);
      expect(component['outbox'].items()).toEqual([]);
      const confirmed = fixture.debugElement.queryAll(By.directive(Message));
      expect(confirmed).toHaveLength(2);
      expect(confirmed.at(-1)!.nativeElement).toBe(local.nativeElement);
      expect(message.message().id).toBe(encodeId(response.id));
      expect(message.interactive()).toBe(true);
      expect(local.nativeElement.querySelector('.retry-button')).toBeNull();
      expect(component['draft']()).toBe('确认期间继续写');
      expect(component['replyTo']()).toBe(testMessage);
      expect(component['composer']()!.text()).toBe('确认期间继续写');
    },
  );

  it('appends local rows in submission order after confirmed messages regardless of createdAt', async () => {
    const timestamp = vi.spyOn(Date.prototype, 'toISOString');
    timestamp.mockReturnValueOnce('2000-01-02T00:00:00Z');
    component['updateDraft']('第一条本地消息');
    const firstSending = component['sendMessage']();
    const firstRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    timestamp.mockReturnValueOnce('2000-01-01T00:00:00Z');
    component['updateDraft']('第二条本地消息');
    void component['sendMessage']();
    const [first, second] = component['outbox'].items();
    expect(first.clientGeneratedId).not.toBe(second.clientGeneratedId);
    expect(first.message().createdAt).toBe('2000-01-02T00:00:00Z');
    expect(second.message().createdAt).toBe('2000-01-01T00:00:00Z');
    http.expectNone((req) => req.method === 'POST');
    incoming.next({
      ...testMessage,
      id: encodeId('9007199254741005'),
      clientGeneratedId: 'live-between-submissions-and-confirmation',
      message: '已确认的新消息',
    });
    fixture.detectChanges();
    const rendered = fixture.debugElement.queryAll(By.directive(Message));
    expect(rendered.map((row) => (row.componentInstance as Message<MessageContent>).message().message)).toEqual([
      '测试消息',
      '已确认的新消息',
      '第一条本地消息',
      '第二条本地消息',
    ]);
    expect(
      component['rows']()
        .slice(-2)
        .map((row) => row.outgoing),
    ).toEqual([first, second]);
    expect(component['draft']()).toBe('');
    firstRequest.flush({
      ...wireMessage,
      id: '9007199254741007',
      clientGeneratedId: firstRequest.request.body.clientGeneratedId,
      message: '第一条本地消息',
    });
    await firstSending;
    const secondRequest = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    secondRequest.flush('', { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(second.delivery()).toBe(MessageDelivery.Failed));
    await fixture.whenStable();
    const rows = fixture.debugElement.queryAll(By.directive(Message));
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)!.nativeElement).toBe(rendered.at(-1)!.nativeElement);
    expect(component['rows']().at(-1)?.outgoing).toBe(second);
    expect(second.delivery()).toBe(MessageDelivery.Failed);
  });

  it('sends later text while an attachment uploads and displays confirmations in server order', async () => {
    const media = pendingUpload();
    component['updateDraft']('附件消息');
    void component['sendMessage']({ messageType: MessageType.text, attachmentIds: [], uploads: [media.upload] });
    const attachmentItem = component['outbox'].items()[0];
    typeText('先发的文字');
    (fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).click();
    const firstText = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(firstText.request.body.message).toBe('先发的文字');
    expect(firstText.request.body.attachmentIds).toEqual([]);
    typeText('后发的文字');
    (fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).click();
    const [, firstTextItem, secondTextItem] = component['outbox'].items();
    fixture.detectChanges();
    expect(component['rows']()).toHaveLength(4);
    expect(attachmentItem.delivery()).toBe(MessageDelivery.Sending);
    expect(media.upload.state().status).toBe(UploadStatus.Uploading);
    http.expectNone((request) => request.method === 'POST');
    typeText('继续保留的草稿');
    firstText.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: firstTextItem.clientGeneratedId,
      message: '先发的文字',
    });
    const secondText = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(secondText.request.body.message).toBe('后发的文字');
    expect(secondText.request.body.clientGeneratedId).toBe(secondTextItem.clientGeneratedId);
    secondText.flush({
      ...wireMessage,
      id: '9007199254741007',
      clientGeneratedId: secondTextItem.clientGeneratedId,
      message: '后发的文字',
    });
    await vi.waitFor(() => expect(secondTextItem.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(media.upload.state().status).toBe(UploadStatus.Uploading);
    expect(component['outbox'].items()).toEqual([attachmentItem]);
    expect(component['rows']().map((row) => row.message.message)).toEqual([
      '测试消息',
      '先发的文字',
      '后发的文字',
      '附件消息',
    ]);
    media.finish(encodeId('100'));
    const attachment = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(attachment.request.body.message).toBe('附件消息');
    expect(attachment.request.body.attachmentIds).toEqual(['100']);
    attachment.flush({
      ...wireMessage,
      id: '9007199254741009',
      clientGeneratedId: attachmentItem.clientGeneratedId,
      message: '附件消息',
      hasAttachments: true,
      attachments: [{ id: '100', url: media.upload.url, fileName: 'edit.png', kind: 'image/png', size: 5 }],
    });
    await vi.waitFor(() => expect(attachmentItem.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(component['rows']().map((row) => row.message.id)).toEqual([
      testMessage.id,
      encodeId('9007199254741005'),
      encodeId('9007199254741007'),
      encodeId('9007199254741009'),
    ]);
    expect(fixture.debugElement.queryAll(By.directive(Message))).toHaveLength(4);
    expect(component['rows']().filter((row) => row.key === attachmentItem.clientGeneratedId)).toHaveLength(1);
    expect(component['outbox'].items()).toEqual([]);
    expect(component['draft']()).toBe('继续保留的草稿');
    expect(component['composer']()!.text()).toBe('继续保留的草稿');
  });

  it('retains live messages while older pages load and deduplicates echoed messages', async () => {
    const loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    const olderRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`);
    const live = { ...testMessage, id: encodeId('9007199254741007'), message: '实时消息' };
    component['atBottom'].set(false);
    component['position'].set(undefined);
    incoming.next(live);
    incoming.next(live);
    olderRequest.flush({ messages: [{ ...wireMessage, id: '9007199254741001' }], olderCursor: null });
    await loading;
    expect(component['conversation'].items().map((message) => message.id)).toEqual([
      encodeId('9007199254741001'),
      testMessage.id,
      live.id,
    ]);
    expect(component['position']()).toBeUndefined();
    Object.defineProperty(scroll, 'scrollHeight', { value: 800, configurable: true });
    scroll.scrollTop = 120;
    component['atBottom'].set(true);
    incoming.next({ ...live, id: encodeId('9007199254741009') });
    await component['positionAndRead']();
    expect(scroll.scrollTop).toBe(800);
  });

  it('renders grouping flags from the loaded and live message range', async () => {
    incoming.next({ ...testMessage, id: encodeId('9007199254741005') });
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('.sender')).toHaveLength(1);
    expect(element.querySelectorAll('ion-avatar')).toHaveLength(1);
    expect(element.querySelectorAll('.message-date')).toHaveLength(1);
    expect(element.querySelector(`[data-message-id="${wireMessage.id}"] .chat-row.last`)).toBeNull();
    expect(element.querySelector('[data-message-id="9007199254741005"] .sender')).toBeNull();
    expect(element.querySelector('[data-message-id="9007199254741005"] .chat-row.last')).not.toBeNull();
  });

  it('moves the selected reply into the failed row and retries it without changing the next reply draft', async () => {
    vi.spyOn(IonTextarea.prototype, 'setFocus').mockResolvedValue();
    component['startReply'](testMessage);
    component['draft'].set('回复内容');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.reply-context').textContent).toContain('测试用户');
    const sending = component['sendMessage']();
    const item = component['outbox'].items()[0];
    const first = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(first.request.body.replyToId).toBe(wireMessage.id);
    expect(component['draft']()).toBe('');
    expect(component['replyTo']()).toBeUndefined();
    expect(component['savedReplyId']()).toBeUndefined();
    expect(item.message().replyToMessage).toMatchObject(testMessage);
    first.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.reply-context')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-message:last-child .reply-preview').textContent).toContain(
      '测试消息',
    );
    const nextReply = { ...testMessage, id: encodeId('9007199254741009'), clientGeneratedId: 'next-reply' };
    component['updateDraft']('下一条回复');
    component['startReply'](nextReply);
    const retrying = component['outbox'].retry(item);
    const retry = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(retry.request.body).toEqual(first.request.body);
    retry.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: retry.request.body.clientGeneratedId,
      message: '回复内容',
      replyToMessage: structuredClone(wireMessage),
    });
    await retrying;
    await fixture.whenStable();
    expect(component['draft']()).toBe('下一条回复');
    expect(component['replyTo']()).toBe(nextReply);
    const nextSending = component['sendMessage']();
    const next = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(next.request.body.clientGeneratedId).not.toBe(item.clientGeneratedId);
    expect(next.request.body.replyToId).toBe(decodeId(nextReply.id));
    next.flush('', { status: 503, statusText: 'Unavailable' });
    await nextSending;
    expect(component['replyTo']()).toBeUndefined();
    expect(component['outbox'].items().at(-1)?.message().replyToMessage).toMatchObject(nextReply);
  });

  it('resumes around the frozen read boundary and a second chat click requests the latest directly', async () => {
    const data = TestBed.inject(ChatStore);
    const read = vi.mocked(data.cachedReadState);
    component.ionViewDidLeave();
    read.mockReturnValue({ lastReadMessageId: encodeId('100'), unreadCount: 90 });
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100`).flush({
      messages: [
        { ...wireMessage, id: '100' },
        { ...wireMessage, id: '101' },
      ],
      olderCursor: '100',
      newerCursor: '101',
    });
    await fixture.whenStable();
    expect(component['firstUnreadId']()).toBe(encodeId('101'));
    read.mockReturnValue({ lastReadMessageId: encodeId('101'), unreadCount: 89 });
    await fixture.whenStable();
    expect(component['entryReadId']()).toBe(encodeId('100'));
    expect(fixture.nativeElement.querySelector('.unread-separator')).not.toBeNull();
    TestBed.inject(ConversationNavigation).goTo(testChat.id, { type: ConversationTargetKind.Latest });
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50`)
      .flush({ messages: [{ ...wireMessage }], olderCursor: wireMessage.id });
    await fixture.whenStable();
    expect(component['conversation'].items()).toEqual([testMessage]);
  });

  it.each([
    { height: 1600, expectedTop: 1000 },
    { height: 1200, expectedTop: 700 },
  ])('positions the unread divider within the scroll range ($height px)', async ({ height, expectedTop }) => {
    component.ionViewDidLeave();
    vi.mocked(TestBed.inject(ChatStore).cachedReadState).mockReturnValue({
      lastReadMessageId: encodeId('100'),
      unreadCount: 1,
    });
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100`).flush({
      messages: [
        { ...wireMessage, id: '100' },
        { ...wireMessage, id: '101' },
      ],
    });
    Object.defineProperties(scroll, {
      clientHeight: { value: 500 },
      scrollHeight: { value: height },
    });
    scroll.scrollTop = 0;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 300, 500));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('unread-separator') ? new DOMRect(0, 1050, 300, 20) : new DOMRect();
    });
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(expectedTop);
    expect(fixture.nativeElement.querySelector('.unread-separator').textContent).toContain('未读消息');
    vi.mocked(TestBed.inject(ChatStore).cachedReadState).mockReturnValue({
      lastReadMessageId: encodeId('101'),
      unreadCount: 0,
    });
    await fixture.whenStable();
    expect(component['firstUnreadId']()).toBe(encodeId('101'));
    expect(scroll.scrollTop).toBe(expectedTop);
  });

  it('marks only a visible message bottom and stops tracking hidden or departed pages', async () => {
    const markRead = TestBed.inject(ChatStore).markRead;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const opening = component['conversation'].open(encodeId('101'));
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101`).flush({
      messages: [100, 101, 102].map((id) => ({ ...wireMessage, id: String(id) })),
    });
    await opening;
    await fixture.whenStable();
    const elements = [...fixture.nativeElement.querySelectorAll('app-message')] as HTMLElement[];
    const rects = [new DOMRect(0, 0, 300, 60), new DOMRect(0, 60, 300, 80), new DOMRect(0, 140, 300, 400)];
    elements.forEach((element, index) => vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rects[index]));
    component.ionViewDidEnter();
    await component['trackScroll']();
    expect(markRead).toHaveBeenLastCalledWith(testChat.id, encodeId('101'));
    vi.mocked(markRead).mockClear();
    hidden.mockReturnValue(true);
    await component['trackScroll']();
    expect(markRead).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    component.ionViewDidLeave();
    await component['trackScroll']();
    expect(markRead).not.toHaveBeenCalled();
    expect(component['conversation'].items()).toEqual([]);
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(0);
    expect(component['rows']()).toEqual([]);
  });

  it('refreshes metadata and reports the visible read position through the unified resync event', async () => {
    const data = TestBed.inject(ChatStore);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    fixture.detectChanges();
    const message: HTMLElement = fixture.nativeElement.querySelector('app-message');
    vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 100));
    component.ionViewDidEnter();
    await fixture.whenStable();
    document.dispatchEvent(new Event('visibilitychange'));
    await fixture.whenStable();
    expect(data.getReadState).not.toHaveBeenCalled();
    vi.mocked(data.markRead).mockClear();

    resync.next();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&after=${wireMessage.id}`).flush({ messages: [] });
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, name: '重连后的群名称' });
    await fixture.whenStable();
    expect(data.getReadState).toHaveBeenCalledOnce();
    expect(data.getReadState).toHaveBeenCalledWith(testChat.id);
    expect(data.markRead).toHaveBeenLastCalledWith(testChat.id, testMessage.id);
    expect(fixture.nativeElement.querySelector('ion-title').textContent.trim()).toBe('重连后的群名称');
  });

  it('refreshes deep-linked topic subscription state on resync without reloading the topic list', async () => {
    await enterThread();
    const loadSubscription = TestBed.inject(ChatStore).loadSubscription;
    vi.mocked(loadSubscription).mockClear();
    resync.next();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&after=102&threadId=100`).flush({ messages: [] });
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat });
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: false }));
    await fixture.whenStable();
    expect(component['subscription']()).toEqual({ subscribed: true, archived: false });
    expect(loadSubscription).toHaveBeenCalledWith(testChat.id, encodeId('100'));
    expect(TestBed.inject(ChatStore).getReadState).not.toHaveBeenCalled();
  });

  it('retries a failed page without reloading the resume position', async () => {
    let loading = component['loadPage'](PageDirection.Older);
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`)
      .flush('', { status: 503, statusText: 'Unavailable' });
    await loading;
    expect(component['conversation'].error()).toBe(ConversationError.Page);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('加载消息失败');
    // A scroll at the opposite end has nothing to load and must not replace the failed action.
    await component['loadPage'](PageDirection.Newer);
    component['retry']();
    await Promise.resolve();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`)
      .flush({ messages: [{ ...wireMessage, id: '9007199254741001' }], olderCursor: null });
    await fixture.whenStable();
    expect(component['conversation'].items()).toHaveLength(2);
    expect(component['conversation'].error()).toBeUndefined();
  });

  it('keeps main chat messages separate from topics and routes a root message into its topic', async () => {
    incoming.next({ ...testMessage, id: encodeId('9007199254741005'), replyRootId: testMessage.id });
    expect(component['conversation'].items()).toEqual([testMessage]);
    events.next({
      type: ServerWsMessageType.threadUpdate,
      payload: {
        chatId: testChat.id,
        threadRootId: testMessage.id,
        replyCount: 2,
        lastReplyAt: testMessage.createdAt,
      },
    });
    await fixture.whenStable();
    expect(component['conversation'].items()[0].threadInfo).toEqual({ replyCount: 2 });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
    const button: HTMLElement = fixture.nativeElement.querySelector('app-message .thread-entry');
    expect(button).not.toBeNull();
    button.click();
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id, 'thread', wireMessage.id]);
  });

  it('resumes a deep-linked topic at its own read boundary and resets drafts between topics', async () => {
    component['draft'].set('主会话草稿');
    await enterThread();
    expect(component.threadId()).toBe(encodeId('100'));
    expect(TestBed.inject(DraftStore).get(testChat.id)?.text).toBe('主会话草稿');
    expect(TestBed.inject(DraftStore).get(testChat.id, encodeId('100'))).toBeUndefined();
    expect(component['draft']()).toBe('');
    expect(component['firstUnreadId']()).toBe(encodeId('102'));
    expect(fixture.nativeElement.querySelector('ion-title').textContent.trim()).toBe('测试消息');
    expect(component['backHref']()).toBe(`/chats/chat/${wireChat.id}`);
    component['draft'].set('话题草稿');
    await enterThread('99', {});
    expect(component['draft']()).toBe('');
    expect(component['entryReadId']()).toBe(encodeId('99'));
    expect(component['firstUnreadId']()).toBe(encodeId('101'));
    expect(TestBed.inject(ChatStore).getReadState).not.toHaveBeenCalled();
  });

  it('receives and marks only the active topic without advancing the main chat read position', async () => {
    await enterThread();
    incoming.next({ ...testMessage, id: encodeId('103') });
    incoming.next({ ...testMessage, id: encodeId('104'), replyRootId: encodeId('99') });
    incoming.next({ ...testMessage, id: encodeId('105'), replyRootId: encodeId('100') });
    expect(component['conversation'].items().map((item) => item.id)).toEqual([
      encodeId('100'),
      encodeId('101'),
      encodeId('102'),
      encodeId('105'),
    ]);
    await fixture.whenStable();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    const elements = [...fixture.nativeElement.querySelectorAll('app-message')] as HTMLElement[];
    elements.forEach((element, index) =>
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 50, 300, 50)),
    );
    component.ionViewDidEnter();
    await component['trackScroll']();
    expect(TestBed.inject(ChatStore).markThreadRead).toHaveBeenLastCalledWith(
      testChat.id,
      encodeId('100'),
      encodeId('105'),
    );
    expect(TestBed.inject(ChatStore).markRead).not.toHaveBeenCalled();
    const open = vi.spyOn(component['conversation'], 'open');
    TestBed.inject(ConversationNavigation).goTo(testChat.id, { type: ConversationTargetKind.Latest });
    expect(open).not.toHaveBeenCalled();
    TestBed.inject(ConversationNavigation).goTo(testChat.id, { type: ConversationTargetKind.Latest }, encodeId('100'));
    expect(open).toHaveBeenCalledWith(undefined, false);
  });

  it('fetches the topic read boundary once its cached list snapshot is stale', async () => {
    const readState = vi.mocked(TestBed.inject(ChatStore).threadReadState);
    readState.mockReturnValue({ lastReadMessageId: encodeId('100') });
    fixture.componentRef.setInput('threadId', '100');
    fixture.detectChanges();
    for (const req of http.match(`/_api/chats/${wireChat.id}/messages/100`)) req.flush({ ...wireMessage, id: '100' });
    http.expectNone(`/_api/chats/${wireChat.id}/threads/100/read-state`);
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=100&threadId=100`).flush({
      messages: [
        { ...wireMessage, id: '100' },
        { ...wireMessage, id: '101', replyRootId: '100' },
      ],
    });
    await fixture.whenStable();
    expect(component['entryReadId']()).toBe(encodeId('100'));
    component.ionViewDidLeave();
    readState.mockReturnValue(undefined);
    component.ionViewWillEnter();
    if (component.threadId())
      for (const req of http.match(`/_api/chats/${wireChat.id}/messages/${decodeId(component.threadId()!)}`))
        req.flush({ ...wireMessage, id: decodeId(component.threadId()!) });
    http
      .expectOne(`/_api/chats/${wireChat.id}/threads/100/read-state`)
      .flush({ lastReadMessageId: '101', unreadCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=101&threadId=100`).flush({
      messages: [
        { ...wireMessage, id: '101', replyRootId: '100' },
        { ...wireMessage, id: '102', replyRootId: '100' },
      ],
    });
    await fixture.whenStable();
    expect(readState).toHaveBeenLastCalledWith(testChat.id, encodeId('100'));
    expect(component['entryReadId']()).toBe(encodeId('101'));
    expect(component['firstUnreadId']()).toBe(encodeId('102'));
  });

  it('publishes accepted topic replies through the shared message stream', async () => {
    await enterThread();
    const accept = vi.spyOn(TestBed.inject(Connection), 'accept');
    component['draft'].set('话题消息');
    const sending = component['sendMessage']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/threads/100/messages`);
    expect(request.request.body.message).toBe('话题消息');
    expect(component['draft']()).toBe('');
    expect(component['rows']().at(-1)?.outgoing?.threadId).toBe(encodeId('100'));
    request.flush({
      ...wireMessage,
      id: '103',
      replyRootId: '100',
      clientGeneratedId: request.request.body.clientGeneratedId,
      message: request.request.body.message,
    });
    await sending;
    await fixture.whenStable();
    expect(component['conversation'].items().at(-1)?.id).toBe(encodeId('103'));
    expect(component['draft']()).toBe('');
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ id: encodeId('103'), replyRootId: encodeId('100') }));
  });

  it('uses the inbox subscription as the only state for following, archiving and restoring a topic', async () => {
    await enterThread();
    const inbox = TestBed.inject(ChatStore);
    await component['updateThread']();
    expect(inbox.subscribeThread).toHaveBeenCalledWith(testChat.id, encodeId('100'));
    expect(component['subscription']()).toEqual({ subscribed: false, archived: false });
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: false }));
    expect(component['subscription']()).toEqual({ subscribed: true, archived: false });
    await component['updateThread']();
    expect(inbox.setThreadArchived).toHaveBeenLastCalledWith(testChat.id, encodeId('100'), true);
    expect(component['subscription']()).toEqual({ subscribed: true, archived: false });
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: true }));
    expect(component['subscription']()).toEqual({ subscribed: true, archived: true });
    await component['updateThread']();
    expect(inbox.setThreadArchived).toHaveBeenLastCalledWith(testChat.id, encodeId('100'), false);
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: false }));
    expect(component['subscription']()).toEqual({ subscribed: true, archived: false });
  });

  it('keeps a new topic draft when an earlier topic send finishes after navigation', async () => {
    await enterThread();
    component['draft'].set('第一话题消息');
    const sending = component['sendMessage']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/threads/100/messages`);
    const item = component['outbox'].items()[0];
    expect(component['draft']()).toBe('');
    await enterThread('99');
    expect(request.cancelled).toBe(false);
    expect(component['outbox'].items()).toContain(item);
    expect(component['rows']().some((row) => row.outgoing === item)).toBe(false);
    component['draft'].set('另一个话题草稿');
    request.flush({
      ...wireMessage,
      id: '103',
      replyRootId: '100',
      clientGeneratedId: request.request.body.clientGeneratedId,
      message: request.request.body.message,
    });
    await sending;
    expect(component['draft']()).toBe('另一个话题草稿');
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    expect(item.published()).toBe(true);
    expect(component['outbox'].items()).toContain(item);
    expect(TestBed.inject(DraftStore).get(testChat.id, encodeId('100'))).toBeUndefined();
    expect(component['conversation'].items().map((item) => item.id)).toEqual([
      encodeId('99'),
      encodeId('101'),
      encodeId('102'),
    ]);
  });

  it('keeps live chat metadata independent of filtered chat and thread lists', async () => {
    const chatInfo = TestBed.inject(ChatStore);
    chatInfo.remember([{ ...testChat, name: '话题所属群' }]);
    vi.mocked(TestBed.inject(ChatStore).cachedReadState).mockReturnValue(undefined);
    await enterThread();
    expect(fixture.nativeElement.querySelector('ion-title').textContent.trim()).toBe('测试消息');
    subscriptions.update((statuses) => new Map(statuses).set(encodeId('100'), { subscribed: true, archived: true }));
    await component['updateThread']();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-title').textContent.trim()).toBe('测试消息');
    chatInfo.remember([{ ...testChat, name: '群名称更新' }]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-title').textContent.trim()).toBe('测试消息');
  });

  it('loads a missing canonical subscription after the owner invalidates it', async () => {
    await enterThread();
    const loadSubscription = TestBed.inject(ChatStore).loadSubscription;
    vi.mocked(loadSubscription).mockClear();
    subscriptions.set(new Map());
    await fixture.whenStable();
    expect(loadSubscription).toHaveBeenCalledOnce();
    expect(loadSubscription).toHaveBeenCalledWith(testChat.id, encodeId('100'));
    expect(component['subscription']()).toBeUndefined();
  });

  it('keeps shared chat state when leaving while releasing the page message window', async () => {
    const sharedPins = component['pins']();
    component.ionViewDidLeave();
    expect(component['conversation'].items()).toEqual([]);
    expect(TestBed.inject(ChatStore).get(testChat.id)?.name).toBe(testChat.name);
    await reenter();
    expect(component['pins']()).toBe(sharedPins);
  });

  it.each(['success', 'failure'])(
    'preserves the next draft while resolving an earlier send %s across reentry',
    async (result) => {
      const accept = vi.spyOn(TestBed.inject(Connection), 'accept');
      component['draft'].set('第一次进入的消息');
      const oldSending = component['sendMessage']();
      const oldRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      const oldItem = component['outbox'].items()[0];
      component.ionViewDidLeave();
      expect(oldRequest.cancelled).toBe(false);
      await reenter();
      expect(component['draft']()).toBe('');
      expect(component['rows']().at(-1)?.outgoing).toBe(oldItem);
      component['draft'].set('再次进入的消息');
      component['replyTo'].set(testMessage);
      void component['sendMessage']();
      const newItem = component['outbox'].items().at(-1)!;
      expect(
        component['rows']()
          .slice(-2)
          .map((row) => row.outgoing),
      ).toEqual([oldItem, newItem]);
      expect(component['draft']()).toBe('');
      expect(component['replyTo']()).toBeUndefined();
      http.expectNone((req) => req.method === 'POST');
      component['updateDraft']('第三条尚未发送');
      component['startReply'](testMessage);
      const open = vi.spyOn(component['conversation'], 'open');
      if (result === 'success')
        oldRequest.flush({
          ...wireMessage,
          id: '9007199254741005',
          clientGeneratedId: oldRequest.request.body.clientGeneratedId,
          message: oldRequest.request.body.message,
        });
      else oldRequest.flush('', { status: 503, statusText: 'Unavailable' });
      await oldSending;
      expect(oldItem.delivery()).toBe(result === 'success' ? MessageDelivery.Sent : MessageDelivery.Failed);
      const newRequest = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
      expect(newRequest.request.body.clientGeneratedId).toBe(newItem.clientGeneratedId);
      expect(newRequest.request.body.message).toBe('再次进入的消息');
      expect(newRequest.request.body.replyToId).toBe(wireMessage.id);
      expect(oldItem.delivery()).toBe(result === 'success' ? MessageDelivery.Sent : MessageDelivery.Failed);
      expect(component['draft']()).toBe('第三条尚未发送');
      expect(component['replyTo']()).toBe(testMessage);
      expect(open).not.toHaveBeenCalled();
      expect(accept).toHaveBeenCalledTimes(result === 'success' ? 1 : 0);
      newRequest.flush('', { status: 503, statusText: 'Unavailable' });
      await vi.waitFor(() => expect(newItem.delivery()).toBe(MessageDelivery.Failed));
      await fixture.whenStable();
      expect(newItem.delivery()).toBe(MessageDelivery.Failed);
      expect(component['rows']().at(-1)?.outgoing).toBe(newItem);
      expect(component['draft']()).toBe('第三条尚未发送');
      expect(component['replyTo']()).toBe(testMessage);
    },
  );

  it('does not report a subscription failure from an earlier visit to the same topic', async () => {
    await enterThread();
    const pending = deferred<void>();
    vi.mocked(TestBed.inject(ChatStore).loadSubscription).mockReturnValueOnce(pending.promise);
    const loading = component['loadSubscription']();
    component.ionViewDidLeave();
    await reenter();
    pending.reject(new Error('Previous visit failed'));
    await loading;
    expect(component['threadError']()).toBeUndefined();
  });

  it('keeps a new topic action busy when a previous visit’s action finishes', async () => {
    await enterThread();
    const oldAction = deferred<void>();
    const newAction = deferred<void>();
    vi.mocked(TestBed.inject(ChatStore).subscribeThread)
      .mockReturnValueOnce(oldAction.promise)
      .mockReturnValueOnce(newAction.promise);
    const oldUpdating = component['updateThread']();
    component.ionViewDidLeave();
    await reenter();
    expect(component['threadBusy']()).toBe(false);
    const newUpdating = component['updateThread']();
    oldAction.reject(new Error('Previous action failed'));
    await oldUpdating;
    expect(component['threadBusy']()).toBe(true);
    expect(component['threadError']()).toBeUndefined();
    newAction.reject(new Error('Current action failed'));
    await newUpdating;
    expect(component['threadBusy']()).toBe(false);
    expect(component['threadError']()).toBe(ThreadError.Update);
  });

  it('ignores an unfinished scroll event after reentering the same chat', async () => {
    const pendingScroll = deferred<HTMLElement>();
    vi.mocked(IonContent.prototype.getScrollElement).mockReturnValueOnce(pendingScroll.promise);
    const scrolling = component['onScroll']();
    component.ionViewDidLeave();
    await reenter();
    component.ionViewDidEnter();
    await fixture.whenStable();
    const load = vi.spyOn(component['conversation'], 'load');
    scroll.scrollTop = 0;
    pendingScroll.resolve(scroll);
    await scrolling;
    expect(load).not.toHaveBeenCalled();
    http.expectNone(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`);
  });

  it('continues queued sends after page destruction and hands confirmations to the next page', async () => {
    const outbox = TestBed.inject(MessageOutbox);
    component['draft'].set('销毁前第一条');
    const firstSending = component['sendMessage']();
    const firstRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    component['draft'].set('销毁前第二条');
    void component['sendMessage']();
    const [first, second] = outbox.items();
    const oldConversation = component['conversation'];
    fixture.destroy();
    expect(firstRequest.cancelled).toBe(false);
    expect(outbox.items()).toEqual([first, second]);
    firstRequest.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: firstRequest.request.body.clientGeneratedId,
      message: firstRequest.request.body.message,
    });
    await firstSending;
    const secondRequest = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(secondRequest.request.body.clientGeneratedId).toBe(second.clientGeneratedId);
    secondRequest.flush({
      ...wireMessage,
      id: '9007199254741007',
      clientGeneratedId: secondRequest.request.body.clientGeneratedId,
      message: secondRequest.request.body.message,
    });
    await vi.waitFor(() => expect(second.published()).toBe(true));
    expect(first.published()).toBe(true);
    expect(second.published()).toBe(true);
    expect(oldConversation.items()).toEqual([]);
    expect(outbox.items()).toEqual([first, second]);

    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({ messages: [structuredClone(wireMessage)] });
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component['outbox']).toBe(outbox);
    expect(component['draft']()).toBe('');
    expect(component['conversation'].items().map((message) => message.id)).toEqual([
      testMessage.id,
      encodeId('9007199254741005'),
      encodeId('9007199254741007'),
    ]);
    expect(fixture.debugElement.queryAll(By.directive(Message))).toHaveLength(3);
    expect(outbox.items()).toEqual([]);
  });

  it('cancels a topic read-state request when the page is destroyed', async () => {
    fixture.componentRef.setInput('threadId', '100');
    fixture.detectChanges();
    for (const req of http.match(`/_api/chats/${wireChat.id}/messages/100`)) req.flush({ ...wireMessage, id: '100' });
    const request = http.expectOne(`/_api/chats/${wireChat.id}/threads/100/read-state`);
    fixture.destroy();
    expect(request.cancelled).toBe(true);
    await Promise.resolve();
    expect(component['conversation'].items()).toEqual([]);
    http.expectNone(`/_api/chats/${wireChat.id}/messages?max=50&around=100&threadId=100`);
  });

  it('locates a message from a shared query URL without falling back to the read boundary', async () => {
    const animate = vi.fn();
    Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true });
    const id = '9007199254741999';
    fixture.componentRef.setInput('message', id);
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=${id}`).flush({
      messages: [{ ...wireMessage, id }],
    });
    await fixture.whenStable();
    expect(component['conversation'].items()[0].id).toBe(encodeId(id));
    expect(component['conversation'].error()).toBeUndefined();
    fixture.detectChanges();
    await component['positionAndRead']();
    fixture.componentRef.setInput('message', 'invalid');
    fixture.detectChanges();
    expect(component.message()).toBeUndefined();
    http.expectNone(() => true);
    fixture.destroy();
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  it('allows selecting the next reply while a submitted reply is still sending', async () => {
    component['replyTo'].set(testMessage);
    component['draft'].set('正在回复');
    const sending = component['sendMessage']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    const item = component['outbox'].items()[0];
    const nextReply = { ...testMessage, id: encodeId('999'), clientGeneratedId: 'next-reply-999' };
    component['startReply'](nextReply);
    expect(component['replyTo']()).toBe(nextReply);
    expect(item.message().replyToMessage).toMatchObject(testMessage);
    expect(request.request.body.replyToId).toBe(wireMessage.id);
    request.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(component['draft']()).toBe('');
    expect(component['replyTo']()).toBe(nextReply);
  });

  it.each([false, true])('selects the original reply on a fresh collection link, retrying: %s', async (retrying) => {
    Object.defineProperty(Element.prototype, 'animate', { value: vi.fn(), configurable: true });
    const focus = vi.spyOn(IonTextarea.prototype, 'setFocus').mockResolvedValue();
    const id = '9007199254741999';
    fixture.destroy();
    fixture = TestBed.createComponent(ConversationPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('id', wireChat.id);
    fixture.componentRef.setInput('reply', id);
    fixture.detectChanges();
    let request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=${id}`);
    if (retrying) {
      request.flush('', { status: 503, statusText: 'Unavailable' });
      await vi.waitFor(() => expect(component['conversation'].error()).toBe(ConversationError.Open));
      expect(component['replyTo']()).toBeUndefined();
      component['retry']();
      request = http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&around=${id}`);
    }
    request.flush({ messages: [{ ...structuredClone(wireMessage), id, message: '原会话最新内容' }] });
    await vi.waitFor(() => expect(component['replyTo']()).toMatchObject({ id: encodeId(id) }));
    await fixture.whenStable();
    expect(component['replyTo']()).toBe(component['conversation'].items()[0]);
    expect(component['replyTo']()?.message).toBe('原会话最新内容');
    expect(focus).toHaveBeenCalled();
    fixture.componentRef.setInput('reply', 'invalid');
    fixture.detectChanges();
    expect(component.reply()).toBeUndefined();
    http.expectNone(() => true);
    fixture.destroy();
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  it('applies remote edits and recall to the current conversation through the change stream', () => {
    events.next({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, message: '更新后的正文', isEdited: true },
    });
    expect(component['conversation'].items()[0].message).toBe('更新后的正文');
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    expect(component['conversation'].items()[0].isDeleted).toBe(true);
    fixture.detectChanges();
    expect(component['rows']()).toEqual([]);
    expect(fixture.nativeElement.querySelector('app-message, .message-date')).toBeNull();
    expect(fixture.nativeElement.querySelector('.message-list').textContent).not.toContain('消息已删除');
  });

  it('omits deleted history and paging-time recalls before grouping dates and avatars', async () => {
    const loading = component['conversation'].load(PageDirection.Older);
    events.next({
      type: ServerWsMessageType.messagesBulkDeleted,
      payload: {
        chatId: testChat.id,
        messageIds: [encodeId('9007199254741001')],
      },
    });
    http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50&before=${wireMessage.id}`).flush({
      messages: [
        {
          ...wireMessage,
          id: '9007199254740999',
          clientGeneratedId: 'deleted-history',
          isDeleted: true,
          createdAt: '2026-09-04T12:00:00Z',
        },
        { ...wireMessage, id: '9007199254741000', clientGeneratedId: 'visible-history' },
        {
          ...wireMessage,
          id: '9007199254741001',
          clientGeneratedId: 'recalled-history',
          sender: { uid: 2, name: '朋友', gender: 0 },
        },
      ],
    });
    await loading;
    fixture.detectChanges();
    expect(
      component['rows']().map(({ message, first, last, dateBreak }) => ({ id: message.id, first, last, dateBreak })),
    ).toEqual([
      { id: encodeId('9007199254741000'), first: true, last: false, dateBreak: true },
      { id: testMessage.id, first: false, last: true, dateBreak: false },
    ]);
    expect(fixture.nativeElement.querySelectorAll('app-message')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('.message-date')).toHaveLength(1);
    expect(component['conversation'].page()?.olderCursor).toBeUndefined();
  });

  it('moves the unread separator to the next visible message after a recall', () => {
    component['entryReadId'].set(encodeId('9007199254741000'));
    component['conversation'].receive({
      ...testMessage,
      id: encodeId('9007199254741004'),
      clientGeneratedId: 'next-message',
    });
    expect(component['firstUnreadId']()).toBe(testMessage.id);
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    expect(component['firstUnreadId']()).toBe(encodeId('9007199254741004'));
  });

  it('removes a recalled message when the local delete request succeeds', async () => {
    const recalling = component['menu']()!['messageActions'].recall(testMessage);
    http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`).flush(null);
    await recalling;
    fixture.detectChanges();
    expect(component['rows']()).toEqual([]);
    expect(fixture.nativeElement.querySelector('app-message, .message-date')).toBeNull();
  });

  it('does not submit a sixth personal reaction', async () => {
    await component['menu']()!['reactTo'](
      {
        ...testMessage,
        reactions: ['👍', '❤️', '😂', '😮', '😢'].map((emoji) => ({ emoji, count: 1, reactedByMe: true })),
      },
      '🎉',
    );
    expect(component['menu']()!['notice']()).toBe(MessageNotice.ReactionLimit);
    http.expectNone(() => true);
  });
  it('passes reactive avatar preferences to message children', () => {
    fixture.detectChanges();
    const message = fixture.debugElement.query(By.directive(Message)).componentInstance as Message;
    expect(message.showAllAvatars()).toBe(false);
    avatars.set(true);
    fixture.detectChanges();
    expect(message.showAllAvatars()).toBe(true);
  });

  it('resolves an ID-only menu selection against the latest message', async () => {
    const details = TestBed.inject(ChatStore).ensureDetails(testChat.id);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...structuredClone(wireChat), myRole: GroupRole.member });
    await details;
    component['menu']()!['selection'].set({
      messageId: testMessage.id,
      element: document.createElement('div'),
      rect: new DOMRect(),
      own: false,
      first: true,
      last: true,
    });
    events.next({ type: ServerWsMessageType.messageUpdated, payload: { ...testMessage, message: '编辑后的消息' } });
    fixture.detectChanges();
    expect(component['menu']()!['message']()?.message).toBe('编辑后的消息');
    expect(component['menu']()!['selection']()).not.toHaveProperty('message');
  });
  it('enqueues an edit and immediately restores the separate unsent draft and reply', async () => {
    component['updateDraft']('未发送的草稿');
    component['startReply'](testMessage);
    component['startEdit'](testMessage);
    component['updateDraft']('编辑内容');
    const sending = component['sendMessage']({ messageType: MessageType.text, attachmentIds: [encodeId('100')] });
    const item = component['outbox'].items()[0];
    expect(item.editId).toBe(testMessage.id);
    expect(item.threadId).toBeUndefined();
    expect(component['editing']()).toBeUndefined();
    expect(component['draft']()).toBe('未发送的草稿');
    expect(component['replyTo']()).toBe(testMessage);
    expect(component['savedReplyId']()).toBeUndefined();
    fixture.detectChanges();
    expect(component['composer']()!.text()).toBe('未发送的草稿');
    expect(component['rows']()).toHaveLength(1);
    expect(component['rows']()[0].outgoing).toBe(item);
    expect(component['rows']()[0].message.message).toBe('编辑内容');
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ message: '编辑内容', attachmentIds: ['100'] });
    http.expectNone((req) => req.method === 'POST');
    request.flush({ ...wireMessage, message: '编辑内容', isEdited: true });
    await sending;
    await fixture.whenStable();
    expect(component['conversation'].items()[0].message).toBe('编辑内容');
    expect(component['rows']()).toHaveLength(1);
    expect(component['draft']()).toBe('未发送的草稿');
    expect(component['replyTo']()).toBe(testMessage);
    expect(component['outbox'].items()).toEqual([]);
  });

  it('edits a pending outgoing item in place and immediately restores the unsent draft and reply', async () => {
    const outbox = TestBed.inject(MessageOutbox);
    const media = pendingUpload();
    const composition = { messageType: MessageType.text, attachmentIds: [], uploads: [media.upload] };
    component['updateDraft']('原待发消息');
    const sending = component['sendMessage'](composition);
    const item = outbox.items()[0];
    fixture.detectChanges();
    const originalRows = fixture.debugElement.queryAll(By.directive(Message));
    const local = originalRows.at(-1)!;
    const rowKeys = component['rows']().map((row) => row.key);
    expect(originalRows).toHaveLength(2);
    expect(local.nativeElement.textContent).toContain('原待发消息');
    http.expectNone((request) => request.method === 'POST' || request.method === 'PATCH');

    const edit = vi.spyOn(outbox, 'edit');
    const enqueue = vi.spyOn(outbox, 'enqueue');
    const enqueueEdit = vi.spyOn(outbox, 'enqueueEdit');
    component['updateDraft']('未提交的下一条草稿');
    component['startReply'](testMessage);
    component['startEdit'](item);
    fixture.detectChanges();
    expect(component['editing']()?.message).toBe('原待发消息');
    expect(component['composer']()!.text()).toBe('原待发消息');
    typeText('  修改后的待发消息  ');
    const editing = component['sendMessage'](composition);
    const operation = item.operation;
    expect(edit).toHaveBeenCalledExactlyOnceWith(item, '修改后的待发消息', composition);
    expect(enqueue).not.toHaveBeenCalled();
    expect(enqueueEdit).not.toHaveBeenCalled();
    expect(outbox.items()).toEqual([item]);
    expect(component['editing']()).toBeUndefined();
    expect(component['draft']()).toBe('未提交的下一条草稿');
    expect(component['replyTo']()).toBe(testMessage);
    fixture.detectChanges();
    expect(component['composer']()!.text()).toBe('未提交的下一条草稿');
    expect(component['rows']().map((row) => row.key)).toEqual(rowKeys);
    expect(component['rows']().at(-1)?.outgoing).toBe(item);
    expect(fixture.debugElement.queryAll(By.directive(Message)).map((row) => row.nativeElement)).toEqual(
      originalRows.map((row) => row.nativeElement),
    );
    expect((local.componentInstance as Message<MessageContent>).message().message).toBe('修改后的待发消息');
    expect(local.nativeElement.textContent).toContain('修改后的待发消息');
    http.expectNone((request) => request.method === 'POST' || request.method === 'PATCH');
    typeText('编辑退出后继续写草稿');

    media.finish(encodeId('100'));
    const request = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(request.request.method).toBe('POST');
    expect(request.request.body.message).toBe('修改后的待发消息');
    expect(request.request.body.attachmentIds).toEqual(['100']);
    request.flush({
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: request.request.body.clientGeneratedId,
      message: '修改后的待发消息',
      hasAttachments: true,
      attachments: [{ id: '100', url: media.upload.url, fileName: 'edit.png', kind: 'image/png', size: 5 }],
    });
    await Promise.all([sending, editing, operation]);
    await vi.waitFor(() => expect(item.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(2);
    expect(fixture.debugElement.queryAll(By.directive(Message)).at(-1)!.nativeElement).toBe(local.nativeElement);
    expect((local.componentInstance as Message<MessageContent>).message().message).toBe('修改后的待发消息');
    expect(component['draft']()).toBe('编辑退出后继续写草稿');
    expect(component['replyTo']()).toBe(testMessage);
    expect(component['composer']()!.text()).toBe('编辑退出后继续写草稿');
    expect(outbox.items()).toEqual([]);
    http.expectNone((request) => request.method === 'POST' || request.method === 'PATCH');
  });

  it('preserves an open outgoing edit through upload changes and create acknowledgement, then PATCHes the released item', async () => {
    const outbox = TestBed.inject(MessageOutbox);
    const retained = pendingUpload('retained.png');
    const removed = pendingUpload('removed.png');
    const added = pendingUpload('added.png');
    component['updateDraft']('创建时的正文');
    const sending = component['sendMessage']({
      messageType: MessageType.text,
      attachmentIds: [],
      uploads: [retained.upload, removed.upload],
    });
    const item = outbox.items()[0];
    component['updateDraft']('下一条未发送草稿');
    component['startReply'](testMessage);
    component['startEdit'](item);
    fixture.detectChanges();
    const local = fixture.debugElement.queryAll(By.directive(Message)).at(-1)!;
    const composer = component['composer']()!;
    expect(composer['selectedUploads']()).toEqual([retained.upload, removed.upload]);
    composer['remove'](removed.upload);
    composer['uploads'].set([added.upload]);
    typeText('确认前已经改写的正文');
    expect(composer['selectedUploads']()).toEqual([retained.upload, added.upload]);
    expect(removed.upload.dispose).not.toHaveBeenCalled();

    retained.progress(0.75);
    added.progress(0.5);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component['editing']()).toBeDefined();
    expect(component['editText']()).toBe('确认前已经改写的正文');
    expect(composer.text()).toBe('确认前已经改写的正文');
    expect(composer['selectedUploads']()).toEqual([retained.upload, added.upload]);
    expect(added.upload.dispose).not.toHaveBeenCalled();
    const selected: HTMLElement = fixture.nativeElement.querySelector('app-message-composer .uploads');
    expect(selected.textContent).toContain('retained.png');
    expect(selected.textContent).toContain('added.png');
    expect(selected.textContent).not.toContain('removed.png');

    retained.finish(encodeId('100'));
    removed.finish(encodeId('101'));
    const create = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages`));
    expect(create.request.method).toBe('POST');
    expect(create.request.body.message).toBe('创建时的正文');
    expect(create.request.body.attachmentIds).toEqual(['100', '101']);
    fixture.detectChanges();
    expect(composer.text()).toBe('确认前已经改写的正文');
    expect(composer['selectedUploads']()).toEqual([retained.upload, added.upload]);
    const attachment = (id: string, upload: AttachmentUpload) => ({
      id,
      url: upload.url,
      fileName: upload.file.name,
      kind: upload.file.type,
      size: upload.file.size,
    });
    const created = {
      ...wireMessage,
      id: '9007199254741005',
      clientGeneratedId: create.request.body.clientGeneratedId,
      message: '创建时的正文',
      hasAttachments: true,
      attachments: [attachment('100', retained.upload), attachment('101', removed.upload)],
    };
    create.flush(structuredClone(created));
    await sending;
    await vi.waitFor(() => expect(item.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(item.confirmed()?.id).toBe(encodeId(created.id));
    expect(item.disposed).toBe(true);
    expect(outbox.items()).toEqual([]);
    expect(component['rows']()).toHaveLength(2);
    expect(fixture.debugElement.queryAll(By.directive(Message)).at(-1)!.nativeElement).toBe(local.nativeElement);
    expect(component['editing']()).toBeDefined();
    expect(component['editText']()).toBe('确认前已经改写的正文');
    expect(composer.text()).toBe('确认前已经改写的正文');
    expect(composer['selectedUploads']()).toEqual([retained.upload, added.upload]);
    expect(added.upload.dispose).not.toHaveBeenCalled();
    expect(selected.textContent).toContain('added.png');
    expect(selected.textContent).not.toContain('removed.png');

    const edit = vi.spyOn(outbox, 'edit');
    const enqueue = vi.spyOn(outbox, 'enqueue');
    typeText('确认前已经改写的正文，确认后继续补充');
    const send: HTMLButtonElement = fixture.nativeElement.querySelector('.send-button');
    expect(send.disabled).toBe(false);
    send.click();
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      item,
      '确认前已经改写的正文，确认后继续补充',
      expect.objectContaining({ messageType: MessageType.text, uploads: [retained.upload, added.upload] }),
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(component['editing']()).toBeUndefined();
    expect(component['draft']()).toBe('下一条未发送草稿');
    expect(component['replyTo']()).toBe(testMessage);
    const patchItem = outbox.items()[0];
    fixture.detectChanges();
    expect(composer.text()).toBe('下一条未发送草稿');
    expect(component['rows']()).toHaveLength(2);
    expect(added.upload.dispose).not.toHaveBeenCalled();
    http.expectNone((request) => request.method === 'POST');
    added.finish(encodeId('102'));
    const patch = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages/${created.id}`));
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      message: '确认前已经改写的正文，确认后继续补充',
      attachmentIds: ['100', '102'],
    });
    patch.flush({
      ...created,
      message: '确认前已经改写的正文，确认后继续补充',
      isEdited: true,
      attachments: [attachment('100', retained.upload), attachment('102', added.upload)],
    });
    await vi.waitFor(() => expect(patchItem.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(2);
    expect(fixture.debugElement.queryAll(By.directive(Message)).at(-1)!.nativeElement).toBe(local.nativeElement);
    expect((local.componentInstance as Message<MessageContent>).message().message).toBe(
      '确认前已经改写的正文，确认后继续补充',
    );
    expect(component['draft']()).toBe('下一条未发送草稿');
    expect(component['replyTo']()).toBe(testMessage);
    expect(outbox.items()).toEqual([]);
    http.expectNone((request) => request.method === 'POST' || request.method === 'PATCH');
  });

  it('hands off unfinished edit uploads immediately, overlays the original row and PATCHes only after upload', async () => {
    const newer = {
      ...testMessage,
      id: encodeId('9007199254741005'),
      clientGeneratedId: 'newer-edit-neighbor',
      message: '后面的消息',
    };
    incoming.next(newer);
    fixture.detectChanges();
    const originalRows = fixture.debugElement.queryAll(By.directive(Message));
    const original = originalRows[0];
    const message = original.componentInstance as Message<MessageContent>;
    const neighbor = originalRows[1].componentInstance as Message<MessageContent>;
    const media = pendingUpload();
    component['updateDraft']('未发送的草稿');
    component['startReply'](newer);
    component['startEdit'](testMessage);
    fixture.detectChanges();
    const composer = component['composer']()!;
    composer['uploads'].set([media.upload]);
    typeText('带附件的编辑');
    const send: HTMLButtonElement = fixture.nativeElement.querySelector('.send-button');
    expect(send.disabled).toBe(false);
    send.click();
    const item = component['outbox'].items()[0];
    const operation = item.operation;
    expect(item.editId).toBe(testMessage.id);
    expect(item.uploads).toEqual([media.upload]);
    expect(component['editing']()).toBeUndefined();
    expect(component['draft']()).toBe('未发送的草稿');
    expect(component['replyTo']()).toBe(newer);
    expect(component['savedReplyId']()).toBeUndefined();
    expect(composer['uploads']()).toEqual([]);
    expect(media.upload.retry).toHaveBeenCalledOnce();
    http.expectNone((req) => req.method === 'PATCH' || req.method === 'POST');
    fixture.detectChanges();
    expect(composer.text()).toBe('未发送的草稿');
    expect(media.upload.dispose).not.toHaveBeenCalled();
    expect(component['outbox'].items()).toEqual([item]);
    expect(component['rows']().map((row) => row.message.id)).toEqual([testMessage.id, newer.id]);
    expect(fixture.debugElement.queryAll(By.directive(Message)).map((row) => row.nativeElement)).toEqual(
      originalRows.map((row) => row.nativeElement),
    );
    expect(message.message()).toMatchObject({
      id: testMessage.id,
      message: '带附件的编辑',
      createdAt: testMessage.createdAt,
    });
    expect(message.message().attachments).toEqual([
      expect.objectContaining({ url: media.upload.url, fileName: 'edit.png' }),
    ]);
    expect(original.nativeElement.textContent).toContain('带附件的编辑');
    expect(message.delivery()).toBe(MessageDelivery.Sending);
    expect(neighbor.interactive()).toBe(true);
    expect(neighbor.canReply()).toBe(true);
    const openMenu = vi.spyOn(component['menu']()!, 'open').mockImplementation(() => {});
    originalRows[1].query(By.css('.bubble')).triggerEventHandler('contextmenu', new MouseEvent('contextmenu'));
    expect(openMenu).toHaveBeenCalledOnce();
    expect(openMenu).toHaveBeenCalledWith(expect.objectContaining({ messageId: newer.id }));
    expect((fixture.nativeElement.querySelector('.attach-button') as HTMLButtonElement).disabled).toBe(false);
    expect((fixture.nativeElement.querySelector('.reply-close') as HTMLButtonElement).disabled).toBe(false);
    typeText('上传期间的新草稿');
    expect(component['draft']()).toBe('上传期间的新草稿');
    expect((fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).disabled).toBe(false);

    media.finish(encodeId('100'));
    const request = await vi.waitFor(() => http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`));
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ message: '带附件的编辑', attachmentIds: ['100'] });
    request.flush({
      ...wireMessage,
      message: '带附件的编辑',
      isEdited: true,
      hasAttachments: true,
      attachments: [{ id: '100', url: media.upload.url, fileName: 'edit.png', kind: 'image/png', size: 5 }],
    });
    await operation;
    await vi.waitFor(() => expect(item.delivery()).toBe(MessageDelivery.Sent));
    await fixture.whenStable();
    expect(fixture.debugElement.queryAll(By.directive(Message)).map((row) => row.nativeElement)).toEqual(
      originalRows.map((row) => row.nativeElement),
    );
    expect(message.message().message).toBe('带附件的编辑');
    expect(message.interactive()).toBe(true);
    expect(component['outbox'].items()).toEqual([]);
    expect(media.upload.dispose).toHaveBeenCalledOnce();
    expect(component['draft']()).toBe('上传期间的新草稿');
    expect(component['replyTo']()).toBe(newer);
  });

  it('retries a failed edit from its original row without clearing the next draft or reply', async () => {
    const newer = { ...testMessage, id: encodeId('9007199254741005'), clientGeneratedId: 'edit-retry-neighbor' };
    incoming.next(newer);
    component['startEdit'](testMessage);
    component['updateDraft']('需要重试的编辑');
    const sending = component['sendMessage']();
    const item = component['outbox'].items()[0];
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    fixture.detectChanges();
    const original = fixture.debugElement.queryAll(By.directive(Message))[0];
    typeText('新的未发送草稿');
    component['startReply'](newer);
    request.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    await fixture.whenStable();
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(component['editing']()).toBeUndefined();
    expect(component['rows']().map((row) => row.message.id)).toEqual([testMessage.id, newer.id]);
    expect(fixture.debugElement.queryAll(By.directive(Message))[0].nativeElement).toBe(original.nativeElement);
    expect(original.nativeElement.textContent).toContain('需要重试的编辑');
    expect(component['draft']()).toBe('新的未发送草稿');
    expect(component['replyTo']()).toBe(newer);
    const retry: HTMLButtonElement = original.nativeElement.querySelector('.retry-button');
    expect(retry).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.retry-button')).toHaveLength(1);
    retry.click();
    const operation = item.operation;
    const retried = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    expect(retried.request.method).toBe('PATCH');
    expect(retried.request.body).toEqual(request.request.body);
    expect(component['outbox'].items()).toEqual([item]);
    expect(item.delivery()).toBe(MessageDelivery.Sending);
    fixture.detectChanges();
    expect(original.nativeElement.querySelector('.retry-button')).toBeNull();
    typeText('重试期间继续输入');
    expect(component['replyTo']()).toBe(newer);
    retried.flush({ ...wireMessage, message: '需要重试的编辑', isEdited: true });
    await operation;
    await fixture.whenStable();
    expect(component['rows']()).toHaveLength(2);
    expect(fixture.debugElement.queryAll(By.directive(Message))[0].nativeElement).toBe(original.nativeElement);
    expect(original.nativeElement.textContent).toContain('需要重试的编辑');
    expect(original.nativeElement.querySelector('.retry-button')).toBeNull();
    expect((original.componentInstance as Message<MessageContent>).interactive()).toBe(true);
    expect(component['outbox'].items()).toEqual([]);
    expect(component['draft']()).toBe('重试期间继续输入');
    expect(component['replyTo']()).toBe(newer);
    expect(component['composer']()!.text()).toBe('重试期间继续输入');
    http.expectNone((req) => req.method === 'POST');
  });

  it.each(['navigation', 'destroy'])(
    'keeps an edit confirmation effective after %s and hands it to the returning page',
    async (mode) => {
      const outbox = TestBed.inject(MessageOutbox);
      const acceptChange = vi.spyOn(TestBed.inject(Connection), 'acceptChange');
      component['updateDraft']('原会话未发送草稿');
      component['startEdit'](testMessage);
      component['updateDraft']('离开后完成的编辑');
      const sending = component['sendMessage']();
      const item = outbox.items()[0];
      const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
      const otherChatId = encodeId('9007199254740995');
      const otherMessage = {
        ...testMessage,
        id: encodeId('9007199254741010'),
        chatId: otherChatId,
        clientGeneratedId: 'other-chat-message',
        message: '另一个会话的消息',
      };
      TestBed.inject(ChatStore).remember([{ ...testChat, id: otherChatId }]);
      if (mode === 'destroy') {
        fixture.destroy();
        fixture = TestBed.createComponent(ConversationPage);
        component = fixture.componentInstance;
      }
      fixture.componentRef.setInput('id', decodeId(otherChatId));
      fixture.detectChanges();
      http.expectOne(`/_api/chats/${decodeId(otherChatId)}/messages?max=50`).flush({
        messages: [{ ...otherMessage, id: decodeId(otherMessage.id), chatId: decodeId(otherChatId) }],
      });
      await fixture.whenStable();
      expect(request.cancelled).toBe(false);
      expect(outbox.items()).toContain(item);
      expect(TestBed.inject(DraftStore).get(testChat.id)?.text).toBe('原会话未发送草稿');
      typeText('另一个会话的新草稿');
      component['startReply'](otherMessage);
      component['startEdit'](otherMessage);
      component['updateDraft']('另一个会话正在编辑');
      request.flush({ ...wireMessage, message: '离开后完成的编辑', isEdited: true });
      await sending;
      await fixture.whenStable();
      expect(item.delivery()).toBe(MessageDelivery.Sent);
      expect(item.confirmed()).toMatchObject({ id: testMessage.id, message: '离开后完成的编辑', isEdited: true });
      expect(acceptChange).toHaveBeenCalledWith({
        type: ServerWsMessageType.messageUpdated,
        payload: expect.objectContaining({ id: testMessage.id, message: '离开后完成的编辑' }),
      });
      expect(component['conversation'].items()).toEqual([otherMessage]);
      expect(component['rows']()).toHaveLength(1);
      expect(component['draft']()).toBe('另一个会话的新草稿');
      expect(component['replyTo']()).toBe(otherMessage);
      expect(component['editing']()).toBe(otherMessage);
      expect(component['composer']()!.text()).toBe('另一个会话正在编辑');

      fixture.componentRef.setInput('id', wireChat.id);
      fixture.detectChanges();
      // A stale initial GET must not erase a confirmation retained by the shared outbox.
      http.expectOne(`/_api/chats/${wireChat.id}/messages?max=50`).flush({ messages: [structuredClone(wireMessage)] });
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(component['outbox']).toBe(outbox);
      expect(component['rows']()).toHaveLength(1);
      expect(component['rows']()[0].message).toMatchObject({
        id: testMessage.id,
        message: '离开后完成的编辑',
        isEdited: true,
      });
      expect(fixture.debugElement.queryAll(By.directive(Message))).toHaveLength(1);
      const returned: HTMLElement = fixture.nativeElement.querySelector('app-message');
      expect(returned.textContent).toContain('离开后完成的编辑');
      expect(component['draft']()).toBe('原会话未发送草稿');
      expect(component['editing']()).toBeUndefined();
      expect(outbox.items()).toContain(item);
      events.next({
        type: ServerWsMessageType.messageUpdated,
        payload: { ...testMessage, message: '离开后完成的编辑', isEdited: true },
      });
      await fixture.whenStable();
      expect(component['conversation'].items()[0].message).toBe('离开后完成的编辑');
      expect(fixture.nativeElement.querySelector('app-message')).toBe(returned);
      expect(component['rows']()).toHaveLength(1);
      expect(outbox.items()).toEqual([]);
      http.expectNone((req) => req.method === 'PATCH' || req.method === 'POST');
    },
  );

  it.each([MessageType.file, MessageType.audio, MessageType.sticker])(
    'preserves unsent text while a %s submission clears its reply and retains a retryable row',
    async (messageType) => {
      component['updateDraft']('稍后发送的文字');
      component['startReply'](testMessage);
      const sticker =
        messageType === MessageType.sticker
          ? {
              id: encodeId('102'),
              createdAt: testMessage.createdAt,
              emoji: '🙂',
              isFavorited: false,
              media: {
                id: encodeId('103'),
                contentType: 'image/png',
                size: 1,
                url: 'data:image/png;base64,iVBORw0KGgo=',
              },
            }
          : undefined;
      const attachmentIds = sticker ? [] : [encodeId('101')];
      const sending = component['sendMessage']({ messageType, attachmentIds, sticker });
      const item = component['outbox'].items()[0];
      const request = http.expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'));
      expect(request.request.body.messageType).toBe(messageType);
      expect(request.request.body.message).toBeUndefined();
      expect(request.request.body.attachmentIds).toEqual(sticker ? [] : ['101']);
      expect(request.request.body.stickerId).toBe(sticker ? '102' : undefined);
      expect(request.request.body.replyToId).toBe(wireMessage.id);
      expect(component['draft']()).toBe('稍后发送的文字');
      expect(component['replyTo']()).toBeUndefined();
      expect(component['rows']().at(-1)?.outgoing).toBe(item);
      request.flush('', { status: 503, statusText: 'Unavailable' });
      await sending;
      fixture.detectChanges();
      expect(item.delivery()).toBe(MessageDelivery.Failed);
      expect(component['draft']()).toBe('稍后发送的文字');
      expect(component['replyTo']()).toBeUndefined();
      expect(fixture.nativeElement.querySelector('app-message:last-child .retry-button')).not.toBeNull();
      const retrying = component['outbox'].retry(item);
      const retry = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
      expect(retry.request.body).toEqual(request.request.body);
      retry.flush({
        ...wireMessage,
        id: '9007199254741010',
        messageType,
        message: null,
        clientGeneratedId: retry.request.body.clientGeneratedId,
      });
      await retrying;
      expect(item.delivery()).toBe(MessageDelivery.Sent);
      expect(component['draft']()).toBe('稍后发送的文字');
      expect(component['replyTo']()).toBeUndefined();
    },
  );
});
