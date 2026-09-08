import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { ModalController } from '@ionic/angular';
import { BehaviorSubject, of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { PushService } from '../../generated/endpoints/push/push.service';
import {
  MessageType,
  ServerWsMessageType,
  type ServerWsMessage,
  type ThreadSubscriptionStatusResponse,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { decodeId, encodeId, type SnowflakeID } from '../api/snowflake-id';
import { testChat, testMessage, testUser } from '../api/testing';
import { ChatListStore } from '../chats/chat-list-store';
import { ChatStore } from '../chats/chat-store';
import { ConversationNavigation } from '../conversations/conversation-navigation';
import { SessionStore } from '../session/session-store';
import { PushNotifications } from './push-notifications';

@Component({ template: '' })
class EmptyPage {}

const incoming = { ...testMessage, sender: { uid: 2, name: '朋友', gender: 0 } };
const chatPath = '/chats/chat/' + decodeId(testChat.id);

describe('online notifications', () => {
  let service: PushNotifications;
  let router: Router;
  let events: Subject<ServerWsMessage>;
  let reads: Subject<{ chatId: SnowflakeID; threadId?: SnowflakeID; readThrough?: SnowflakeID }>;
  let clicks: Subject<{ notification: { data: object } }>;
  let state: { archived?: boolean; mutedUntil?: string };
  let subscription: ThreadSubscriptionStatusResponse;
  const commands: { type: string; foreground?: boolean; payload?: { data: object }; readThrough?: string }[] = [];
  const total = signal<{ unreadCount: number; archivedUnreadCount: number } | undefined>(undefined);
  const release = vi.fn();
  const unread = { value: total, activate: vi.fn(() => release) };
  const badges = { setAppBadge: vi.fn(), clearAppBadge: vi.fn() };
  const modals = { getTop: vi.fn(), dismiss: vi.fn() };
  const settle = () => vi.advanceTimersByTimeAsync(200);

  beforeEach(async () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    window.localStorage.setItem('chahua.notifications.enabled', 'true');
    commands.length = 0;
    state = { archived: false };
    subscription = { subscribed: true, archived: false };
    events = new Subject();
    reads = new Subject();
    clicks = new Subject();
    total.set({ unreadCount: 7, archivedUnreadCount: 900 });
    unread.activate.mockClear();
    release.mockClear();
    badges.setAppBadge.mockReset().mockResolvedValue(undefined);
    badges.clearAppBadge.mockReset().mockResolvedValue(undefined);
    modals.getTop.mockReset().mockResolvedValue(undefined);
    modals.dismiss.mockReset().mockResolvedValue(true);
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = { onmessage: null as ((event: { data: boolean }) => void) | null, close() {} };
        port2 = { postMessage: (data: boolean) => Promise.resolve().then(() => this.port1.onmessage?.({ data })) };
      },
    );
    vi.stubGlobal('navigator', {
      ...badges,
      serviceWorker: {
        getRegistration: async () => ({
          active: {
            postMessage: (data: (typeof commands)[number], ports: MessagePort[]) => {
              commands.push(data);
              ports[0].postMessage(true);
            },
          },
        }),
      },
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'chats', component: EmptyPage },
          { path: 'chats/chat/:id', component: EmptyPage },
          { path: 'chats/chat/:id/thread/:threadId', component: EmptyPage },
        ]),
        { provide: Connection, useValue: { events$: events, resync$: new Subject() } },
        {
          provide: ChatStore,
          useValue: {
            get: () => testChat,
            chatState: () => state,
            changes$: reads,
            ensureDetails: async () => {},
            loadSubscription: async () => {},
            subscription: () => subscription,
          },
        },
        { provide: ChatListStore, useValue: { unread } },
        { provide: PushService, useValue: { getSubscriptionStatus: () => of({ hasMatchingEndpoint: true }) } },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: ModalController, useValue: modals },
        {
          provide: SwPush,
          useValue: {
            isEnabled: true,
            subscription: new BehaviorSubject({ endpoint: 'mock-endpoint' }),
            notificationClicks: clicks,
          },
        },
      ],
    });
    service = TestBed.inject(PushNotifications);
    router = TestBed.inject(Router);
    await router.navigateByUrl('/chats');
    service.start();
    await settle();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows other conversations once, shares the server badge total, and expires the banner', async () => {
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(service.banner()).toBe(incoming);
    expect(commands.filter((command) => command.type === 'CHAHUA_NOTIFY')).toHaveLength(1);
    expect(commands[0].foreground).toBe(true);
    expect(unread.activate).toHaveBeenCalledOnce();
    expect(badges.setAppBadge).toHaveBeenLastCalledWith(7);
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.banner()).toBeUndefined();
  });

  it('does not activate badge counts when the browser cannot display them', async () => {
    // Create a fresh service so startup sees the unsupported browser.
    TestBed.resetTestingModule();
    expect(release).toHaveBeenCalledOnce();
    vi.stubGlobal('navigator', { serviceWorker: navigator.serviceWorker });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Connection, useValue: { events$: events, resync$: new Subject() } },
        { provide: ChatStore, useValue: { changes$: reads } },
        { provide: ChatListStore, useValue: { unread } },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: ModalController, useValue: modals },
        { provide: SwPush, useValue: { isEnabled: false, notificationClicks: clicks } },
        { provide: PushService, useValue: {} },
      ],
    });
    unread.activate.mockClear();
    TestBed.inject(PushNotifications).start();
    await settle();
    expect(unread.activate).not.toHaveBeenCalled();
  });

  it('updates and clears the app badge from the shared count snapshot', async () => {
    total.set({ unreadCount: 3, archivedUnreadCount: 900 });
    TestBed.tick();
    expect(badges.setAppBadge).toHaveBeenLastCalledWith(3);
    total.set({ unreadCount: 0, archivedUnreadCount: 900 });
    TestBed.tick();
    expect(badges.clearAppBadge).toHaveBeenCalledOnce();
  });

  it('claims messages in the current visible conversation without a banner', async () => {
    await router.navigateByUrl(chatPath);
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(service.banner()).toBeUndefined();
    expect(commands[0].foreground).toBe(true);
  });

  it('still shows a banner when settings covers the conversation', async () => {
    await router.navigateByUrl(chatPath + '?settings=1');
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(service.banner()).toBe(incoming);
  });

  it('uses local system notifications while the page is hidden and honors the device switch', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(commands[0].foreground).toBe(false);
    expect(service.banner()).toBeUndefined();
    window.localStorage.setItem('chahua.notifications.enabled', 'false');
    events.next({ type: ServerWsMessageType.message, payload: { ...incoming, id: encodeId('9007199254741010') } });
    await settle();
    expect(commands.filter((command) => command.type === 'CHAHUA_NOTIFY')).toHaveLength(1);
  });

  it('filters muted messages, outgoing messages and system events, while allowing mentions', async () => {
    state = { mutedUntil: '9999-12-31T23:59:59Z' };
    for (const message of [incoming, testMessage, { ...incoming, messageType: MessageType.system }])
      events.next({ type: ServerWsMessageType.message, payload: message });
    await settle();
    expect(commands).toHaveLength(0);
    events.next({
      type: ServerWsMessageType.message,
      payload: { ...incoming, mentions: [{ uid: 1, username: '我', gender: 0 }] },
    });
    await settle();
    expect(service.banner()?.mentions?.[0].uid).toBe(1);
  });

  it('allows an active topic through parent mute, and reads close only the matching scope', async () => {
    state = { mutedUntil: '9999-12-31T23:59:59Z' };
    const topic = { ...incoming, replyRootId: encodeId('9007199254740999') };
    events.next({ type: ServerWsMessageType.message, payload: topic });
    await settle();
    expect(service.banner()).toBe(topic);
    reads.next({ chatId: topic.chatId, readThrough: topic.id });
    expect(service.banner()).toBe(topic);
    reads.next({ chatId: topic.chatId, threadId: topic.replyRootId, readThrough: topic.id });
    await settle();
    expect(service.banner()).toBeUndefined();
    expect(commands.at(-1)?.readThrough).toBe(decodeId(topic.id));
  });

  it('recall clears a banner and closes its system notification', async () => {
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...incoming, isDeleted: true } });
    await settle();
    expect(service.banner()).toBeUndefined();
    expect(commands.at(-1)?.type).toBe('CHAHUA_CLOSE');
  });

  it('opens a notification through the router, keeping the page and local outbox alive', async () => {
    const goTo = vi.spyOn(TestBed.inject(ConversationNavigation), 'goTo');
    clicks.next({ notification: { data: { chatId: decodeId(incoming.chatId), messageId: decodeId(incoming.id) } } });
    await settle();
    expect(router.url).toBe(chatPath + '?message=' + decodeId(incoming.id));
    expect(goTo).toHaveBeenCalledOnce();
  });
  it('shows the shared unread total only while the browser tab is hidden', () => {
    const title = document.title;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    TestBed.tick();
    expect(document.title).toBe(`(7) ${title}`.trim());
    total.set({ unreadCount: 4, archivedUnreadCount: 900 });
    TestBed.tick();
    expect(document.title).toBe(`(4) ${title}`.trim());
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    TestBed.tick();
    expect(document.title).toBe(title);
    hidden.mockRestore();
  });
});
