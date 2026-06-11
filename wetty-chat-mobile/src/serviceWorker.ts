/// <reference lib="webworker" />
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { getHighWaterMark, kvGet, setHighWaterMark } from './utils/db';
import { formatNotificationBody, getNotificationPreviewLabels, type PreviewMessage } from './utils/messagePreview';
import {
  buildNotificationNavigationData,
  buildNotificationLaunchUrl,
  extractNotificationNavigationData,
  type NotificationNavigationData,
  resolveNotificationTarget,
  type NotificationOpenMessage,
} from './utils/notificationNavigation';

declare let self: ServiceWorkerGlobalScope;

interface PushPayload {
  type?: 'newMessage';
  title?: string;
  body?: string;
  senderName?: string;
  messagePreview?: PreviewMessage;
  unreadCount?: number;
  data?: NotificationNavigationData;
}

type BadgeCapableWorkerNavigator = WorkerNavigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

const EXTERNAL_ASSET_CACHE_NAME = 'external-assets-v1';
const EXTERNAL_CACHEABLE_DESTINATIONS = new Set(['audio', 'font', 'image', 'script', 'style', 'video']);
const EXTERNAL_ASSET_EXTENSION_RE =
  /\.(?:avif|css|eot|gif|heic|ico|jpeg|jpg|js|json|m4a|mp3|mp4|ogg|otf|png|svg|ttf|wav|webm|webp|woff2?)(?:$|\?)/i;

const assetBaseUrl = typeof __ASSET_BASE__ !== 'undefined' && __ASSET_BASE__ ? new URL(__ASSET_BASE__) : null;
const normalizedAssetBasePath = assetBaseUrl ? normalizeBasePath(assetBaseUrl.pathname) : null;
const apiBase = (() => {
  if (typeof __API_BASE__ !== 'undefined') {
    return __API_BASE__;
  }

  if (import.meta.env.DEV) {
    return '/_api';
  }

  throw new Error('Missing __API_BASE__ in service worker');
})();
const apiBaseUrl = new URL(apiBase, self.registration.scope);
const normalizedApiBasePath = normalizeBasePath(apiBaseUrl.pathname);

function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }

  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function urlMatchesBasePath(urlPathname: string, basePathname: string): boolean {
  if (basePathname === '/') {
    return true;
  }

  return urlPathname === basePathname || urlPathname.startsWith(`${basePathname}/`);
}

function isApiUrl(url: URL): boolean {
  return url.origin === apiBaseUrl.origin && urlMatchesBasePath(url.pathname, normalizedApiBasePath);
}

function isUnderAssetBase(url: URL): boolean {
  return (
    assetBaseUrl != null &&
    normalizedAssetBasePath != null &&
    url.origin === assetBaseUrl.origin &&
    urlMatchesBasePath(url.pathname, normalizedAssetBasePath)
  );
}

function isCacheControlDisabled(cacheControl: string): boolean {
  return /\b(?:no-cache|no-store|private)\b/i.test(cacheControl);
}

function getCacheMaxAgeSeconds(cacheControl: string): number | null {
  const match = cacheControl.match(/\bmax-age=(\d+)\b/i);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

function isResponseFresh(response: Response): boolean {
  if (response.type === 'opaque') {
    return true;
  }

  const cacheControl = response.headers.get('cache-control') ?? '';
  if (isCacheControlDisabled(cacheControl)) {
    return false;
  }

  if (/\bimmutable\b/i.test(cacheControl)) {
    return true;
  }

  const maxAgeSeconds = getCacheMaxAgeSeconds(cacheControl);
  if (maxAgeSeconds == null) {
    return true;
  }

  const dateHeader = response.headers.get('date');
  if (!dateHeader) {
    return true;
  }

  const responseTime = Date.parse(dateHeader);
  if (!Number.isFinite(responseTime)) {
    return true;
  }

  return Date.now() - responseTime <= maxAgeSeconds * 1000;
}

const externalAssetCacheControlPlugin = {
  async cacheWillUpdate({ response }: { response: Response }): Promise<Response | null> {
    if (response.type === 'opaque' || response.status === 0) {
      return response;
    }

    if (response.status !== 200) {
      return null;
    }

    const cacheControl = response.headers.get('cache-control') ?? '';
    return isCacheControlDisabled(cacheControl) ? null : response;
  },

  async cachedResponseWillBeUsed({
    cachedResponse,
  }: {
    cachedResponse?: Response | null;
  }): Promise<Response | null | undefined> {
    if (!cachedResponse) {
      return cachedResponse;
    }

    return isResponseFresh(cachedResponse) ? cachedResponse : null;
  },
};

async function syncAppBadgeFromPushPayload(unreadCount: unknown): Promise<void> {
  if (typeof unreadCount !== 'number' || !Number.isFinite(unreadCount) || unreadCount < 0) {
    return;
  }

  const navigatorWithBadge = self.navigator as BadgeCapableWorkerNavigator;

  try {
    if (unreadCount > 0) {
      await navigatorWithBadge.setAppBadge?.(unreadCount);
      return;
    }

    await navigatorWithBadge.clearAppBadge?.();
  } catch (err) {
    console.error('Failed to sync app badge from push payload', err);
  }
}

async function updateHighWaterMarkIdb(chatId: string, messageId: string): Promise<void> {
  try {
    const id = BigInt(messageId);
    const current = await getHighWaterMark(chatId);
    if (current == null || id > BigInt(current)) {
      await setHighWaterMark(chatId, messageId);
    }
  } catch {
    /* non-numeric id, ignore */
  }
}

async function isAlreadyNotified(chatId: string, messageId: string): Promise<boolean> {
  try {
    const id = BigInt(messageId);
    const mark = await getHighWaterMark(chatId);
    return mark != null && id <= BigInt(mark);
  } catch {
    return false;
  }
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'NOTIFIED') {
    const { chatId, messageId } = event.data;
    if (chatId && messageId) {
      event.waitUntil(updateHighWaterMarkIdb(String(chatId), String(messageId)));
    }
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const manifest = self.__WB_MANIFEST;
precacheAndRoute(manifest);

// clean old assets
cleanupOutdatedCaches();

// Catch routing to index.html for SPA
// Workaround for dev server: only register navigation route if index.html is precached
const hasPrecachedIndex = manifest.some((entry) => (typeof entry === 'string' ? entry : entry.url) === 'index.html');

if (!import.meta.env.DEV && hasPrecachedIndex) {
  registerRoute(({ request, url }) => {
    if (request.mode !== 'navigate') {
      return false;
    }

    if (import.meta.env.DEV && url.pathname !== '/') {
      return false;
    }

    return !isApiUrl(url);
  }, createHandlerBoundToURL('index.html'));
}

if (!import.meta.env.DEV) {
  registerRoute(
    ({ request, url }) => {
      if (request.method !== 'GET') {
        return false;
      }

      if (isApiUrl(url)) {
        return false;
      }

      if (!isUnderAssetBase(url)) {
        return false;
      }

      return EXTERNAL_CACHEABLE_DESTINATIONS.has(request.destination) || EXTERNAL_ASSET_EXTENSION_RE.test(url.pathname);
    },
    new CacheFirst({
      cacheName: EXTERNAL_ASSET_CACHE_NAME,
      plugins: [
        externalAssetCacheControlPlugin,
        new ExpirationPlugin({
          maxEntries: 300,
          maxAgeSeconds: 60 * 60 * 24 * 365,
          purgeOnQuotaError: true,
        }),
      ],
    }),
  );
}

self.addEventListener('push', (event) => {
  if (!event.data) return;

  event.waitUntil(
    (async () => {
      try {
        const payload = event.data!.json() as PushPayload;
        const title = payload.title || 'New Message';
        let body = payload.body ?? '';

        if (payload.messagePreview) {
          try {
            const locale = await kvGet<string>('effective_locale');
            body = formatNotificationBody(
              payload.senderName ?? 'Someone',
              payload.messagePreview,
              getNotificationPreviewLabels(locale),
            );
          } catch (err) {
            console.error('Failed to localize push preview, using legacy body', err);
          }
        }

        const notificationData = buildNotificationNavigationData({
          chatId: payload.data?.chatId,
          messageId: payload.data?.messageId,
          threadRootId: payload.data?.threadRootId,
          target: payload.data?.target,
        });
        const chatId = notificationData.chatId;
        const messageId = notificationData.messageId;

        if (chatId && messageId && (await isAlreadyNotified(String(chatId), String(messageId)))) {
          return;
        }

        if (chatId && messageId) {
          await updateHighWaterMarkIdb(String(chatId), String(messageId));
        }

        const tag = messageId ? `msg_${messageId}` : undefined;

        await self.registration.showNotification(title, {
          body,
          icon: '/icon/pwa-192x192.png',
          badge: '/icon/pwa-64x64.png',
          tag,
          data: notificationData,
        });

        await syncAppBadgeFromPushPayload(payload.unreadCount);
      } catch (err) {
        console.error('Failed to parse push event payload', err);
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationData = extractNotificationNavigationData(event.notification.data);
  const target = resolveNotificationTarget({
    chatId: notificationData.chatId,
    threadRootId: notificationData.threadRootId,
    target: notificationData.target,
  });
  const launchUrl = buildNotificationLaunchUrl(self.registration.scope, target);
  const message: NotificationOpenMessage = {
    type: 'OPEN_NOTIFICATION_TARGET',
    chatId: notificationData.chatId,
    threadRootId: notificationData.threadRootId,
    target,
  };

  console.debug('[sw] notificationclick', {
    scope: self.registration.scope,
    target,
    notificationData,
    rawNotificationData: event.notification.data,
  });

  // Attempt to focus the app main window if it is open, else open it
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const appClients = clientList.filter((client) => client.url.startsWith(self.registration.scope));
      const preferredClient = appClients.find((client) => client.visibilityState === 'visible') ?? appClients[0];

      console.debug('[sw] notificationclick clients', {
        totalClients: clientList.length,
        appClients: appClients.map((client) => ({
          url: client.url,
          visibilityState: client.visibilityState,
          focused: client.focused,
        })),
        preferredClient: preferredClient
          ? {
              url: preferredClient.url,
              visibilityState: preferredClient.visibilityState,
              focused: preferredClient.focused,
            }
          : null,
      });

      if (preferredClient && 'focus' in preferredClient) {
        console.debug('[sw] posting notification target to existing client', {
          url: preferredClient.url,
          target,
        });
        preferredClient.postMessage(message);
        return preferredClient.focus();
      }

      if (self.clients.openWindow) {
        console.debug('[sw] opening new client window', { launchUrl });
        return self.clients.openWindow(launchUrl);
      }
    }),
  );
});
