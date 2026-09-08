importScripts('./ngsw-worker.js');

(() => {
  const seen = new Set();
  const reads = new Map();
  const validId = (id) => typeof id === 'string' && /^\d+$/.test(id);
  const scopeKey = (data) => `${data.chatId}/${data.threadRootId ?? ''}`;
  const remember = (id) => {
    if (!validId(id)) return;
    seen.add(id);
    if (seen.size > 512) seen.delete(seen.values().next().value);
  };
  // Serialize Push and page messages so simultaneous delivery cannot show the same message twice.
  let pending = self.registration
    .getNotifications()
    .then((notifications) => {
      for (const notification of notifications) remember(notification.data?.messageId);
    })
    .catch(() => {});
  const enqueue = (action) => {
    const result = pending.then(action);
    pending = result.catch((error) => console.error('Unable to handle message notification', error));
    return result;
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
  const receive = async (payload, foreground = false) => {
    if (payload.type !== 'newMessage' || typeof payload.title !== 'string') return false;
    const { chatId, messageId, threadRootId } = payload.data;
    const readThrough = reads.get(scopeKey(payload.data));
    if (seen.has(messageId) || (validId(messageId) && readThrough && BigInt(messageId) <= BigInt(readThrough)))
      return false;
    if (!foreground) {
      let target = 'chats';
      if (validId(chatId)) {
        target += `/chat/${chatId}`;
        if (validId(threadRootId)) target += `/thread/${threadRootId}`;
        if (validId(messageId)) target += `?message=${messageId}`;
      }
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: new URL('icons/pwa-192x192.png', self.registration.scope).href,
        badge: new URL('icons/pwa-64x64.png', self.registration.scope).href,
        tag: validId(messageId) ? `msg_${messageId}` : undefined,
        renotify: false,
        data: {
          chatId,
          messageId,
          threadRootId,
          // Warm clients navigate through Angular, preserving their in-memory send queue.
          onActionClick: { default: { operation: 'focusLastFocusedOrOpen', url: target } },
        },
      });
    }
    remember(messageId);
    await badge(payload.unreadCount);
    return true;
  };
  const close = async (data) => {
    if (data.readThrough && validId(data.readThrough)) {
      const key = scopeKey(data);
      const previous = reads.get(key);
      if (!previous || BigInt(data.readThrough) > BigInt(previous)) reads.set(key, data.readThrough);
      if (reads.size > 256) reads.delete(reads.keys().next().value);
    }
    for (const id of data.messageIds ?? []) remember(id);
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
      )
        notification.close();
    }
  };
  self.addEventListener('push', (event) => {
    if (event.data) event.waitUntil(enqueue(() => receive(event.data.json())).catch(() => {}));
  });
  self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data?.type?.startsWith('CHAHUA_')) return;
    event.waitUntil(
      enqueue(async () => {
        let accepted = true;
        switch (data.type) {
          case 'CHAHUA_NOTIFY':
            accepted = await receive(data.payload, data.foreground);
            break;
          case 'CHAHUA_CLOSE':
            await close(data);
            break;
          default:
            return;
        }
        event.ports[0]?.postMessage(accepted);
      }).catch(() => event.ports[0]?.postMessage(false)),
    );
  });
})();
