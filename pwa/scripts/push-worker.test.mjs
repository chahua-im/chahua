import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const source = await readFile(new URL('../public/serviceWorker.js', import.meta.url), 'utf8');
function worker(existing = [], { dbFactory = new IDBFactory(), now = Date.now(), failShow = false } = {}) {
  const listeners = new Map();
  const shown = [];
  const badges = [];
  const errors = [];
  const imports = [];
  const notifications = [...existing];
  const opened = [];
  const clients = [];
  const context = {
    URL,
    indexedDB: dbFactory,
    IDBKeyRange,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    console: { error: (...args) => errors.push(args) },
    importScripts: (url) => imports.push(url),
    self: {
      clients: { matchAll: async () => clients, openWindow: async (url) => opened.push(url) },
      addEventListener: (name, handler) => listeners.set(name, handler),
      registration: {
        scope: 'https://chat.example/',
        getNotifications: async () => notifications.filter((n) => !n.closed),
        showNotification: async (title, options) => {
          if (failShow) throw new Error('Display failed');
          shown.push([title, options]);
          notifications.push({
            ...options,
            closed: false,
            close() {
              this.closed = true;
            },
          });
        },
      },
      navigator: { setAppBadge: async (value) => badges.push(value), clearAppBadge: async () => badges.push(0) },
    },
  };
  vm.runInNewContext(source, context);
  return {
    dbFactory,
    opened,
    clients,
    click: async (data) => {
      let pending;
      let stopped = false;
      listeners.get('notificationclick')({
        notification: { data, close() {} },
        action: '',
        stopImmediatePropagation() {
          stopped = true;
        },
        waitUntil(value) {
          pending = value;
        },
      });
      await pending;
      return stopped;
    },
    shown,
    badges,
    errors,
    imports,
    notifications,
    command: (data) => {
      let pending;
      listeners.get('message')({
        data,
        waitUntil: (value) => (pending = value),
      });
      return pending;
    },
    push: (payload) => {
      let pending;
      listeners.get('push')({
        data: { json: () => payload },
        waitUntil: (value) => {
          pending = value;
        },
      });
      return pending;
    },
  };
}
const payload = {
  type: 'newMessage',
  title: '茶话',
  body: 'Alice: hello',
  unreadCount: 3,
  data: { chatId: '90071992547409931', messageId: '90071992547409933', threadRootId: '90071992547409932' },
};

test('extends Angular caching and emits exactly one existing-format notification with lossless thread navigation', async () => {
  const instance = worker();
  await instance.push(payload);
  assert.deepEqual(instance.imports, ['./ngsw-worker.js']);
  assert.equal(instance.shown.length, 1);
  const [title, notification] = instance.shown[0];
  assert.equal(title, payload.title);
  assert.equal(notification.body, payload.body);
  assert.equal(notification.tag, 'msg_90071992547409933');
  assert.equal(notification.data.onActionClick.default.operation, 'focusLastFocusedOrOpen');
  assert.equal(
    notification.data.onActionClick.default.url,
    'chats/chat/90071992547409931/thread/90071992547409932#msg=90071992547409933',
  );
  assert.deepEqual(instance.badges, [3]);
});

test('normal chat notifications open the current Angular chat route and zero unread clears the badge', async () => {
  const instance = worker();
  await instance.push({ ...payload, unreadCount: 0, data: { chatId: '42', messageId: '43' } });
  assert.equal(instance.shown[0][1].data.onActionClick.default.url, 'chats/chat/42#msg=43');
  assert.deepEqual(instance.badges, [0]);
});

test('does not duplicate native Angular payloads and never accepts an external navigation target', async () => {
  const instance = worker();
  await instance.push({ notification: { title: 'native' } });
  assert.equal(instance.shown.length, 0);
  await instance.push({ ...payload, data: { chatId: '//evil.example', target: 'https://evil.example' } });
  assert.equal(instance.shown[0][1].data.onActionClick.default.url, 'chats');
});

test('contains malformed payload failures and continues processing subsequent notifications', async () => {
  const instance = worker();
  await instance.push({ type: 'newMessage', title: 'invalid' });
  assert.equal(instance.errors.length, 1);
  assert.equal(instance.shown.length, 0);
  await instance.command({ type: 'CHAHUA_NOTIFY', payload });
  assert.equal(instance.shown.length, 1);
  assert.equal(instance.errors.length, 1);
});

test('a page message displays a system notification without waiting for Push', async () => {
  const instance = worker();
  await instance.command({ type: 'CHAHUA_NOTIFY', payload, suppress: false });
  assert.equal(instance.shown.length, 1);
  assert.equal(instance.shown[0][0], payload.title);
  assert.equal(instance.shown[0][1].body, payload.body);
});

test('deduplicates concurrent local notification and Push delivery in either order', async () => {
  for (const pushFirst of [false, true]) {
    const instance = worker();
    const local = () => instance.command({ type: 'CHAHUA_NOTIFY', payload, suppress: false });
    const push = () => instance.push(payload);
    await Promise.all(pushFirst ? [push(), local()] : [local(), push()]);
    assert.equal(instance.shown.length, 1);
  }
});

test('reading the current conversation suppresses its delayed Push without suppressing older message IDs', async () => {
  const instance = worker();
  await instance.command({ type: 'CHAHUA_NOTIFY', payload, suppress: true });
  await instance.push(payload);
  assert.equal(instance.shown.length, 0);
  await instance.push({ ...payload, data: { ...payload.data, messageId: '90071992547409930' } });
  assert.equal(instance.shown.length, 1);
});

test('a Push shown first prevents a duplicate online system notification', async () => {
  const instance = worker();
  await instance.push(payload);
  await instance.command({ type: 'CHAHUA_NOTIFY', payload, suppress: false });
  assert.equal(instance.shown.length, 1);
});

test('restores deduplication from notifications still visible after a worker restart', async () => {
  const instance = worker([{ data: payload.data }]);
  await instance.push(payload);
  assert.equal(instance.shown.length, 0);
});

test('reading a scope closes only messages through its read boundary, including delayed delivery', async () => {
  const instance = worker();
  await instance.push(payload);
  await instance.push({ ...payload, data: { ...payload.data, messageId: '90071992547409934' } });
  await instance.push({ ...payload, data: { chatId: payload.data.chatId, messageId: '90071992547409935' } });
  await instance.command({ type: 'CHAHUA_CLOSE', ...payload.data, readThrough: payload.data.messageId });
  assert.equal(instance.notifications[0].closed, true);
  assert.equal(instance.notifications[1].closed, false);
  assert.equal(instance.notifications[2].closed, false);
  await instance.push({ ...payload, data: { ...payload.data, messageId: '90071992547409932' } });
  assert.equal(instance.shown.length, 3);
});

test('recall closes exact notifications and turning notifications off closes the remainder', async () => {
  const instance = worker();
  await instance.push(payload);
  await instance.command({ type: 'CHAHUA_CLOSE', messageIds: [payload.data.messageId] });
  assert.equal(instance.notifications[0].closed, true);
  await instance.push({ ...payload, data: { ...payload.data, messageId: '90071992547409934' } });
  await instance.command({ type: 'CHAHUA_CLOSE', all: true });
  assert.ok(instance.notifications.every((n) => n.closed));
});

test('remembers dismissed and suppressed messages across worker restarts', async () => {
  const first = worker();
  await first.push(payload);
  first.notifications[0].close();
  const second = worker(first.notifications, { dbFactory: first.dbFactory });
  await second.push(payload);
  assert.equal(second.shown.length, 0);
  const suppressed = { ...payload, data: { ...payload.data, messageId: '51' } };
  await second.command({ type: 'CHAHUA_NOTIFY', payload: suppressed, suppress: true });
  const third = worker([], { dbFactory: first.dbFactory });
  await third.push(suppressed);
  assert.equal(third.shown.length, 0);
});

test('persists read scopes and recalled IDs without dropping unrelated or out-of-order messages', async () => {
  const first = worker();
  await first.command({ type: 'CHAHUA_CLOSE', ...payload.data, readThrough: payload.data.messageId });
  await first.command({ type: 'CHAHUA_CLOSE', messageIds: ['51'] });
  const second = worker([], { dbFactory: first.dbFactory });
  await second.push(payload);
  await second.push({ ...payload, data: { chatId: '42', messageId: '51' } });
  assert.equal(second.shown.length, 0);
  await second.push({ ...payload, data: { chatId: payload.data.chatId, messageId: '101' } });
  await second.push({ ...payload, data: { chatId: payload.data.chatId, messageId: '100' } });
  assert.equal(second.shown.length, 2);
});

test('does not evict records after 512 newer messages and expires them after the push delivery window', async () => {
  const now = Date.now();
  const first = worker([], { now });
  await first.command({ type: 'CHAHUA_CLOSE', messageIds: Array.from({ length: 514 }, (_, i) => String(i + 1)) });
  const within = worker([], { dbFactory: first.dbFactory, now: now + 29 * 86400000 });
  await within.push({ ...payload, data: { chatId: '42', messageId: '1' } });
  assert.equal(within.shown.length, 0);
  const expired = worker([], { dbFactory: first.dbFactory, now: now + 31 * 86400000 });
  await expired.push({ ...payload, data: { chatId: '42', messageId: '1' } });
  assert.equal(expired.shown.length, 1);
});

test('keeps notification history separate for each account and suppresses pushes after sign-out', async () => {
  const first = worker();
  await first.command({ type: 'CHAHUA_SESSION', uid: 1 });
  await first.push(payload);
  await first.command({ type: 'CHAHUA_SESSION', uid: 2 });
  await first.push(payload);
  assert.equal(first.shown.length, 2);
  await first.command({ type: 'CHAHUA_SESSION', uid: 1 });
  await first.push(payload);
  assert.equal(first.shown.length, 2);
  await first.command({ type: 'CHAHUA_SESSION', uid: null });
  const next = worker([], { dbFactory: first.dbFactory });
  await next.push(payload);
  assert.equal(next.shown.length, 0);
});

test('failed display is not persisted as a handled message', async () => {
  const first = worker([], { failShow: true });
  await first.push(payload);
  const second = worker([], { dbFactory: first.dbFactory });
  await second.push(payload);
  assert.equal(second.shown.length, 1);
});

test('opens a legacy notification using its message IDs when no page is running', async () => {
  const instance = worker();
  assert.equal(await instance.click({ ...payload.data, target: 'https://evil.example' }), true);
  assert.deepEqual(instance.opened, [
    'https://chat.example/chats/chat/90071992547409931/thread/90071992547409932#msg=90071992547409933',
  ]);
});

test('legacy notification focuses a warm page without navigating or reloading it', async () => {
  const instance = worker();
  const messages = [];
  let focused = false;
  instance.clients.push({
    visibilityState: 'hidden',
    focus: async () => {
      focused = true;
    },
    postMessage: (data) => messages.push(data),
  });
  await instance.click(payload.data);
  assert.equal(focused, true);
  assert.equal(instance.opened.length, 0);
  assert.equal(messages[0].type, 'NOTIFICATION_CLICK');
  assert.equal(messages[1].type, 'OPEN_NOTIFICATION_TARGET');
  assert.equal(await instance.click({ ...payload.data, onActionClick: {} }), false);
});

test('the first Angular account keeps upgrade-era notifications and adopts their IDs for deduplication', async () => {
  const notification = {
    data: payload.data,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  const instance = worker([notification]);
  await instance.command({ type: 'CHAHUA_SESSION', uid: 7 });
  assert.equal(notification.closed, false);
  await instance.push(payload);
  assert.equal(instance.shown.length, 0);
});
