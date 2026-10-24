import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = html.match(/<script id="startup-recovery">([\s\S]*?)<\/script>/)[1];

function page(locale = 'zh-CN') {
  const dom = new JSDOM(html, { url: 'https://chat.example', runScripts: 'outside-only' });
  const { window } = dom;
  const timers = new Map();
  window.setTimeout = (callback, delay) => {
    timers.set(callback, delay);
    return callback;
  };
  window.clearTimeout = (callback) => timers.delete(callback);
  window.localStorage.setItem('chahua.preferences.locale', locale);
  window.eval(source);
  return { dom, window, timers, document: window.document };
}

test('embedded startup copy matches the application catalogs', async () => {
  const dom = new JSDOM(html);
  const embedded = JSON.parse(dom.window.document.getElementById('startup-copy').textContent);
  for (const locale of ['en', 'zh-CN', 'zh-TW']) {
    const { app } = JSON.parse(await readFile(new URL(`../src/i18n/${locale}.json`, import.meta.url), 'utf8'));
    const { reload, boot, bootSlow, bootFailed } = app.entry;
    assert.deepEqual(embedded[locale], { reload, boot, bootSlow, bootFailed });
  }
  dom.window.close();
});

test('startup offers reload after ten seconds without requiring Angular or a catalog fetch', () => {
  const { dom, document, timers } = page();
  assert.equal(document.getElementById('startup-title').textContent, '');
  assert.ok(document.querySelector('.startup-brand'));
  assert.equal(document.querySelector('.startup-spinner').hidden, false);
  assert.equal(document.getElementById('startup-reload').hidden, true);
  const [[callback, delay]] = timers;
  assert.equal(delay, 10000);
  callback();
  assert.equal(document.getElementById('startup-title').textContent, '加载时间较长');
  assert.equal(document.getElementById('startup-reload').hidden, false);
  dom.window.close();
});

test('a bundle error offers recovery and stops the slow-loading timer', () => {
  const { dom, window, document, timers } = page();
  const script = document.createElement('script');
  document.body.append(script);
  script.dispatchEvent(new window.Event('error'));
  assert.equal(document.getElementById('startup-title').textContent, '应用加载遇到问题');
  assert.equal(document.querySelector('.startup-spinner').hidden, true);
  assert.equal(document.getElementById('startup-reload').hidden, false);
  assert.equal(timers.size, 0);
  dom.window.close();
});

test('bootstrap rejection remains visible even if Angular has emptied its root', () => {
  const { dom, window, document } = page('en');
  document.querySelector('app-root').replaceChildren();
  window.chahuaStartup.fail();
  assert.equal(document.getElementById('startup-title').textContent, 'Unable to load the app');
  dom.window.close();
});

test('successful bootstrap removes recovery and ignores later application errors', () => {
  const { dom, window, document, timers } = page('zh-TW');
  assert.equal(document.getElementById('startup-title').textContent, '');
  const [[callback]] = timers;
  callback();
  assert.equal(document.getElementById('startup-title').textContent, '載入時間較長');
  window.chahuaStartup.finish();
  window.chahuaStartup.fail();
  assert.equal(document.getElementById('startup-screen'), null);
  assert.equal(timers.size, 0);
  dom.window.close();
});
