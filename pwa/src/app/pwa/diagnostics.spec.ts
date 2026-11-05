import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { Diagnostics, diagnosticUrl } from './diagnostics';
import { RpcError, RpcErrorCode, RpcTransportError } from '../api/rpc-error';

interface Report {
  events: { event: string; count: number; details: Record<string, unknown> }[];
  workerEvents: { event: string; details: Record<string, unknown> }[];
  worker: Record<string, unknown>;
}
const key = 'chahua.diagnostics';
const readReport = async (diagnostics: Diagnostics) => JSON.parse(await diagnostics.export()) as Report;

class Port {
  onmessage?: (event: { data: unknown }) => void;
  peer?: Port;
  close() {}
  postMessage(data: unknown) {
    this.peer?.onmessage?.({ data });
  }
}
class Channel {
  port1 = new Port();
  port2 = new Port();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

beforeEach(() => {
  sessionStorage.removeItem(key);
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'diagnostics-test' });
});
afterEach(() => {
  TestBed.resetTestingModule();
  sessionStorage.removeItem(key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('retains RPC correlation and error codes without credentials, payloads or arbitrary error messages', async () => {
  const diagnostics = TestBed.inject(Diagnostics);
  const error = new RpcError(RpcErrorCode.Unavailable, 'private message text token=secret', {
    token: 'secret',
    message: 'private body',
  });
  diagnostics.correlate(error, { method: 'messages.list', requestId: '12', epoch: 4 });
  diagnostics.recordError('conversation.open.failed', error, {
    chatId: '123',
    url: 'https://user:password@chat.example/chats/join/456?token=secret#private',
  });
  const report = await readReport(diagnostics);
  const entry = report.events.find((value) => value.event === 'conversation.open.failed')!;
  expect(entry.details).toMatchObject({
    method: 'messages.list',
    requestId: '12',
    epoch: 4,
    errorName: 'RpcError',
    errorCode: RpcErrorCode.Unavailable,
    chatId: '123',
    url: 'https://chat.example/chats/join/[redacted]',
  });
  expect(JSON.stringify(report)).not.toMatch(/password|secret|private message|private body/);
});

it.each([
  ['https://chat.example/chats/chat/123?token=secret#message', 'https://chat.example/chats/chat/123'],
  ['https://chat.example/chats/%6Aoin/123', 'https://chat.example/chats/join/[redacted]'],
  ['https://chat.example/invite/settings', 'https://chat.example/invite/[redacted]'],
  ['https://media.example/my-private-file.jpg?signature=secret', 'https://media.example/[redacted]'],
])('redacts sensitive URL values in %s', (url, expected) => expect(diagnosticUrl(url)).toBe(expected));

it('coalesces repeated resize errors and bounds the report retained across reloads', async () => {
  let diagnostics = TestBed.inject(Diagnostics);
  diagnostics.setAccount(1);
  for (let index = 0; index < 200; index++)
    diagnostics.recordError('page.error', new Error('ResizeObserver loop completed with undelivered notifications.'));
  let report = await readReport(diagnostics);
  expect(report.events.find((entry) => entry.event === 'page.error')).toMatchObject({
    count: 200,
    details: { errorMessage: 'ResizeObserver loop' },
  });
  for (let index = 0; index < 200; index++) diagnostics.record('rpc.sent', { requestId: String(index) });
  await diagnostics.export();
  expect(sessionStorage.getItem(key)!.length).toBeLessThanOrEqual(48 * 1024);
  TestBed.resetTestingModule();
  diagnostics = TestBed.inject(Diagnostics);
  diagnostics.setAccount(1);
  report = await readReport(diagnostics);
  expect(report.events.length).toBeLessThanOrEqual(120);
  expect(report.events.find((entry) => entry.details['requestId'] === '199')).toBeDefined();
  expect(report.events.some((entry) => entry.details['requestId'] === '0')).toBe(false);
  diagnostics.setAccount(2);
  expect((await readReport(diagnostics)).events).toEqual([]);
});

it('keeps diagnostics usable when session storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
  const diagnostics = TestBed.inject(Diagnostics);
  diagnostics.recordError('conversation.open.failed', new RpcTransportError('timeout'));
  expect(
    (await readReport(diagnostics)).events.find((entry) => entry.event === 'conversation.open.failed')?.details,
  ).toMatchObject({ errorName: 'RpcTransportError', errorKind: 'timeout' });
});

it('exports sanitized worker request metadata and a structured driver snapshot, not raw debug text', async () => {
  vi.stubGlobal('MessageChannel', Channel);
  const controller = {
    scriptURL: 'https://chat.example/serviceWorker.js?token=secret',
    state: 'activated',
    postMessage: (_message: unknown, ports: Port[]) =>
      ports[0].postMessage({
        events: [
          {
            at: 123,
            event: 'fetch-rejected',
            details: {
              url: 'https://chat.example/chats/chat/123?token=secret',
              mode: 'same-origin',
              cache: 'only-if-cached',
              destination: '',
              accept: 'text/html',
              errorName: 'TypeError',
              count: 2,
            },
          },
        ],
      }),
  };
  vi.stubGlobal('navigator', {
    onLine: true,
    userAgent: 'diagnostics-test',
    serviceWorker: {
      controller,
      getRegistration: async () => ({ active: controller, scope: 'https://chat.example/' }),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          'Driver state: EXISTING_CLIENTS_ONLY (Degraded due to: private text token=secret)\nLatest manifest hash: ' +
            'a'.repeat(40) +
            '\nClients: private-client\n',
        ),
    ),
  );
  vi.stubGlobal('caches', { match: async () => new Response('index') });
  const report = await readReport(TestBed.inject(Diagnostics));
  expect(report.worker).toMatchObject({
    controller: 'https://chat.example/serviceWorker.js',
    driverState: 'EXISTING_CLIENTS_ONLY',
    driverReason: 'degraded',
    latestManifest: 'a'.repeat(40),
    cachedIndex: true,
  });
  expect(report.workerEvents[0].details).toMatchObject({
    url: 'https://chat.example/chats/chat/123',
    mode: 'same-origin',
    cache: 'only-if-cached',
    errorName: 'TypeError',
    count: 2,
  });
  expect(JSON.stringify(report)).not.toMatch(/secret|private text|private-client/);
});

it('does not restore a late old-account worker snapshot after account switching', async () => {
  vi.stubGlobal('MessageChannel', Channel);
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let reply: Port | undefined;
  let changed = false;
  const controller = {
    scriptURL: 'https://chat.example/serviceWorker.js',
    state: 'activated',
    postMessage: (message: { action: string }, ports: Port[]) => {
      if (message.action === 'snapshot' && !changed) {
        reply = ports[0];
        ready();
      } else ports[0].postMessage({ events: [] });
    },
  };
  vi.stubGlobal('navigator', {
    onLine: true,
    userAgent: 'diagnostics-test',
    serviceWorker: {
      controller,
      getRegistration: async () => ({ active: controller, scope: 'https://chat.example/' }),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  );
  const diagnostics = TestBed.inject(Diagnostics);
  diagnostics.setAccount(1);
  const capture = diagnostics.captureWorker();
  await waiting;
  changed = true;
  diagnostics.setAccount(2);
  reply!.postMessage({
    events: [{ at: 123, event: 'fetch-rejected', details: { url: 'https://chat.example/chats/chat/111' } }],
  });
  await capture;
  expect((await readReport(diagnostics)).workerEvents).toEqual([]);
});

it('bounds worker inspection so a stuck worker cannot block report export', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {
    onLine: true,
    userAgent: 'diagnostics-test',
    serviceWorker: {
      getRegistration: () => new Promise<never>(() => {}),
    },
  });
  const report = TestBed.inject(Diagnostics).export();
  await vi.advanceTimersByTimeAsync(1800);
  expect(JSON.parse(await report).appVersion).toBeDefined();
});

it('starts asynchronous clipboard writing during the click rather than after worker inspection', async () => {
  let release!: (value: undefined) => void;
  const registration = new Promise<undefined>((resolve) => {
    release = resolve;
  });
  const write = vi.fn(async () => {});
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    },
  );
  vi.stubGlobal('navigator', {
    onLine: true,
    userAgent: 'diagnostics-test',
    clipboard: { write },
    serviceWorker: { getRegistration: () => registration },
  });
  const copy = TestBed.inject(Diagnostics).copy();
  expect(write).toHaveBeenCalledOnce();
  release(undefined);
  await copy;
});

it('does not restore old-account failures when rejected requests settle after switching accounts', async () => {
  const diagnostics = TestBed.inject(Diagnostics);
  diagnostics.setAccount(1);
  const error = new RpcTransportError('disconnected');
  diagnostics.correlate(error, { epoch: 3 });
  const settled = Promise.resolve().then(() => diagnostics.recordError('conversation.open.failed', error));
  diagnostics.setAccount(2);
  await settled;
  expect((await readReport(diagnostics)).events).toEqual([]);
});
