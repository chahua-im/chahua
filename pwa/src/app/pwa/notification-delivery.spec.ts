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
  const commands: {
    type: string;
    suppress?: boolean;
    payload?: { title: string; body: string; data: object };
    readThrough?: string;
  }[] = [];
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
    vi.stubGlobal('navigator', {
      ...badges,
      serviceWorker: {
        getRegistration: async () => ({
          active: {
            postMessage: (data: (typeof commands)[number]) => {
              commands.push(data);
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
        {
          provide: PushService,
          useValue: { postSubscribe: () => of(undefined), postUnsubscribe: () => of(undefined) },
        },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: ModalController, useValue: modals },
        {
          provide: SwPush,
          useValue: {
            isEnabled: true,
            subscription: new BehaviorSubject({
              endpoint: 'mock-endpoint',
              toJSON: () => ({ keys: { p256dh: 'key', auth: 'auth' } }),
            }),
            unsubscribe: async () => {},
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

  it('sends foreground messages to the system notification worker once and shares the server badge total', async () => {
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(commands[0]).toMatchObject({
      type: 'CHAHUA_NOTIFY',
      suppress: false,
      payload: { title: testChat.name, body: `朋友: ${incoming.message}`, data: { messageId: decodeId(incoming.id) } },
    });
    expect(commands.filter((command) => command.type === 'CHAHUA_NOTIFY')).toHaveLength(1);
    expect(unread.activate).toHaveBeenCalledOnce();
    expect(badges.setAppBadge).toHaveBeenLastCalledWith(7);
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

  it('claims messages in the current visible conversation without a system notification', async () => {
    await router.navigateByUrl(chatPath);
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(commands[0]).toMatchObject({ type: 'CHAHUA_NOTIFY', suppress: true });
  });

  it('still requests a system notification when settings covers the conversation', async () => {
    await router.navigateByUrl(chatPath + '?settings=1');
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(commands[0]).toMatchObject({ type: 'CHAHUA_NOTIFY', suppress: false });
  });

  it.each([false, true])('uses system notifications and honors the device switch (hidden=%s)', async (hidden) => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(commands[0]).toMatchObject({ type: 'CHAHUA_NOTIFY', suppress: false });
    window.localStorage.setItem('chahua.notifications.enabled', 'false');
    events.next({ type: ServerWsMessageType.message, payload: { ...incoming, id: encodeId('9007199254741010') } });
    await settle();
    expect(commands.filter((command) => command.type === 'CHAHUA_NOTIFY')).toHaveLength(1);
  });

  it.each(['default', 'denied'] as const)(
    'does not request foreground notifications with %s permission',
    async (permission) => {
      vi.stubGlobal('Notification', { permission });
      await service.refresh();
      events.next({ type: ServerWsMessageType.message, payload: incoming });
      await settle();
      expect(commands.filter((command) => command.type === 'CHAHUA_NOTIFY')).toHaveLength(0);
    },
  );

  it('requests a system notification when a modal covers the current conversation', async () => {
    await router.navigateByUrl(chatPath);
    modals.getTop.mockResolvedValue({});
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(commands[0]).toMatchObject({ type: 'CHAHUA_NOTIFY', suppress: false });
  });

  it('requests a system notification for the current conversation while the page is hidden', async () => {
    await router.navigateByUrl(chatPath);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    expect(commands[0]).toMatchObject({ type: 'CHAHUA_NOTIFY', suppress: false });
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
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'CHAHUA_NOTIFY', suppress: false });
  });

  it('allows an active topic through parent mute, and reads close only the matching scope', async () => {
    state = { mutedUntil: '9999-12-31T23:59:59Z' };
    const topic = { ...incoming, replyRootId: encodeId('9007199254740999') };
    events.next({ type: ServerWsMessageType.message, payload: topic });
    await settle();
    expect(commands[0]).toMatchObject({
      type: 'CHAHUA_NOTIFY',
      suppress: false,
      payload: { data: { threadRootId: decodeId(topic.replyRootId) } },
    });
    reads.next({ chatId: topic.chatId, readThrough: topic.id });
    await settle();
    expect(commands.at(-1)).toMatchObject({
      type: 'CHAHUA_CLOSE',
      chatId: decodeId(topic.chatId),
      threadRootId: undefined,
      readThrough: decodeId(topic.id),
    });
    reads.next({ chatId: topic.chatId, threadId: topic.replyRootId, readThrough: topic.id });
    await settle();
    expect(commands.at(-1)).toMatchObject({
      type: 'CHAHUA_CLOSE',
      chatId: decodeId(topic.chatId),
      threadRootId: decodeId(topic.replyRootId),
      readThrough: decodeId(topic.id),
    });
  });

  it('recall closes its system notification', async () => {
    events.next({ type: ServerWsMessageType.message, payload: incoming });
    await settle();
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...incoming, isDeleted: true } });
    await settle();
    expect(commands.at(-1)).toEqual({ type: 'CHAHUA_CLOSE', messageIds: [decodeId(incoming.id)] });
  });

  it('opens a notification through the router, keeping the page and local outbox alive', async () => {
    const goTo = vi.spyOn(TestBed.inject(ConversationNavigation), 'goTo');
    clicks.next({ notification: { data: { chatId: decodeId(incoming.chatId), messageId: decodeId(incoming.id) } } });
    await settle();
    expect(router.url).toBe(chatPath + '?message=' + decodeId(incoming.id));
    expect(goTo).not.toHaveBeenCalled();
    // Repeated clicks still locate the message even when Angular ignores the identical URL.
    clicks.next({ notification: { data: { chatId: decodeId(incoming.chatId), messageId: decodeId(incoming.id) } } });
    await settle();
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
