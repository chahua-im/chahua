import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import { BehaviorSubject, NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { PushService } from '../../generated/endpoints/push/push.service';
import { ApiPushProvider } from '../../generated/models';
import { PushNotificationError, PushNotifications } from './push-notifications';

describe('PushNotifications', () => {
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

  beforeEach(() => {
    notification = { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') };
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
      providers: [
        { provide: SwPush, useValue: browser },
        { provide: PushService, useValue: api },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    expect(service.subscribed()).toBe(true);
    expect(service.busy()).toBe(false);
  });

  it('does not request permission or subscribe while reading settings', async () => {
    notification.permission = 'default';
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(service.subscribed()).toBe(false);
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.requestSubscription).not.toHaveBeenCalled();
  });

  it('does not retry denied browser permissions or write to the backend', async () => {
    notification.permission = 'denied';
    const service = TestBed.inject(PushNotifications);
    expect(await service.setEnabled(true)).toBe(false);
    expect(service.error()).toBe(PushNotificationError.PermissionDenied);
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(api.postSubscribe).not.toHaveBeenCalled();
  });

  it('reports unsupported browsers separately from disabled development workers', async () => {
    vi.stubGlobal('navigator', {});
    let service = TestBed.inject(PushNotifications);
    expect(await service.setEnabled(true)).toBe(false);
    expect(service.error()).toBe(PushNotificationError.UnsupportedBrowser);
    TestBed.resetTestingModule();
    vi.stubGlobal('navigator', { serviceWorker: {} });
    browser.isEnabled = false;
    TestBed.configureTestingModule({
      providers: [
        { provide: SwPush, useValue: browser },
        { provide: PushService, useValue: api },
      ],
    });
    service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(service.error()).toBe(PushNotificationError.ServiceWorkerUnavailable);
  });

  it('rolls back a newly created endpoint if backend registration fails', async () => {
    api.postSubscribe.mockReturnValue(throwError(() => new Error('backend offline')));
    const service = TestBed.inject(PushNotifications);
    expect(await service.setEnabled(true)).toBe(false);
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(service.error()).toBe(PushNotificationError.BackendSubscribeFailed);
    expect(service.subscribed()).toBe(false);
  });

  it('preserves an existing browser endpoint when backend registration fails', async () => {
    current.next(subscription);
    api.postSubscribe.mockReturnValue(throwError(() => new Error('backend offline')));
    const service = TestBed.inject(PushNotifications);
    expect(await service.setEnabled(true)).toBe(false);
    expect(browser.unsubscribe).not.toHaveBeenCalled();
    expect(api.getVapidPublicKey).not.toHaveBeenCalled();
  });

  it('checks this endpoint rather than treating another device subscription as enabled', async () => {
    current.next(subscription);
    api.getSubscriptionStatus.mockReturnValue(of({ hasActiveSubscription: true, hasMatchingEndpoint: false }));
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(service.subscribed()).toBe(false);
    expect(api.getSubscriptionStatus).toHaveBeenCalledWith({ endpoint }, { timeout: 10000 });
    expect(api.postSubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes the authenticated endpoint and removes the browser subscription', async () => {
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    expect(service.subscribed()).toBe(true);
    expect(await service.setEnabled(false)).toBe(true);
    expect(api.postUnsubscribe).toHaveBeenCalledWith(
      { provider: ApiPushProvider.webPush, endpoint },
      { timeout: 10000 },
    );
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(service.subscribed()).toBe(false);
  });

  it('keeps an enabled subscription when backend unsubscribe fails so the user can retry', async () => {
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    api.postUnsubscribe.mockReturnValue(throwError(() => new Error('offline')));
    expect(await service.setEnabled(false)).toBe(false);
    expect(service.subscribed()).toBe(true);
    expect(service.error()).toBe(PushNotificationError.UnsubscribeFailed);
    expect(browser.unsubscribe).not.toHaveBeenCalled();
  });

  it('reflects stopped delivery after backend deletion even if browser cleanup fails', async () => {
    current.next(subscription);
    const service = TestBed.inject(PushNotifications);
    await service.refresh();
    browser.unsubscribe.mockRejectedValue(new Error('browser failure'));
    expect(await service.setEnabled(false)).toBe(false);
    expect(service.subscribed()).toBe(false);
    expect(service.error()).toBe(PushNotificationError.UnsubscribeFailed);
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
  });
});
