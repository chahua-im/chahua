import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/push-worker.js', import.meta.url), 'utf8');
function worker(existing = []) {
  const listeners = new Map();
  const shown = [];
  const badges = [];
  const errors = [];
  const imports = [];
  const notifications = [...existing];
  const context = {
    URL,
    console: { error: (...args) => errors.push(args) },
    importScripts: (url) => imports.push(url),
    self: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      registration: {
        scope: 'https://chat.example/',
        getNotifications: async () => notifications.filter((n) => !n.closed),
        showNotification: async (title, options) => {
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
    shown,
    badges,
    errors,
    imports,
    notifications,
    command: (data) => {
      let pending;
      const response = [];
      listeners.get('message')({
        data,
        ports: [{ postMessage: (value) => response.push(value) }],
        waitUntil: (value) => (pending = value),
      });
      return pending.then(() => response[0]);
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
    'chats/chat/90071992547409931/thread/90071992547409932?message=90071992547409933',
  );
  assert.deepEqual(instance.badges, [3]);
});

test('normal chat notifications open the current Angular chat route and zero unread clears the badge', async () => {
  const instance = worker();
  await instance.push({ ...payload, unreadCount: 0, data: { chatId: '42', messageId: '43' } });
  assert.equal(instance.shown[0][1].data.onActionClick.default.url, 'chats/chat/42?message=43');
  assert.deepEqual(instance.badges, [0]);
});

test('does not duplicate native Angular payloads and never accepts an external navigation target', async () => {
  const instance = worker();
  await instance.push({ notification: { title: 'native' } });
  assert.equal(instance.shown.length, 0);
  await instance.push({ ...payload, data: { chatId: '//evil.example', target: 'https://evil.example' } });
  assert.equal(instance.shown[0][1].data.onActionClick.default.url, 'chats');
});

test('contains malformed payload failures without rejecting the service worker event', async () => {
  const instance = worker();
  await instance.push({ type: 'newMessage', title: 'invalid' });
  assert.equal(instance.errors.length, 1);
  assert.equal(instance.shown.length, 0);
});

test('deduplicates concurrent local notification and Push delivery in either order', async () => {
  for (const pushFirst of [false, true]) {
    const instance = worker();
    const local = () => instance.command({ type: 'CHAHUA_NOTIFY', payload, foreground: false });
    const push = () => instance.push(payload);
    await Promise.all(pushFirst ? [push(), local()] : [local(), push()]);
    assert.equal(instance.shown.length, 1);
  }
});

test('foreground claims suppress a delayed Push without suppressing other older message IDs', async () => {
  const instance = worker();
  assert.equal(await instance.command({ type: 'CHAHUA_NOTIFY', payload, foreground: true }), true);
  await instance.push(payload);
  assert.equal(instance.shown.length, 0);
  await instance.push({ ...payload, data: { ...payload.data, messageId: '90071992547409930' } });
  assert.equal(instance.shown.length, 1);
});

test('a Push shown first prevents a duplicate foreground banner', async () => {
  const instance = worker();
  await instance.push(payload);
  assert.equal(await instance.command({ type: 'CHAHUA_NOTIFY', payload, foreground: true }), false);
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
