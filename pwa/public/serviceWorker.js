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
  const receive = async (payload, suppress = false) => {
    if (account === null || payload.type !== 'newMessage' || typeof payload.title !== 'string') return;
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
        body: payload.body,
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
    if (!data?.type?.startsWith('CHAHUA_')) return;
    event.waitUntil(
      enqueue(async () => {
        if (data.type === 'CHAHUA_SESSION') {
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
  // Keep until notifications from the old worker have expired or been dismissed; they lack onActionClick.
  // Register before Angular so its handler does not consume those clicks first.
  self.addEventListener('notificationclick', (event) => {
    const data = event.notification.data;
    if (data?.onActionClick || !validId(data?.chatId)) return;
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
          client.postMessage({ type: 'OPEN_NOTIFICATION_TARGET', ...data, target: `/${target(data)}` });
        } else {
          await self.clients.openWindow(new URL(target(data), self.registration.scope).href);
        }
      })(),
    );
  });
})();
importScripts('./ngsw-worker.js');
