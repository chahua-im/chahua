import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { ModalController } from '@ionic/angular';
import { BehaviorSubject, NEVER, Subject } from 'rxjs';
import { type Mock, vi } from 'vitest';
import { ApiPushProvider, GroupKind } from '../../generated/models';
import { RpcTestPeer, type RpcTestRequest, provideRpcTesting } from '../api/rpc-testing';
import { RpcErrorCode } from '../api/rpc-error';
import { Connection } from '../api/connection';
import { encodeId } from '../api/snowflake-id';
import { testChat, testMessage, testUser } from '../api/testing';
import { ChatListStore } from '../chats/chat-list-store';
import { ChatStore } from '../chats/chat-store';
import { PanelNavigation } from '../navigation/panel-navigation';
import { SessionStore } from '../session/session-store';
import { PushNotificationError, PushNotifications } from './push-notifications';

describe('PushNotifications', () => {
  const preferenceKey = 'chahua.notifications.enabled';
  const endpoint = 'https://push.example/device';
  const subscription = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'public-key', auth: 'auth-key' } }),
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey: () => null,
    unsubscribe: async () => true,
  } satisfies PushSubscription;
  let current: BehaviorSubject<PushSubscription | null>;
  let browser: {
    isEnabled: boolean;
    subscription: BehaviorSubject<PushSubscription | null> | typeof NEVER;
    requestSubscription: Mock<(options: { serverPublicKey: string }) => Promise<PushSubscription>>;
    unsubscribe: Mock<() => Promise<void>>;
  };
  let notification: {
    permission: NotificationPermission;
    requestPermission: Mock<() => Promise<NotificationPermission>>;
  };
  let peer: RpcTestPeer;
  let sessionUser: WritableSignal<typeof testUser>;

  const dependencies = () => [
    provideRouter([]),
    provideRpcTesting(),
    { provide: Connection, useValue: { events$: new Subject(), resync$: new Subject() } },
    { provide: ChatStore, useValue: { changes$: new Subject() } },
    { provide: ChatListStore, useValue: {} },
    { provide: SessionStore, useValue: { user: sessionUser } },
    { provide: ModalController, useValue: { getTop: async () => undefined } },
  ];

  function request(method: string, params?: Record<string, unknown>): Promise<RpcTestRequest> {
    return peer.expectAsync(method, params);
  }

  async function vapid() {
    (await request('push.getVapidPublicKey', {})).flush({ publicKey: 'vapid-key' });
  }

  async function subscribe(value: PushSubscription = subscription) {
    const keys = value.toJSON().keys!;
    return request('push.subscribe', {
      provider: ApiPushProvider.webPush,
      endpoint: value.endpoint,
      keys: { p256dh: keys['p256dh'], auth: keys['auth'] },
    });
  }

  async function unsubscribe(value: PushSubscription = subscription) {
    return request('push.unsubscribe', { provider: ApiPushProvider.webPush, endpoint: value.endpoint });
  }

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    notification = {
      permission: 'granted',
      requestPermission: vi.fn().mockImplementation(async () => (notification.permission = 'granted')),
    };
    vi.stubGlobal('Notification', notification);
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('navigator', { serviceWorker: {} });
    current = new BehaviorSubject<PushSubscription | null>(null);
    sessionUser = signal(testUser);
    browser = {
      isEnabled: true,
      subscription: current,
      requestSubscription: vi.fn().mockImplementation(async () => {
        current.next(subscription);
        return subscription;
      }),
      unsubscribe: vi.fn().mockImplementation(async () => {
        current.next(null);
      }),
    };
    TestBed.configureTestingModule({
      providers: [...dependencies(), { provide: SwPush, useValue: browser }],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('does not treat a covered conversation as being read, but permits a non-blocking sidebar', async () => {
    const router = TestBed.inject(Router);
    router.resetConfig([{ path: 'chats/chat/:id', children: [] }]);
    await router.navigateByUrl('/chats/chat/9007199254740993');
    const service = TestBed.inject(PushNotifications);
    const panels = TestBed.inject(PanelNavigation);
    expect(service['currentConversation'](testMessage)).toBe(true);
    await router.navigateByUrl('/chats/chat/9007199254740993?panel=%2Fsettings');
    expect(service['currentConversation'](testMessage)).toBe(false);
    panels.largeScreen.set(true);
    await router.navigateByUrl('/chats/chat/9007199254740993?panel=%2Fchats%2Fchat%2F9007199254740993%2Finfo');
    expect(service['currentConversation'](testMessage)).toBe(true);
  });

  it('loads a thread subscription only when the notification decision depends on it', async () => {
    localStorage.setItem(preferenceKey, 'true');
    const chats = TestBed.inject(ChatStore);
    const load = vi.fn().mockResolvedValue(undefined);
    Object.assign(chats, {
      ensureDetails: vi.fn().mockResolvedValue(undefined),
      get: () => ({ kind: GroupKind.group }),
      chatState: () => ({ archived: false }),
      subscription: () => ({ subscribed: true, archived: false }),
      loadSubscription: load,
    });
    const service = TestBed.inject(PushNotifications);
    const topic = { ...testMessage, sender: { ...testMessage.sender, uid: 2 }, replyRootId: encodeId('100') };
    await service['notify']({ ...topic, mentions: [{ uid: testUser.uid, gender: 0 }] });
    expect(load).not.toHaveBeenCalled();
    await service['notify']({ ...topic, id: encodeId('202'), replyToMessage: { ...testMessage, mentions: [] } });
    expect(load).not.toHaveBeenCalled();
    await service['notify']({ ...topic, id: encodeId('203') });
    expect(load).toHaveBeenCalledExactlyOnceWith(testChat.id, topic.replyRootId);
  });

  it.each(['default', 'denied'] as const)(
    'asks for the application choice when none is stored and permission is %s',
    async (permission) => {
      notification.permission = permission;
      current.next(subscription);
      const service = TestBed.inject(PushNotifications);
      await service.refresh();
      expect(service.shouldPrompt()).toBe(true);
      expect(localStorage.getItem(preferenceKey)).toBeNull();
      peer.expectNone('push.subscribe');
      service.declinePermission();
      expect(service.shouldPrompt()).toBe(false);
      expect(localStorage.getItem(preferenceKey)).toBe('false');
      expect(notification.requestPermission).not.toHaveBeenCalled();
      (await unsubscribe()).flush(null);
    },
  );

  it('inherits granted permission and registers push without prompting again', async () => {
    const service = TestBed.inject(PushNotifications);
    expect(service.shouldPrompt()).toBe(false);
    expect(service.enabled()).toBe(true);
    expect(localStorage.getItem(preferenceKey)).toBe('true');
    const refreshed = service.refresh();
    await vapid();
    (await subscribe()).flush(null);
    await refreshed;
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });

  it('preserves an explicit off choice even when the browser already granted permission', async () => {
    localStorage.setItem(preferenceKey, 'false');
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(service.enabled()).toBe(false);
    expect(service.shouldPrompt()).toBe(false);
    peer.expectNone('push.subscribe');
  });

  it('leaves the initial permission click available while startup has no saved choice', async () => {
    notification.permission = 'default';
    browser.subscription = NEVER;
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(service.busy()).toBe(false);
    browser.subscription = current;
    const requestEnabled = service.setEnabled(true);
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    await vapid();
    (await subscribe()).flush(null);
    expect(await requestEnabled).toBe(true);
  });

  it('requests permission synchronously from the toggle, then registers VAPID and backend keys', async () => {
    notification.permission = 'default';
    const service = TestBed.inject(PushNotifications);
    const result = service.setEnabled(true);
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    await vapid();
    (await subscribe()).flush(null);
    expect(await result).toBe(true);
    expect(browser.requestSubscription).toHaveBeenCalledWith({ serverPublicKey: 'vapid-key' });
    expect(service.permission()).toBe('granted');
    expect(service.enabled()).toBe(true);
    expect(service.busy()).toBe(false);
  });

  it('starts permission in the authorization click and does not cancel it when the routed page refreshes', async () => {
    localStorage.setItem(preferenceKey, 'true');
    notification.permission = 'default';
    let grant!: () => void;
    notification.requestPermission.mockImplementation(
      () =>
        new Promise<NotificationPermission>((resolve) => {
          grant = () => resolve((notification.permission = 'granted'));
        }),
    );
    const service = TestBed.inject(PushNotifications);
    void service.setEnabled(true);
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    await service.refresh();
    expect(localStorage.getItem(preferenceKey)).toBe('true');
    expect(browser.requestSubscription).not.toHaveBeenCalled();
    grant();
    await vapid();
    (await subscribe()).flush(null);
    await vi.waitFor(() => expect(service.busy()).toBe(false));
    expect(service.enabled()).toBe(true);
  });

  it.each(['default', 'denied'] as const)(
    'turns an enabled preference off without prompting on direct settings entry (%s)',
    async (permission) => {
      localStorage.setItem(preferenceKey, 'true');
      notification.permission = permission;
      current.next(subscription);
      const service = TestBed.inject(PushNotifications);
      const refreshed = service.refresh();
      expect(service.enabled()).toBe(false);
      expect(service.busy()).toBe(false);
      expect(localStorage.getItem(preferenceKey)).toBe('false');
      (await unsubscribe()).flush(null);
      await refreshed;
      expect(notification.requestPermission).not.toHaveBeenCalled();
      expect(browser.requestSubscription).not.toHaveBeenCalled();
      expect(browser.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it('shows enabled immediately and repairs a missing subscription without a gesture', async () => {
    localStorage.setItem(preferenceKey, 'true');
    const service = TestBed.inject(PushNotifications);
    const refreshed = service.refresh();
    expect(service.enabled()).toBe(true);
    expect(service.busy()).toBe(false);
    await vapid();
    const registration = await subscribe();
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.requestSubscription).toHaveBeenCalledOnce();
    registration.flush(null);
    await refreshed;
    expect(service.error()).toBeUndefined();
  });

  it('keeps a disabled choice off on settings visits and cleans up its subscription', async () => {
    localStorage.setItem(preferenceKey, 'false');
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    const refreshed = service.refresh();
    (await unsubscribe()).flush(null);
    await refreshed;
    expect(service.enabled()).toBe(false);
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.requestSubscription).not.toHaveBeenCalled();
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
  });

  it('stores a denied permission result as off', async () => {
    localStorage.setItem(preferenceKey, 'true');
    notification.permission = 'default';
    notification.requestPermission.mockImplementation(async () => (notification.permission = 'denied'));
    const service = TestBed.inject(PushNotifications);
    expect(await service.setEnabled(true)).toBe(false);
    expect(service.enabled()).toBe(false);
    expect(localStorage.getItem(preferenceKey)).toBe('false');
    expect(service.error()).toBe(PushNotificationError.PermissionDenied);
    peer.expectNone('push.subscribe');
  });

  it.each(['browser', 'worker'])('stops synchronously when the %s environment cannot support push', async (missing) => {
    if (missing === 'browser') vi.stubGlobal('navigator', {});
    else browser.isEnabled = false;
    const service = TestBed.inject(PushNotifications);
    expect(service.supported).toBe(false);
    expect(service.shouldPrompt()).toBe(false);
    await service.refresh();
    expect(service.error()).toBeUndefined();
    expect(await service.setEnabled(true)).toBe(false);
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.requestSubscription).not.toHaveBeenCalled();
    peer.expectNone('push.subscribe');
  });

  it('keeps a new browser endpoint and enabled choice when backend registration fails, then retries silently', async () => {
    const service = TestBed.inject(PushNotifications);
    const first = service.setEnabled(true);
    await vapid();
    (await subscribe()).error(RpcErrorCode.Unavailable, 'temporarily unavailable');
    expect(await first).toBe(false);
    expect(browser.unsubscribe).not.toHaveBeenCalled();
    expect(service.error()).toBe(PushNotificationError.BackendSubscribeFailed);
    expect(service.enabled()).toBe(true);
    const retry = service.refresh();
    (await subscribe()).flush(null);
    await retry;
    expect(service.error()).toBeUndefined();
    expect(browser.requestSubscription).toHaveBeenCalledOnce();
  });

  it('coalesces registration and reuses success until the subscription or account changes', async () => {
    const service = TestBed.inject(PushNotifications);
    const refreshes = [service.refresh(), service.refresh(), service.refresh()];
    await vapid();
    (await subscribe()).flush(null);
    await Promise.all(refreshes);
    await service.refresh();
    sessionUser.set({ ...testUser, uid: 2 });
    const accountRefresh = service.refresh();
    (await subscribe()).flush(null);
    await accountRefresh;
    const rotated = { ...subscription, endpoint: 'https://push.example/rotated' };
    current.next(rotated);
    const endpointRefresh = service.refresh();
    (await subscribe(rotated)).flush(null);
    await endpointRefresh;
  });

  it('periodically repairs an unchanged registration without checking every resume', async () => {
    const service = TestBed.inject(PushNotifications);
    const first = service.refresh();
    await vapid();
    (await subscribe()).flush(null);
    await first;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
    const refreshed = service.refresh();
    (await subscribe()).flush(null);
    await refreshed;
    vi.restoreAllMocks();
  });

  it('repairs backend registration for this endpoint without fetching registration status', async () => {
    localStorage.setItem(preferenceKey, 'true');
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    const refreshed = service.refresh();
    (await subscribe()).flush(null);
    await refreshed;
    peer.expectNone('push.getSubscriptionStatus');
    peer.expectNone('push.getVapidPublicKey');
  });

  it('silently preserves the enabled choice on a background subscription failure with granted permission', async () => {
    localStorage.setItem(preferenceKey, 'true');
    browser.requestSubscription.mockRejectedValue(new DOMException('service unavailable', 'NotAllowedError'));
    const service = TestBed.inject(PushNotifications);
    const refreshed = service.refresh();
    await vapid();
    await refreshed;
    expect(service.enabled()).toBe(true);
    expect(localStorage.getItem(preferenceKey)).toBe('true');
    expect(service.error()).toBeUndefined();
    expect(service.busy()).toBe(false);
    expect(browser.unsubscribe).not.toHaveBeenCalled();
  });

  it('keeps notifications off and removes the browser endpoint even when backend deletion fails', async () => {
    localStorage.setItem(preferenceKey, 'true');
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    const disabled = service.setEnabled(false);
    expect(service.enabled()).toBe(false);
    (await unsubscribe()).error(RpcErrorCode.Unavailable, 'temporarily unavailable');
    expect(await disabled).toBe(false);
    expect(service.error()).toBe(PushNotificationError.UnsubscribeFailed);
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.getItem(preferenceKey)).toBe('false');
  });

  it('leaves the preference off after backend deletion even if browser cleanup fails', async () => {
    current.next(subscription);
    browser.unsubscribe.mockRejectedValue(new Error('browser failure'));
    const service = TestBed.inject(PushNotifications);
    const disabled = service.setEnabled(false);
    (await unsubscribe()).flush(null);
    expect(await disabled).toBe(false);
    expect(service.enabled()).toBe(false);
    expect(service.error()).toBe(PushNotificationError.UnsubscribeFailed);
    browser.unsubscribe.mockImplementation(async () => current.next(null));
    const refreshed = service.refresh();
    (await unsubscribe()).flush(null);
    await refreshed;
    expect(browser.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'honors switching off during a pending background registration (success=%s)',
    async (success) => {
      localStorage.setItem(preferenceKey, 'true');
      const service = TestBed.inject(PushNotifications);
      const refreshed = service.refresh();
      await vapid();
      const registration = await subscribe();
      const disabled = service.setEnabled(false);
      expect(service.enabled()).toBe(false);
      peer.expectNone('push.unsubscribe');
      if (success) registration.flush(null);
      else registration.error(RpcErrorCode.Unavailable, 'temporarily unavailable');
      await refreshed;
      (await unsubscribe()).flush(null);
      expect(await disabled).toBe(true);
      expect(service.enabled()).toBe(false);
      expect(localStorage.getItem(preferenceKey)).toBe('false');
      expect(browser.unsubscribe).toHaveBeenCalledOnce();
      expect(service.error()).toBeUndefined();
    },
  );

  it('allows a permission click during background cleanup and registers only after cleanup finishes', async () => {
    localStorage.setItem(preferenceKey, 'false');
    notification.permission = 'default';
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    const refreshed = service.refresh();
    const cleanup = await unsubscribe();
    const enabled = service.setEnabled(true);
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    peer.expectNone('push.subscribe');
    cleanup.flush(null);
    await refreshed;
    await vapid();
    (await subscribe()).flush(null);
    expect(await enabled).toBe(true);
    expect(service.enabled()).toBe(true);
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
  });

  it('releases loading state when a worker registration never becomes available', async () => {
    vi.useFakeTimers();
    browser.subscription = NEVER;
    const service = TestBed.inject(PushNotifications);
    const result = service.setEnabled(true);
    expect(service.busy()).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toBe(false);
    expect(service.error()).toBe(PushNotificationError.ServiceWorkerUnavailable);
    expect(service.busy()).toBe(false);
    expect(service.enabled()).toBe(true);
  });
});
