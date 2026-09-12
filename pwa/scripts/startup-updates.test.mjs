import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = html.match(/<script id="startup-updates">([\s\S]*?)<\/script>/)[1];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function target() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

function page({
  installed = true,
  manifest = { configVersion: 1, hashTable: {} },
  saved = new Map(),
  complete = true,
  claim = true,
} = {}) {
  const window = target();
  const document = Object.assign(target(), { hidden: false });
  const messages = [];
  const registrations = [];
  const requests = [];
  const timers = new Set();
  const intervals = [];
  let reloads = 0;
  let offline = false;
  let updates = 0;
  const serviceWorker = Object.assign(target(), {
    getRegistration: async () => (installed ? registration : undefined),
    register: async (...args) => {
      registrations.push(args);
      if (claim) serviceWorker.controller = active;
      return registration;
    },
  });
  const active = {
    postMessage(message) {
      messages.push(message);
      if (complete) serviceWorker.emit('message', { data: { type: 'OPERATION_COMPLETED', nonce: message.nonce } });
    },
  };
  const registration = { active, update: async () => updates++ };
  serviceWorker.controller = installed ? active : undefined;
  vm.runInNewContext(source, {
    window,
    document,
    navigator: { serviceWorker },
    location: { reload: () => reloads++ },
    sessionStorage: { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    AbortSignal,
    fetch: async (...args) => {
      requests.push(args);
      if (offline) throw new Error('offline');
      return { json: async () => manifest };
    },
    setInterval: (handler, delay) => intervals.push({ handler, delay }),
    setTimeout: (handler, delay) => {
      const timer = { handler, delay };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  });
  return {
    window,
    document,
    serviceWorker,
    messages,
    registrations,
    requests,
    intervals,
    timers,
    get reloads() {
      return reloads;
    },
    get updates() {
      return updates;
    },
    claim() {
      serviceWorker.controller = active;
      serviceWorker.emit('controllerchange');
    },
    set offline(value) {
      offline = value;
    },
    version(type, hash = 'new') {
      serviceWorker.emit('message', { data: { type, currentVersion: { hash: 'old' }, latestVersion: { hash } } });
    },
  };
}

test('checks independently of Angular and recovers a page whose application never starts', async () => {
  assert.ok(html.indexOf('id="startup-updates"') < html.indexOf('<style>'));
  const instance = page();
  await flush();
  assert.equal(instance.messages[0].action, 'CHECK_FOR_UPDATES');
  assert.equal(instance.updates, 1);
  assert.equal(instance.reloads, 0);
  instance.intervals[0].handler();
  await flush();
  assert.equal(instance.messages.length, 2);
  instance.version('VERSION_READY');
  assert.equal(instance.reloads, 1);
});

test('refreshes landing automatically but never interrupts an interactive application', async () => {
  const instance = page();
  await flush();
  instance.window.chahuaUpdates.setInteractive(true);
  instance.version('VERSION_READY');
  assert.equal(instance.window.chahuaUpdates.latestVersion, 'new');
  assert.equal(instance.reloads, 0);
  instance.window.chahuaUpdates.setInteractive(false);
  assert.equal(instance.reloads, 1);
});

test('only applies fully downloaded versions and prevents repeated reloads for the same release', async () => {
  const saved = new Map([['chahua.update.reloaded', 'new']]);
  const instance = page({ saved });
  await flush();
  instance.version('VERSION_DETECTED');
  instance.version('VERSION_INSTALLATION_FAILED');
  assert.equal(instance.reloads, 0);
  instance.version('VERSION_READY');
  assert.equal(instance.reloads, 0);
  instance.version('VERSION_READY', 'newer');
  instance.version('VERSION_READY', 'newer');
  assert.equal(instance.reloads, 1);
});

test('registers the production worker without bootstrapping Angular', async () => {
  const instance = page({ installed: false });
  await flush();
  assert.equal(instance.requests[0][0], 'ngsw.json?ngsw-bypass=true');
  assert.equal(instance.requests[0][1].cache, 'no-store');
  assert.equal(instance.registrations[0][0], 'serviceWorker.js');
  assert.equal(instance.registrations[0][1].updateViaCache, 'none');
  assert.equal(instance.requests[1][0], 'manifest.webmanifest');
  assert.equal(instance.messages.length, 1);
});

test('does not install a worker for a development server without a production manifest', async () => {
  const instance = page({ installed: false, manifest: {} });
  await flush();
  assert.equal(instance.registrations.length, 0);
  assert.equal(instance.messages.length, 0);
});

test('waits for the first worker to control the page before associating and checking its version', async () => {
  const instance = page({ installed: false, claim: false });
  await flush();
  assert.equal(instance.messages.length, 0);
  instance.claim();
  await flush();
  assert.equal(instance.requests[1][0], 'manifest.webmanifest');
  assert.equal(instance.messages.length, 1);
});

test('retries after network failure and checks again when returning to the foreground', async () => {
  const instance = page({ installed: false });
  instance.offline = true;
  await flush();
  assert.equal(instance.registrations.length, 0);
  instance.offline = false;
  instance.window.emit('online');
  await flush();
  assert.equal(instance.registrations.length, 1);
  instance.document.hidden = true;
  await instance.intervals[0].handler();
  assert.equal(instance.messages.length, 1);
  instance.document.hidden = false;
  instance.document.emit('visibilitychange');
  await flush();
  assert.equal(instance.messages.length, 2);
});

test('avoids overlapping checks and retries when the worker fails to answer', async () => {
  const instance = page({ complete: false });
  await flush();
  instance.window.emit('online');
  await flush();
  assert.equal(instance.messages.length, 1);
  for (const timer of [...instance.timers]) timer.handler();
  await flush();
  instance.document.emit('visibilitychange');
  await flush();
  assert.equal(instance.messages.length, 2);
});

test('only finishes a check when the worker answers its matching operation', async () => {
  const instance = page({ complete: false });
  await flush();
  instance.serviceWorker.emit('message', { data: { type: 'OPERATION_COMPLETED', nonce: 'another-check' } });
  await flush();
  instance.window.emit('online');
  await flush();
  assert.equal(instance.messages.length, 1);

  instance.serviceWorker.emit('message', {
    data: { type: 'OPERATION_COMPLETED', nonce: instance.messages[0].nonce },
  });
  await flush();
  instance.window.emit('online');
  await flush();
  assert.equal(instance.messages.length, 2);
});
