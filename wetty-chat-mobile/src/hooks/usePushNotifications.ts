import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import apiClient from '@/api/client';
import { base64UrlToUint8Array, toBase64Url } from '@/utils/base64url';

export type PushNotificationErrorCode =
  | 'unsupported_browser'
  | 'permission_denied'
  | 'service_worker_unavailable'
  | 'subscribe_failed'
  | 'unsubscribe_failed'
  | 'backend_subscribe_failed';

export type PushNotificationResult = { ok: true } | { ok: false; code: PushNotificationErrorCode; message: string };

export function getPushNotificationErrorMessage(code: PushNotificationErrorCode) {
  switch (code) {
    case 'unsupported_browser':
      return t`Push notifications are not supported on this device`;
    case 'permission_denied':
      return t`Notification permission was not granted`;
    case 'service_worker_unavailable':
      return t`Push notifications are not available right now`;
    case 'backend_subscribe_failed':
      return t`Push notifications could not be enabled on the server`;
    case 'unsubscribe_failed':
      return t`Failed to turn off push notifications`;
    case 'subscribe_failed':
    default:
      return t`Failed to turn on push notifications`;
  }
}

function success(): PushNotificationResult {
  return { ok: true };
}

function failure(code: PushNotificationErrorCode, message: string): PushNotificationResult {
  return { ok: false, code, message };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error) {
    return error;
  }

  return fallback;
}

function checkPushSupport(): PushNotificationResult {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return failure('unsupported_browser', 'Push notifications are not supported in this browser');
  }

  return success();
}

function encodeSubscriptionKeys(subscription: PushSubscription) {
  return {
    p256dh: toBase64Url(new Uint8Array(subscription.getKey('p256dh')!)),
    auth: toBase64Url(new Uint8Array(subscription.getKey('auth')!)),
  };
}

async function registerSubscriptionWithBackend(subscription: PushSubscription) {
  const keys = encodeSubscriptionKeys(subscription);
  await apiClient.post('/push/subscribe', {
    endpoint: subscription.endpoint,
    keys,
  });
}

async function fetchPushRegistration() {
  return navigator.serviceWorker.ready;
}

async function ensurePushSubscription(registration: ServiceWorkerRegistration) {
  const existingSubscription = await registration.pushManager.getSubscription();
  if (existingSubscription) {
    await registerSubscriptionWithBackend(existingSubscription);
    return existingSubscription;
  }

  const vapidRes = await apiClient.get('/push/vapid-public-key');
  const publicKey = base64UrlToUint8Array(vapidRes.data.publicKey);
  const newSubscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });

  try {
    await registerSubscriptionWithBackend(newSubscription);
    return newSubscription;
  } catch (error) {
    await newSubscription.unsubscribe().catch((unsubscribeError) => {
      console.warn('Failed to roll back push subscription after backend sync error', unsubscribeError);
    });
    throw error;
  }
}

async function hasBackendSubscription(endpoint?: string): Promise<boolean> {
  const response = await apiClient.get<PushSubscriptionStatusResponse>('/push/subscription-status', {
    params: endpoint ? { endpoint } : undefined,
  });

  if (typeof response.data?.hasMatchingEndpoint === 'boolean') {
    return response.data.hasMatchingEndpoint;
  }

  return Boolean(response.data?.hasActiveSubscription);
}

function getCurrentPermission(): NotificationPermission {
  if ('Notification' in window) {
    return Notification.permission;
  }

  return 'default';
}

type ReconcilePushSubscriptionResult = {
  permission: NotificationPermission;
  isSubscribed: boolean;
};

type PushSubscriptionStatusResponse = {
  hasActiveSubscription?: boolean;
  hasMatchingEndpoint?: boolean | null;
};

async function reconcilePushSubscription({
  repairIfMissing,
}: {
  repairIfMissing: boolean;
}): Promise<ReconcilePushSubscriptionResult> {
  const permission = getCurrentPermission();
  const supportResult = checkPushSupport();

  if (!supportResult.ok) {
    return { permission, isSubscribed: false };
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await fetchPushRegistration();
  } catch (error) {
    console.error('Service Worker ready failed during push reconciliation', error);
    return { permission, isSubscribed: false };
  }

  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    try {
      const backendHasEndpoint = await hasBackendSubscription(subscription.endpoint);
      if (!backendHasEndpoint) {
        await registerSubscriptionWithBackend(subscription);
      }
    } catch (error) {
      console.warn('Failed to verify push subscription with backend', error);
    }

    return { permission, isSubscribed: true };
  }

  if (permission !== 'granted' || !repairIfMissing) {
    return { permission, isSubscribed: false };
  }

  try {
    const backendHasSubscription = await hasBackendSubscription();
    if (!backendHasSubscription) {
      return { permission, isSubscribed: false };
    }

    await ensurePushSubscription(registration);
    return { permission, isSubscribed: true };
  } catch (error) {
    console.warn('Failed to repair missing push subscription', error);
    return { permission, isSubscribed: false };
  }
}

export function usePushNotificationBootstrap() {
  const syncInFlightRef = useRef<Promise<void> | null>(null);

  const runVerification = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }

    if (syncInFlightRef.current) {
      return;
    }

    syncInFlightRef.current = (async () => {
      try {
        await reconcilePushSubscription({ repairIfMissing: true });
      } catch (error) {
        console.warn('Push subscription bootstrap verification failed', error);
      } finally {
        syncInFlightRef.current = null;
      }
    })();
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runVerification();
      }
    };

    runVerification();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', runVerification);
    window.addEventListener('online', runVerification);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', runVerification);
      window.removeEventListener('online', runVerification);
    };
  }, [runVerification]);
}

export function usePushNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(getCurrentPermission);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isCheckingSubscription, setIsCheckingSubscription] = useState(true);

  const refreshSubscriptionState = useCallback(
    async ({ repairIfMissing = true }: { repairIfMissing?: boolean } = {}) => {
      setIsCheckingSubscription(true);

      try {
        const result = await reconcilePushSubscription({ repairIfMissing });
        setPermission(result.permission);
        setIsSubscribed(result.isSubscribed);
        return result;
      } finally {
        setIsCheckingSubscription(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refreshSubscriptionState();
  }, [refreshSubscriptionState]);

  const requestPermission = useCallback(async (): Promise<PushNotificationResult> => {
    const supportResult = checkPushSupport();
    if (!supportResult.ok) {
      return supportResult;
    }

    const perm = await Notification.requestPermission();
    setPermission(perm);

    if (perm !== 'granted') {
      return failure('permission_denied', 'Notification permission not granted');
    }

    return success();
  }, []);

  const subscribeToPush = useCallback(async () => {
    setLoading(true);
    try {
      const supportResult = checkPushSupport();
      if (!supportResult.ok) {
        return supportResult;
      }

      if (permission !== 'granted') {
        const permissionResult = await requestPermission();
        if (!permissionResult.ok) {
          return permissionResult;
        }
      }

      let registration: ServiceWorkerRegistration;
      try {
        registration = await fetchPushRegistration();
      } catch (error) {
        console.error('Service Worker ready failed', error);
        return failure('service_worker_unavailable', getErrorMessage(error, 'Service Worker unavailable'));
      }

      try {
        await ensurePushSubscription(registration);
      } catch (backendError) {
        console.error('Backend subscription failed', backendError);
        return failure('backend_subscribe_failed', getErrorMessage(backendError, 'Failed to subscribe on the server'));
      }

      setPermission(getCurrentPermission());
      setIsSubscribed(true);
      return success();
    } catch (e) {
      console.error('Failed to subscribe to push', e);
      return failure('subscribe_failed', getErrorMessage(e, 'Failed to subscribe to push notifications'));
    } finally {
      setLoading(false);
    }
  }, [permission, requestPermission]);

  const unsubscribeFromPush = useCallback(async () => {
    setLoading(true);
    try {
      const supportResult = checkPushSupport();
      if (!supportResult.ok) {
        return supportResult;
      }

      let registration: ServiceWorkerRegistration;
      try {
        registration = await fetchPushRegistration();
      } catch (error) {
        console.error('Service Worker ready failed', error);
        return failure('service_worker_unavailable', getErrorMessage(error, 'Service Worker unavailable'));
      }

      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Attempt to notify backend
        try {
          await apiClient.post('/push/unsubscribe', {
            endpoint: subscription.endpoint,
          });
        } catch (err) {
          console.warn('Failed to unsubscribe on backend, but proceeding to remove local subscription', err);
        }

        await subscription.unsubscribe();
      }

      setIsSubscribed(false);
      return success();
    } catch (e) {
      console.error('Failed to unsubscribe', e);
      return failure('unsubscribe_failed', getErrorMessage(e, 'Failed to unsubscribe from push notifications'));
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    permission,
    isSubscribed,
    loading,
    isCheckingSubscription,
    refreshSubscriptionState,
    requestPermission,
    subscribeToPush,
    unsubscribeFromPush,
  };
}
