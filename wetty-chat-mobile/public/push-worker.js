importScripts('./ngsw-worker.js');

(() => {
  self.addEventListener('push', (event) => {
    if (!event.data) return;
    event.waitUntil(
      (async () => {
        // The Rust backend sends title/body at the top level; Angular handles only payload.notification.
        const payload = event.data.json();
        if (payload.type !== 'newMessage' || typeof payload.title !== 'string') return;
        const { chatId, messageId, threadRootId } = payload.data;
        const validId = (id) => typeof id === 'string' && /^\d+$/.test(id);
        let target = 'chats';
        if (validId(chatId)) {
          target += `/chat/${chatId}`;
          if (validId(threadRootId)) target += `/thread/${threadRootId}`;
        }
        await self.registration.showNotification(payload.title, {
          body: payload.body,
          icon: new URL('icons/pwa-192x192.png', self.registration.scope).href,
          badge: new URL('icons/pwa-64x64.png', self.registration.scope).href,
          tag: validId(messageId) ? `msg_${messageId}` : undefined,
          data: {
            chatId,
            messageId,
            threadRootId,
            onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: target } },
          },
        });
        if ('setAppBadge' in self.navigator && Number.isInteger(payload.unreadCount)) {
          if (payload.unreadCount > 0) await self.navigator.setAppBadge(payload.unreadCount);
          else await self.navigator.clearAppBadge();
        }
      })().catch((error) => console.error('Unable to display message notification', error)),
    );
  });
})();
