const development = new URL(self.location.href).searchParams.get('development') === '1';

// Diagnostics observe Angular's own fetches; they never handle fetch events.
const diagnostics = development
  ? null
  : (() => {
      const limit = 60;
      const maxBytes = 24 * 1024;
      const encoder = new TextEncoder();
      let events = [];
      let generation = 0;
      const database = new Promise((resolve, reject) => {
        const opening = indexedDB.open('chahua-worker-diagnostics', 1);
        opening.onupgradeneeded = () => opening.result.createObjectStore('events');
        opening.onsuccess = () => {
          opening.result.onversionchange = () => opening.result.close();
          resolve(opening.result);
        };
        opening.onerror = () => reject(opening.error);
      });
      const storage = async (mode, action) => {
        const db = await database;
        return new Promise((resolve, reject) => {
          const transaction = db.transaction('events', mode);
          const request = action(transaction.objectStore('events'));
          transaction.oncomplete = () => resolve(request?.result);
          transaction.onabort = transaction.onerror = () => reject(transaction.error);
        });
      };
      // A single serialized, bounded record prevents concurrent writes from restoring cleared data.
      let pending = storage('readonly', (store) => store.get('ring'))
        .then((saved) => {
          if (Array.isArray(saved)) events = saved;
        })
        .catch(() => {});
      const enqueue = (action) => {
        pending = pending.then(action).catch(() => {});
        return pending;
      };
      const persist = () => storage('readwrite', (store) => store.put(events, 'ring')).catch(() => {});
      const clear = () => {
        generation++;
        return enqueue(async () => {
          events = [];
          await persist();
        });
      };
      const allowed = (value, values, fallback) => (values.includes(value) ? value : fallback);
      const pathWords = [
        'chats',
        'chat',
        'thread',
        'message',
        'settings',
        'profile',
        '_api',
        'ws',
        'ngsw',
        'state',
        'index.html',
        'ngsw.json',
        'i18n',
        'icon',
        'icon-maskable',
        'media',
        'emoji',
        '.well-known',
        'invite',
        'join',
      ];
      const safePath = (pathname) => {
        let previous;
        const parts = pathname
          .split('/')
          .filter(Boolean)
          .slice(0, 12)
          .map((part) => {
            try {
              part = decodeURIComponent(part);
            } catch {
              part = '';
            }
            const secret = previous === 'invite' || previous === 'join';
            previous = part;
            if (
              !secret &&
              (pathWords.includes(part) ||
                /^\d{1,20}$/.test(part) ||
                /^(?:main|chunk)-[\w-]{8,32}\.js$/.test(part) ||
                /^styles-[\w-]{8,32}\.css$/.test(part))
            )
              return part;
            return '[redacted]';
          });
        return `/${parts.join('/')}`;
      };
      const requestDetails = (input, options = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, self.location.href);
        const path = safePath(url.pathname);
        const headers = options.headers ?? input?.headers;
        const accept = new Headers(headers).get('accept') ?? '';
        return {
          url: `${url.origin}${path}`,
          method: allowed(
            (options.method ?? input?.method ?? 'GET').toUpperCase(),
            ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            'OTHER',
          ),
          mode: allowed(options.mode ?? input?.mode ?? 'cors', ['cors', 'no-cors', 'same-origin', 'navigate'], 'other'),
          cache: allowed(
            options.cache ?? input?.cache ?? 'default',
            ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'],
            'other',
          ),
          destination: allowed(
            input?.destination ?? '',
            [
              '',
              'audio',
              'document',
              'embed',
              'font',
              'frame',
              'iframe',
              'image',
              'manifest',
              'object',
              'report',
              'script',
              'sharedworker',
              'style',
              'track',
              'video',
              'worker',
              'xslt',
            ],
            'other',
          ),
          accept: accept.toLowerCase().includes('text/html') ? 'text/html' : 'other',
        };
      };
      const record = (epoch, event, details) => {
        if (epoch !== generation) return;
        const at = Date.now();
        void enqueue(async () => {
          if (epoch !== generation) return;
          const previous = events[events.length - 1];
          const comparable = ({ durationMs, count, ...rest }) => JSON.stringify(rest);
          if (previous?.event === event && comparable(previous.details) === comparable(details)) {
            previous.at = at;
            previous.details.durationMs = details.durationMs;
            previous.details.count = (previous.details.count ?? 1) + 1;
          } else {
            events.push({ at, event, details });
          }
          while (events.length > limit || encoder.encode(JSON.stringify(events)).length > maxBytes) events.shift();
          await persist();
        });
      };
      const fetch = self.fetch;
      self.fetch = function (...args) {
        const epoch = generation;
        const start = Date.now();
        let details;
        try {
          details = requestDetails(args[0], args[1]);
        } catch {}
        const observe = (event, extra) => {
          try {
            if (details) record(epoch, event, { ...details, ...extra, durationMs: Math.max(0, Date.now() - start) });
          } catch {}
        };
        let result;
        try {
          result = fetch.apply(this, args);
        } catch (error) {
          try {
            observe('fetch-rejected', {
              errorName: allowed(error?.name, ['TypeError', 'AbortError', 'NetworkError', 'SecurityError'], 'Error'),
            });
          } catch {}
          throw error;
        }
        return result.then(
          (response) => {
            try {
              if (response.status >= 400) observe('fetch-http-error', { status: response.status });
            } catch {}
            return response;
          },
          (error) => {
            try {
              observe('fetch-rejected', {
                errorName: allowed(error?.name, ['TypeError', 'AbortError', 'NetworkError', 'SecurityError'], 'Error'),
              });
            } catch {}
            throw error;
          },
        );
      };
      return {
        clear,
        snapshot: () => enqueue(() => events.map((entry) => ({ ...entry, details: { ...entry.details } }))),
      };
    })();

(() => {
  // web-push 0.11 defaults to a 28-day TTL; keep records beyond that delivery window.
  const retention = 30 * 24 * 60 * 60 * 1000;
  const validId = (id) => typeof id === 'string' && /^\d+$/.test(id);
  const scopeKey = (data) => `${data.chatId}/${data.threadRootId ?? ''}`;
  let account;
  const database = new Promise((resolve, reject) => {
    const opening = indexedDB.open('chahua-notifications', 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('session');
      for (const name of ['seen', 'reads'])
        opening.result.createObjectStore(name).createIndex('expiresAt', 'expiresAt');
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      opening.result.onversionchange = () => opening.result.close();
      resolve(opening.result);
    };
  });
  const query = async (name, mode, action) => {
    const db = await database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      const result = action(transaction.objectStore(name));
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  };
  const key = (id) => [account ?? 'legacy', id];
  const remember = async (id) => {
    if (validId(id))
      await query('seen', 'readwrite', (store) => store.put({ expiresAt: Date.now() + retention }, key(id)));
  };
  const target = (data) => {
    let url = 'chats';
    if (validId(data?.chatId)) {
      url += `/chat/${data.chatId}`;
      if (validId(data.threadRootId)) url += `/thread/${data.threadRootId}`;
      if (validId(data.messageId)) url += `#msg=${data.messageId}`;
    }
    return url;
  };
  // Serialize page messages and Push, including database commits.
  let pending = (async () => {
    account = await query('session', 'readonly', (store) => store.get('uid'));
    for (const name of ['seen', 'reads']) {
      await query(name, 'readwrite', (store) => {
        const cursor = store.index('expiresAt').openCursor(IDBKeyRange.upperBound(Date.now()));
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (entry) {
            entry.delete();
            entry.continue();
          }
        };
      });
    }
    for (const notification of await self.registration.getNotifications()) {
      if (notification.data?.uid === undefined || notification.data.uid === account)
        await remember(notification.data?.messageId);
    }
  })();
  const enqueue = (action) => {
    pending = pending.then(action).catch((error) => console.error('Unable to handle message notification', error));
    return pending;
  };
  const badge = async (count) => {
    if (!('setAppBadge' in self.navigator) || !Number.isInteger(count) || count < 0) return;
    try {
      if (count) await self.navigator.setAppBadge(count);
      else await self.navigator.clearAppBadge();
    } catch (error) {
      console.error('Unable to update notification badge', error);
    }
  };
  // Directed mentions/replies are also normal messages; they must be shown,
  // otherwise the server-composed mention/reply body would be dropped.
  const notifiable = new Set(['newMessage', 'mention', 'reply']);
  const receive = async (payload, suppress = false) => {
    if (account === null || !notifiable.has(payload.type) || typeof payload.title !== 'string') return;
    const { chatId, messageId, threadRootId } = payload.data;
    const seen = validId(messageId) && (await query('seen', 'readonly', (store) => store.get(key(messageId))));
    const read = await query('reads', 'readonly', (store) => store.get(key(scopeKey(payload.data))));
    if (
      seen?.expiresAt > Date.now() ||
      (validId(messageId) && read?.expiresAt > Date.now() && BigInt(messageId) <= BigInt(read.messageId))
    )
      return;
    if (!suppress) {
      await self.registration.showNotification(payload.title, {
        body: payload.ordinaryMessageBody ?? payload.body,
        icon: new URL('icon/pwa-192x192.png', self.registration.scope).href,
        badge: new URL('icon/pwa-64x64.png', self.registration.scope).href,
        tag: validId(messageId) ? `msg_${messageId}` : undefined,
        renotify: false,
        data: {
          chatId,
          messageId,
          threadRootId,
          uid: account,
          // Angular navigates warm pages without discarding the in-memory send queue.
          onActionClick: { default: { operation: 'focusLastFocusedOrOpen', url: target(payload.data) } },
        },
      });
    }
    await remember(messageId);
    await badge(payload.unreadCount);
  };
  const close = async (data) => {
    if (validId(data.readThrough)) {
      const id = key(scopeKey(data));
      const previous = await query('reads', 'readonly', (store) => store.get(id));
      const messageId =
        previous && BigInt(previous.messageId) > BigInt(data.readThrough) ? previous.messageId : data.readThrough;
      await query('reads', 'readwrite', (store) => store.put({ messageId, expiresAt: Date.now() + retention }, id));
    }
    for (const id of data.messageIds ?? []) await remember(id);
    for (const notification of await self.registration.getNotifications()) {
      const message = notification.data;
      if (!message) continue;
      if (
        data.all ||
        data.messageIds?.includes(message.messageId) ||
        (scopeKey(message) === scopeKey(data) &&
          validId(message.messageId) &&
          validId(data.readThrough) &&
          BigInt(message.messageId) <= BigInt(data.readThrough))
      ) {
        await remember(message.messageId);
        notification.close();
      }
    }
  };
  self.addEventListener('push', (event) => {
    if (event.data) event.waitUntil(enqueue(() => receive(event.data.json())));
  });
  self.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.type === 'CHAHUA_DIAGNOSTICS') {
      if (event.ports?.[0] && (data.action === 'snapshot' || data.action === 'clear')) {
        event.waitUntil(
          enqueue(async () => {
            let events = [];
            if (data.action === 'clear') await diagnostics?.clear();
            else if (data.uid === (account ?? null)) events = (await diagnostics?.snapshot()) ?? [];
            event.ports[0].postMessage({ events });
          }),
        );
      }
      return;
    }
    if (!data?.type?.startsWith('CHAHUA_')) return;
    event.waitUntil(
      enqueue(async () => {
        if (data.type === 'CHAHUA_SESSION') {
          if (account !== undefined && data.uid !== account) void diagnostics?.clear();
          if (account !== undefined && data.uid !== account) {
            for (const notification of await self.registration.getNotifications()) notification.close();
          }
          account = data.uid;
          await query('session', 'readwrite', (store) => store.put(account, 'uid'));
          for (const notification of await self.registration.getNotifications())
            await remember(notification.data?.messageId);
          return;
        }
        if (data.uid !== undefined && data.uid !== account) return;
        switch (data.type) {
          case 'CHAHUA_NOTIFY':
            await receive(data.payload, data.suppress);
            break;
          case 'CHAHUA_CLOSE':
            await close(data);
            break;
        }
      }),
    );
  });
  // Development handles every notification click; production leaves current notifications to Angular.
  // Keep the legacy handler before Angular until old notifications without onActionClick expire.
  self.addEventListener('notificationclick', (event) => {
    const data = event.notification.data;
    if ((!development && data?.onActionClick) || !validId(data?.chatId)) return;
    event.stopImmediatePropagation();
    event.notification.close();
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({ type: 'window' });
        const client = clients.find((client) => client.visibilityState === 'visible') ?? clients[0];
        if (client) {
          await client.focus();
          client.postMessage({ type: 'NOTIFICATION_CLICK', data: { action: event.action, notification: { data } } });
          // A tab still running the old application understands this message.
          if (!development)
            client.postMessage({ type: 'OPEN_NOTIFICATION_TARGET', ...data, target: `/${target(data)}` });
        } else {
          await self.clients.openWindow(new URL(target(data), self.registration.scope).href);
        }
      })(),
    );
  });
})();
if (development) {
  // No fetch handler or Angular worker: development resources always use the network.
  self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
} else {
  importScripts('./ngsw-worker.js');
}
