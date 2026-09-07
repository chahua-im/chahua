import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/push-worker.js', import.meta.url), 'utf8');
function worker() {
  const listeners = new Map();
  const shown = [];
  const badges = [];
  const errors = [];
  const imports = [];
  const context = {
    URL,
    console: { error: (...args) => errors.push(args) },
    importScripts: (url) => imports.push(url),
    self: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      registration: { scope: 'https://chat.example/', showNotification: async (...args) => shown.push(args) },
      navigator: { setAppBadge: async (value) => badges.push(value), clearAppBadge: async () => badges.push(0) },
    },
  };
  vm.runInNewContext(source, context);
  return {
    shown,
    badges,
    errors,
    imports,
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
  assert.equal(notification.data.onActionClick.default.operation, 'navigateLastFocusedOrOpen');
  assert.equal(notification.data.onActionClick.default.url, 'chats/chat/90071992547409931/thread/90071992547409932');
  assert.deepEqual(instance.badges, [3]);
});

test('normal chat notifications open the current Angular chat route and zero unread clears the badge', async () => {
  const instance = worker();
  await instance.push({ ...payload, unreadCount: 0, data: { chatId: '42', messageId: '43' } });
  assert.equal(instance.shown[0][1].data.onActionClick.default.url, 'chats/chat/42');
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
