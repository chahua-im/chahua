import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { ModalController } from '@ionic/angular';
import { BehaviorSubject, NEVER, of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { PushService } from '../../generated/endpoints/push/push.service';
import { ApiPushProvider } from '../../generated/models';
import { Connection } from '../api/connection';
import { testUser } from '../api/testing';
import { ChatListStore } from '../chats/chat-list-store';
import { ChatStore } from '../chats/chat-store';
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
    requestSubscription: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };
  let notification: { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };
  let api: {
    getVapidPublicKey: ReturnType<typeof vi.fn>;
    postSubscribe: ReturnType<typeof vi.fn>;
    postUnsubscribe: ReturnType<typeof vi.fn>;
    getSubscriptionStatus: ReturnType<typeof vi.fn>;
  };

  const dependencies = () => [
    provideRouter([]),
    { provide: Connection, useValue: { events$: new Subject(), resync$: new Subject() } },
    { provide: ChatStore, useValue: { changes$: new Subject() } },
    { provide: ChatListStore, useValue: {} },
    { provide: SessionStore, useValue: { user: signal(testUser) } },
    { provide: ModalController, useValue: { getTop: async () => undefined } },
  ];
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
    api = {
      getVapidPublicKey: vi.fn().mockReturnValue(of({ publicKey: 'vapid-key' })),
      postSubscribe: vi.fn().mockReturnValue(of(undefined)),
      postUnsubscribe: vi.fn().mockReturnValue(of(undefined)),
      getSubscriptionStatus: vi.fn().mockReturnValue(of({ hasActiveSubscription: true, hasMatchingEndpoint: true })),
    };
    TestBed.configureTestingModule({
      providers: [...dependencies(), { provide: SwPush, useValue: browser }, { provide: PushService, useValue: api }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['default', 'granted', 'denied'] as const)(
    'asks for the application choice when none is stored, even with %s permission',
    async (permission) => {
      notification.permission = permission;
      current.next(subscription);
      const service = TestBed.inject(PushNotifications);
      await service.refresh();
      expect(service.shouldPrompt()).toBe(true);
      expect(localStorage.getItem(preferenceKey)).toBeNull();
      expect(api.postSubscribe).not.toHaveBeenCalled();
      service.declinePermission();
      expect(service.shouldPrompt()).toBe(false);
      expect(localStorage.getItem(preferenceKey)).toBe('false');
      expect(notification.requestPermission).not.toHaveBeenCalled();
    },
  );

  it('leaves the initial permission click available while startup has no saved choice', async () => {
    notification.permission = 'default';
    browser.subscription = NEVER;
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(service.busy()).toBe(false);
    browser.subscription = current;
    const request = service.setEnabled(true);
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    expect(await request).toBe(true);
  });

  it('requests permission synchronously from the toggle, then registers VAPID and backend keys', async () => {
    notification.permission = 'default';
    const service = TestBed.inject(PushNotifications);
    const result = service.setEnabled(true);
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    expect(api.getVapidPublicKey).not.toHaveBeenCalled();
    expect(await result).toBe(true);
    expect(browser.requestSubscription).toHaveBeenCalledWith({ serverPublicKey: 'vapid-key' });
    expect(api.postSubscribe).toHaveBeenCalledWith(
      { provider: ApiPushProvider.webPush, endpoint, keys: { p256dh: 'public-key', auth: 'auth-key' } },
      { timeout: 10000 },
    );
    expect(service.permission()).toBe('granted');
    expect(service.enabled()).toBe(true);
    expect(service.busy()).toBe(false);
  });

  it('starts permission in the settings click and does not cancel it when the routed page refreshes', async () => {
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
    service.requestSettingsPermission();
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    await service.refresh();
    expect(localStorage.getItem(preferenceKey)).toBe('true');
    expect(browser.requestSubscription).not.toHaveBeenCalled();
    grant();
    await vi.waitFor(() => expect(service.busy()).toBe(false));
    expect(service.enabled()).toBe(true);
    expect(api.postSubscribe).toHaveBeenCalledOnce();
  });

  it.each(['default', 'denied'] as const)(
    'turns an enabled preference off without prompting on direct settings entry (%s)',
    async (permission) => {
      localStorage.setItem(preferenceKey, 'true');
      notification.permission = permission;
      current.next(subscription);
      const service = TestBed.inject(PushNotifications);
      const refresh = service.refresh();
      expect(service.enabled()).toBe(false);
      expect(service.busy()).toBe(false);
      expect(localStorage.getItem(preferenceKey)).toBe('false');
      await refresh;
      expect(notification.requestPermission).not.toHaveBeenCalled();
      expect(browser.requestSubscription).not.toHaveBeenCalled();
      expect(browser.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it('shows enabled immediately and repairs a missing subscription without a gesture', async () => {
    localStorage.setItem(preferenceKey, 'true');
    const pending = new Subject<void>();
    api.postSubscribe.mockReturnValue(pending);
    const service = TestBed.inject(PushNotifications);
    const refresh = service.refresh();
    expect(service.enabled()).toBe(true);
    expect(service.busy()).toBe(false);
    await vi.waitFor(() => expect(api.postSubscribe).toHaveBeenCalledOnce());
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.requestSubscription).toHaveBeenCalledOnce();
    pending.next();
    await refresh;
    expect(service.error()).toBeUndefined();
  });

  it('keeps a disabled choice off on settings clicks and cleans up its subscription', async () => {
    localStorage.setItem(preferenceKey, 'false');
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    service.requestSettingsPermission();
    await service.refresh();
    expect(service.enabled()).toBe(false);
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.requestSubscription).not.toHaveBeenCalled();
    expect(api.postUnsubscribe).toHaveBeenCalledWith(
      { provider: ApiPushProvider.webPush, endpoint },
      { timeout: 10000 },
    );
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
    expect(api.postSubscribe).not.toHaveBeenCalled();
  });

  it.each(['browser', 'worker'])('stops synchronously when the %s environment cannot support push', async (missing) => {
    if (missing === 'browser') vi.stubGlobal('navigator', {});
    else browser.isEnabled = false;
    const service = TestBed.inject(PushNotifications);
    expect(service.supported).toBe(false);
    expect(service.shouldPrompt()).toBe(false);
    service.requestSettingsPermission();
    await service.refresh();
    expect(service.error()).toBeUndefined();
    expect(await service.setEnabled(true)).toBe(false);
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.requestSubscription).not.toHaveBeenCalled();
    expect(api.postSubscribe).not.toHaveBeenCalled();
  });

  it('keeps a new browser endpoint and enabled choice when backend registration fails, then retries silently', async () => {
    api.postSubscribe.mockReturnValue(throwError(() => new Error('backend offline')));
    const service = TestBed.inject(PushNotifications);
    expect(await service.setEnabled(true)).toBe(false);
    expect(browser.unsubscribe).not.toHaveBeenCalled();
    expect(service.error()).toBe(PushNotificationError.BackendSubscribeFailed);
    expect(service.enabled()).toBe(true);
    api.postSubscribe.mockReturnValue(of(undefined));
    await service.refresh();
    expect(service.error()).toBeUndefined();
    expect(api.postSubscribe).toHaveBeenCalledTimes(2);
    expect(browser.requestSubscription).toHaveBeenCalledOnce();
  });

  it('repairs backend registration for this endpoint without fetching registration status', async () => {
    localStorage.setItem(preferenceKey, 'true');
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(api.getSubscriptionStatus).not.toHaveBeenCalled();
    expect(api.postSubscribe).toHaveBeenCalledOnce();
    expect(api.getVapidPublicKey).not.toHaveBeenCalled();
  });

  it('silently preserves the enabled choice on a background subscription failure with granted permission', async () => {
    localStorage.setItem(preferenceKey, 'true');
    browser.requestSubscription.mockRejectedValue(new DOMException('service unavailable', 'NotAllowedError'));
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(service.enabled()).toBe(true);
    expect(localStorage.getItem(preferenceKey)).toBe('true');
    expect(service.error()).toBeUndefined();
    expect(service.busy()).toBe(false);
    expect(browser.unsubscribe).not.toHaveBeenCalled();
  });

  it('keeps notifications off and removes the browser endpoint even when backend deletion fails', async () => {
    localStorage.setItem(preferenceKey, 'true');
    current.next(subscription);
    api.postUnsubscribe.mockReturnValue(throwError(() => new Error('offline')));
    const service = TestBed.inject(PushNotifications);
    const disabled = service.setEnabled(false);
    expect(service.enabled()).toBe(false);
    expect(await disabled).toBe(false);
    expect(service.error()).toBe(PushNotificationError.UnsubscribeFailed);
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.getItem(preferenceKey)).toBe('false');
  });

  it('leaves the preference off after backend deletion even if browser cleanup fails', async () => {
    current.next(subscription);
    browser.unsubscribe.mockRejectedValue(new Error('browser failure'));
    const service = TestBed.inject(PushNotifications);
    expect(await service.setEnabled(false)).toBe(false);
    expect(service.enabled()).toBe(false);
    expect(service.error()).toBe(PushNotificationError.UnsubscribeFailed);
    browser.unsubscribe.mockImplementation(async () => current.next(null));
    await service.refresh();
    expect(browser.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'honors switching off during a pending background registration (success=%s)',
    async (success) => {
      localStorage.setItem(preferenceKey, 'true');
      const pending = new Subject<void>();
      api.postSubscribe.mockReturnValue(pending);
      const service = TestBed.inject(PushNotifications);
      const refresh = service.refresh();
      await vi.waitFor(() => expect(api.postSubscribe).toHaveBeenCalledOnce());
      const disabled = service.setEnabled(false);
      expect(service.enabled()).toBe(false);
      expect(api.postUnsubscribe).not.toHaveBeenCalled();
      if (success) pending.next();
      else pending.error(new Error('offline'));
      await refresh;
      expect(await disabled).toBe(true);
      expect(service.enabled()).toBe(false);
      expect(localStorage.getItem(preferenceKey)).toBe('false');
      expect(api.postUnsubscribe).toHaveBeenCalledOnce();
      expect(browser.unsubscribe).toHaveBeenCalledOnce();
      expect(service.error()).toBeUndefined();
    },
  );

  it('allows a permission click during background cleanup and registers only after cleanup finishes', async () => {
    localStorage.setItem(preferenceKey, 'false');
    notification.permission = 'default';
    current.next(subscription);
    const pending = new Subject<void>();
    api.postUnsubscribe.mockReturnValue(pending);
    const service = TestBed.inject(PushNotifications);
    const refresh = service.refresh();
    await vi.waitFor(() => expect(api.postUnsubscribe).toHaveBeenCalledOnce());
    const enabled = service.setEnabled(true);
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    expect(api.postSubscribe).not.toHaveBeenCalled();
    pending.next();
    await refresh;
    expect(await enabled).toBe(true);
    expect(service.enabled()).toBe(true);
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(api.postSubscribe).toHaveBeenCalledOnce();
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
