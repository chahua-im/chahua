import { MessageType } from '../../../generated/models';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, RouterLink } from '@angular/router';
import { IonContent, IonTextarea, IonModal } from '@ionic/angular';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { PinsService } from '../../../generated/endpoints/pins/pins.service';
import {
  GroupRole,
  ServerWsMessageType,
  type MessageResponse,
  type ServerWsMessage,
  type ThreadSubscriptionStatusResponse,
} from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../../api/testing';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ChatStore } from '../../chats/chat-store';
import { ConversationNavigation, ConversationTargetKind } from '../conversation-navigation';
import { ConversationError, PageDirection } from '../conversation-store';
import { DraftStore } from '../draft-store';
import { MessageAction } from '../../messages/message-menu/message-menu';
import { MessageNotice } from '../../messages/message-notice';
import { Message } from '../../messages/message/message';
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

  async function enterThread(rootId = '100', read: { lastReadMessageId?: string } = { lastReadMessageId: '101' }) {
    fixture.componentRef.setInput('threadId', rootId);
    fixture.detectChanges();
    http.expectOne(`/_api/chats/${wireChat.id}/messages/${rootId}`).flush({ ...wireMessage, id: rootId });
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
          { ...wireMessage, id: rootId },
          { ...wireMessage, id: '101', replyRootId: rootId },
          { ...wireMessage, id: '102', replyRootId: rootId },
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
      .flush({ messages: [{ ...wireMessage, id: '100' }], olderCursor: '100' });
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
    expect(fixture.nativeElement.querySelector('ion-alert').header).toBe('取消置顶');
    expect(fixture.nativeElement.querySelector('ion-alert').isOpen).toBe(true);
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
    'clears a sent draft persisted during the request: %s',
    async (mode) => {
      const drafts = TestBed.inject(DraftStore);
      component['updateDraft']('正在发送');
      const sending = component['sendMessage']();
      const request = http.expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'));
      expect(drafts.get(testChat.id)).toBeUndefined();
      if (mode === 'background') {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        component.ionViewWillLeave();
        vi.mocked(TestBed.inject(Router).isActive).mockReturnValue(false);
        if (mode === 'left') component.ionViewDidLeave();
      }
      expect(drafts.get(testChat.id)?.text).toBe('正在发送');
      request.flush({ ...wireMessage, message: '正在发送' });
      await sending;
      expect(drafts.get(testChat.id)).toBeUndefined();
      component.ionViewDidLeave();
      expect(drafts.get(testChat.id)).toBeUndefined();
    },
  );

  it('restores a draft after leaving and clears persisted text only after a successful send', async () => {
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
    http
      .expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'))
      .flush({ ...wireMessage, message: '保留草稿' });
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

  it('keeps failed input locally and saves it when leaving', async () => {
    component['updateDraft']('待重试');
    const sending = component['sendMessage']();
    http.expectOne(`/_api/chats/${wireChat.id}/messages`).flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    expect(component['draft']()).toBe('待重试');
    expect(TestBed.inject(DraftStore).get(testChat.id)).toBeUndefined();
    component.ionViewDidLeave();
    expect(TestBed.inject(DraftStore).get(testChat.id)?.text).toBe('待重试');
  });

  it('keeps the draft and idempotency key when retrying a failed text send', async () => {
    component['draft'].set('  新消息  ');
    let sending = component['sendMessage']();
    const first = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(first.request.method).toBe('POST');
    expect(first.request.body.message).toBe('新消息');
    const key: string = first.request.body.clientGeneratedId;
    first.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    expect(component['draft']()).toBe('  新消息  ');
    expect(component['sendError']()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('发送失败');
    sending = component['sendMessage']();
    const retry = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(retry.request.body.clientGeneratedId).toBe(key);
    retry.flush({ ...wireMessage, id: '9007199254741005', clientGeneratedId: key, message: '新消息' });
    await sending;
    expect(component['conversation'].items()).toHaveLength(2);
    expect(component['draft']()).toBe('');
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

  it('sends the selected reply ID, preserves it on failure, and clears it after success or navigation', async () => {
    vi.spyOn(IonTextarea.prototype, 'setFocus').mockResolvedValue();
    component['startReply'](testMessage);
    component['draft'].set('回复内容');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.reply-context').textContent).toContain('测试用户');
    let sending = component['sendMessage']();
    const first = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(first.request.body.replyToId).toBe(wireMessage.id);
    const key: string = first.request.body.clientGeneratedId;
    first.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    expect(component['replyTo']()?.id).toBe(testMessage.id);

    sending = component['sendMessage']();
    const retry = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(retry.request.body.clientGeneratedId).toBe(key);
    expect(retry.request.body.replyToId).toBe(wireMessage.id);
    retry.flush({ ...wireMessage, id: '9007199254741005', message: '回复内容' });
    await sending;
    expect(component['replyTo']()).toBeUndefined();

    component['draft'].set('相同文本');
    component['startReply'](testMessage);
    sending = component['sendMessage']();
    const previous = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    const previousKey = previous.request.body.clientGeneratedId;
    previous.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    component['startReply']({ ...testMessage, id: encodeId('9007199254741005') });
    sending = component['sendMessage']();
    const changed = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    expect(changed.request.body.clientGeneratedId).not.toBe(previousKey);
    changed.flush('', { status: 503, statusText: 'Unavailable' });
    await sending;
    fixture.componentRef.setInput('id', '9007199254740995');
    fixture.detectChanges();
    http.expectOne('/_api/group/9007199254740995').flush({ ...wireChat, id: '9007199254740995' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('/_api/chats/9007199254740995/messages?max=50').flush({ messages: [] });
    expect(component['replyTo']()).toBeUndefined();
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
    request.flush({ ...wireMessage, id: '103', replyRootId: '100' });
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
    await enterThread('99');
    component['draft'].set('另一个话题草稿');
    request.flush({ ...wireMessage, id: '103', replyRootId: '100' });
    await sending;
    expect(component['draft']()).toBe('另一个话题草稿');
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

  it.each(['success', 'failure'])('isolates an earlier send %s after reentering the same chat', async (result) => {
    const accept = vi.spyOn(TestBed.inject(Connection), 'accept');
    component['draft'].set('第一次进入的消息');
    const oldSending = component['sendMessage']();
    const oldRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    component.ionViewDidLeave();
    await reenter();
    component['draft'].set('再次进入的消息');
    component['replyTo'].set(testMessage);
    const newSending = component['sendMessage']();
    const newRequest = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    const open = vi.spyOn(component['conversation'], 'open');
    if (result === 'success') oldRequest.flush({ ...wireMessage, id: '9007199254741005' });
    else oldRequest.flush('', { status: 503, statusText: 'Unavailable' });
    await oldSending;
    expect(component['draft']()).toBe('再次进入的消息');
    expect(component['replyTo']()).toBe(testMessage);
    expect(component['sending']()).toBe(true);
    expect(component['sendError']()).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledTimes(result === 'success' ? 1 : 0);
    newRequest.flush('', { status: 503, statusText: 'Unavailable' });
    await newSending;
  });

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

  it('cancels an unfinished send when the page is destroyed', async () => {
    const accept = vi.spyOn(TestBed.inject(Connection), 'accept');
    component['draft'].set('正在发送');
    const sending = component['sendMessage']();
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages`);
    fixture.destroy();
    expect(request.cancelled).toBe(true);
    await sending;
    expect(accept).not.toHaveBeenCalled();
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

  it('keeps the submitted reply unchanged when a reply is selected while sending', () => {
    component['replyTo'].set(testMessage);
    component['sending'].set(true);
    component['startReply']({ ...testMessage, id: encodeId('999') });
    expect(component['replyTo']()).toBe(testMessage);
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

  it('resolves an ID-only menu selection against the latest message', () => {
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
  it('edits the selected message without overwriting the separate unsent draft', async () => {
    component['updateDraft']('未发送的草稿');
    component['startEdit'](testMessage);
    component['updateDraft']('编辑内容');
    const sending = component['sendMessage']({ messageType: MessageType.text, attachmentIds: [encodeId('100')] });
    const request = http.expectOne((req) => req.method === 'PATCH');
    expect(request.request.body).toEqual({ message: '编辑内容', attachmentIds: ['100'] });
    request.flush({ ...wireMessage, message: '编辑内容', isEdited: true });
    await sending;
    expect(component['conversation'].items()[0].message).toBe('编辑内容');
    expect(component['draft']()).toBe('未发送的草稿');
    expect(component['editing']()).toBeUndefined();
  });

  it('sends ordinary files without text and preserves text for a separate message', async () => {
    component['updateDraft']('稍后发送的文字');
    const sending = component['sendMessage']({ messageType: MessageType.file, attachmentIds: [encodeId('101')] });
    const request = http.expectOne((req) => req.method === 'POST' && req.url.endsWith('/messages'));
    expect(request.request.body.messageType).toBe('file');
    expect(request.request.body.message).toBeUndefined();
    expect(request.request.body.attachmentIds).toEqual(['101']);
    request.flush({ ...wireMessage, id: '9007199254741010', messageType: 'file', message: null });
    await sending;
    expect(component['draft']()).toBe('稍后发送的文字');
  });
});
