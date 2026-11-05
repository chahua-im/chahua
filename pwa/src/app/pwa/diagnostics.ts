import { DestroyRef, inject, Service } from '@angular/core';
import { appVersion } from '../app-version';
import { copyText } from '../api/clipboard';

export type DiagnosticDetails = Record<string, string | number | boolean | null | undefined>;
interface DiagnosticEntry {
  at: number;
  lastAt: number;
  count: number;
  event: string;
  details: DiagnosticDetails;
}
const STORAGE_KEY = 'chahua.diagnostics';
const MAX_ENTRIES = 120;
const MAX_STORAGE = 48 * 1024;
const detailKeys: Record<string, true> = Object.fromEntries(
  'operation method requestId epoch state previousState reason errorName errorCode errorKind errorStatus errorMessage stack url route source line column durationMs sent pending queued reconnectAttempt reconnectInMs closeCode wasClean chatId threadId direction controller active waiting installing controllerState activeState waitingState installingState supported cachedIndex driverState driverReason latestManifest hash scope status cache mode destination accept count online visibility appVersion'
    .split(' ')
    .map((key) => [key, true] as const),
);
const urlKeys: Record<string, true> = {
  url: true,
  route: true,
  source: true,
  controller: true,
  active: true,
  waiting: true,
  installing: true,
  scope: true,
};
const pathWords: Record<string, true> = Object.fromEntries(
  'chats chat thread threads message messages profile settings notifications privacy general language saved pins archived friends groups _api ws landing m join invite info i18n icon icon-maskable media emoji .well-known ngsw state ngsw.json ngsw-worker.js serviceWorker.js manifest.webmanifest index.html en.json zh-CN.json zh-TW.json'
    .split(' ')
    .map((key) => [key, true] as const),
);

/** Keep route/asset identity, not credentials, invite codes, filenames or search values. */
export function diagnosticUrl(value: string): string {
  try {
    const url = new URL(value, location.origin);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '[redacted]';
    const parts = url.pathname
      .split('/')
      .slice(0, 13)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return '[redacted]';
        }
      });
    const path = parts
      .map((part, index) => {
        if (!part) return part;
        if (parts[index - 1] === 'join' || parts[index - 1] === 'invite') return '[redacted]';
        if (
          Object.hasOwn(pathWords, part) ||
          /^\d{1,20}$/.test(part) ||
          /^(?:main|chunk|styles)-[\w-]{8,32}\.(?:js|css)$/.test(part)
        )
          return part;
        return '[redacted]';
      })
      .join('/');
    return `${url.origin}${path}`.slice(0, 512);
  } catch {
    return '[redacted]';
  }
}

function errorMessage(message: string): string | undefined {
  if (['Network fetch failed', 'Cannot read properties', 'Cannot set properties'].includes(message)) return message;
  if (message.startsWith('ResizeObserver loop')) return 'ResizeObserver loop';
  if (/^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/.test(message))
    return 'Network fetch failed';
  if (message.startsWith('Cannot read properties of ')) return 'Cannot read properties';
  if (message.startsWith('Cannot set properties of ')) return 'Cannot set properties';
  if (message === 'Account changed') return message;
  return undefined;
}

function sourceFrames(stack: string): string {
  return [...stack.matchAll(/(?:https?|file):\/\/[^\s)]+:\d+:\d+/g)]
    .slice(0, 6)
    .map(([frame]) => {
      const match = frame.match(/^(.*):(\d+):(\d+)$/)!;
      return `${diagnosticUrl(match[1])}:${match[2]}:${match[3]}`;
    })
    .join('\n');
}

/** Never serialize an Error's arbitrary message/data: RPC errors can contain user content. */
export function diagnosticError(error: unknown): DiagnosticDetails {
  if (error == null || typeof error !== 'object') return { errorName: typeof error };
  const name = 'name' in error ? error.name : undefined;
  const code = 'code' in error ? error.code : undefined;
  const kind = 'kind' in error ? error.kind : undefined;
  const status = 'status' in error ? error.status : undefined;
  const message = 'message' in error ? error.message : undefined;
  const stack = 'stack' in error ? error.stack : undefined;
  return {
    errorName: typeof name === 'string' && /^[A-Za-z][\w.]{0,63}$/.test(name) ? name : 'Error',
    errorCode: typeof code === 'number' ? code : undefined,
    errorKind:
      typeof kind === 'string' && ['disconnected', 'timeout', 'overloaded', 'protocol'].includes(kind)
        ? kind
        : undefined,
    errorStatus: typeof status === 'number' ? status : undefined,
    errorMessage: typeof message === 'string' ? errorMessage(message) : undefined,
    stack: typeof stack === 'string' ? sourceFrames(stack) : undefined,
  };
}

function cleanDetails(details: object): DiagnosticDetails {
  const result: DiagnosticDetails = {};
  const fields: [string, unknown][] = Object.entries(details);
  for (const [key, value] of fields) {
    if (!Object.hasOwn(detailKeys, key) || value == null) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) result[key] = value;
    } else if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'string') {
      if (Object.hasOwn(urlKeys, key)) result[key] = diagnosticUrl(value);
      else if (key === 'stack') result[key] = sourceFrames(value);
      else if (key === 'errorMessage') result[key] = errorMessage(value);
      else if (/^[\w .:/-]*$/.test(value) && !/eyJ[\w-]+\./.test(value)) result[key] = value.slice(0, 160);
    }
  }
  return result;
}

function readEntries(value: unknown): DiagnosticEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_ENTRIES).flatMap((item: unknown) => {
    if (
      item == null ||
      typeof item !== 'object' ||
      !('at' in item) ||
      typeof item.at !== 'number' ||
      !Number.isFinite(item.at) ||
      !('event' in item) ||
      typeof item.event !== 'string' ||
      !/^[\w.-]{1,80}$/.test(item.event) ||
      !('details' in item) ||
      item.details == null ||
      typeof item.details !== 'object'
    )
      return [];
    return [
      {
        at: item.at,
        lastAt:
          'lastAt' in item && typeof item.lastAt === 'number' && Number.isFinite(item.lastAt) ? item.lastAt : item.at,
        count:
          'count' in item && typeof item.count === 'number' && Number.isFinite(item.count)
            ? Math.max(1, item.count)
            : 1,
        event: item.event,
        details: cleanDetails(item.details),
      },
    ];
  });
}

@Service()
export class Diagnostics {
  private entries: DiagnosticEntry[] = [];
  private workerEvents: DiagnosticEntry[] = [];
  private worker: DiagnosticDetails = {};
  private connection: DiagnosticDetails = {};
  private account?: number;
  private accountGeneration = 0;
  private capturing?: Promise<void>;
  private captureGeneration = -1;
  private saveTimer?: number;
  private readonly correlations = new WeakMap<object, { generation: number; details: DiagnosticDetails }>();

  constructor() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored && stored.length <= MAX_STORAGE) {
        const saved: unknown = JSON.parse(stored);
        if (saved != null && typeof saved === 'object') {
          this.account = 'account' in saved && typeof saved.account === 'number' ? saved.account : undefined;
          this.entries = readEntries('entries' in saved ? saved.entries : undefined);
        }
      }
    } catch {
      /* Storage can be unavailable in private/embedded browsers. */
    }
    const error = (event: ErrorEvent) =>
      this.recordError('page.error', event.error ?? new Error(event.message), {
        source: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    const rejection = (event: PromiseRejectionEvent) => this.recordError('page.rejection', event.reason);
    const lifecycle = () => this.record('page.lifecycle');
    const save = () => this.persist();
    const workerChanged = () => {
      this.record('sw.controllerchange');
      void this.captureWorker();
    };
    const workerMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        data == null ||
        typeof data !== 'object' ||
        !('type' in data) ||
        typeof data.type !== 'string' ||
        !['VERSION_DETECTED', 'VERSION_READY', 'VERSION_INSTALLATION_FAILED', 'UNRECOVERABLE_STATE'].includes(data.type)
      )
        return;
      const version = 'latestVersion' in data ? data.latestVersion : 'version' in data ? data.version : undefined;
      const hash = version != null && typeof version === 'object' && 'hash' in version ? version.hash : undefined;
      this.record('sw.version', {
        state: data.type,
        hash: typeof hash === 'string' && /^[a-f0-9]{40}$/.test(hash) ? hash : undefined,
      });
      if (data.type === 'VERSION_INSTALLATION_FAILED' || data.type === 'UNRECOVERABLE_STATE') void this.captureWorker();
    };
    window.addEventListener('error', error);
    window.addEventListener('unhandledrejection', rejection);
    window.addEventListener('online', lifecycle);
    window.addEventListener('offline', lifecycle);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', lifecycle);
    navigator.serviceWorker?.addEventListener?.('controllerchange', workerChanged);
    navigator.serviceWorker?.addEventListener?.('message', workerMessage);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('error', error);
      window.removeEventListener('unhandledrejection', rejection);
      window.removeEventListener('online', lifecycle);
      window.removeEventListener('offline', lifecycle);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', lifecycle);
      navigator.serviceWorker?.removeEventListener?.('controllerchange', workerChanged);
      navigator.serviceWorker?.removeEventListener?.('message', workerMessage);
      window.clearTimeout(this.saveTimer);
      this.persist();
    });
    this.record('page.start');
  }

  setAccount(account: number | undefined) {
    if (this.account === account) return;
    if (this.account != null) {
      this.entries = [];
      this.connection = {};
      void this.workerCommand('clear').catch(() => {});
    }
    this.workerEvents = [];
    this.worker = {};
    this.accountGeneration++;
    this.account = account;
    this.persist();
  }

  correlate(error: object, details: DiagnosticDetails) {
    this.correlations.set(error, { generation: this.accountGeneration, details: cleanDetails(details) });
  }

  recordError(event: string, error: unknown, details: DiagnosticDetails = {}) {
    const correlation = error && typeof error === 'object' ? this.correlations.get(error) : undefined;
    if (correlation && correlation.generation !== this.accountGeneration) return;
    this.record(event, {
      ...correlation?.details,
      ...diagnosticError(error),
      ...details,
    });
  }

  record(event: string, details: DiagnosticDetails = {}) {
    const at = Date.now();
    const safe = cleanDetails({
      route: location.href,
      online: navigator.onLine,
      visibility: document.visibilityState,
      appVersion,
      ...details,
    });
    if (event === 'rpc.state') this.connection = safe;
    const signature = JSON.stringify(safe);
    let repeated: DiagnosticEntry | undefined;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (entry.event === event && at - entry.lastAt < 30_000 && JSON.stringify(entry.details) === signature) {
        repeated = entry;
        break;
      }
    }
    if (repeated) {
      repeated.lastAt = at;
      repeated.count++;
    } else this.entries.push({ at, lastAt: at, count: 1, event, details: safe });
    while (
      this.entries.length > MAX_ENTRIES ||
      JSON.stringify({ account: this.account, entries: this.entries }).length > MAX_STORAGE
    )
      this.entries.shift();
    if (this.saveTimer == null)
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = undefined;
        this.persist();
      }, 100);
  }

  captureWorker(): Promise<void> {
    const generation = this.accountGeneration;
    if (this.capturing && this.captureGeneration === generation) return this.capturing;
    this.captureGeneration = generation;
    let timer: number | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, 1800);
    });
    const capturing = Promise.race([this.inspectWorker(generation).catch(() => {}), deadline]).finally(() => {
      window.clearTimeout(timer);
      if (this.capturing === capturing) this.capturing = undefined;
    });
    this.capturing = capturing;
    return capturing;
  }

  private async inspectWorker(generation: number) {
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker?.getRegistration) {
      this.worker = { supported: false };
      return;
    }
    const registration = await serviceWorker.getRegistration();
    const snapshot: DiagnosticDetails = {
      supported: true,
      controller: serviceWorker.controller?.scriptURL,
      controllerState: serviceWorker.controller?.state,
      active: registration?.active?.scriptURL,
      activeState: registration?.active?.state,
      waiting: registration?.waiting?.scriptURL,
      waitingState: registration?.waiting?.state,
      installing: registration?.installing?.scriptURL,
      installingState: registration?.installing?.state,
    };
    if (generation !== this.accountGeneration) return;
    this.worker = cleanDetails(snapshot);
    if (!serviceWorker.controller || !registration) return;
    await Promise.all([
      this.workerCommand('snapshot')
        .then((value) => {
          if (generation === this.accountGeneration && value != null && typeof value === 'object' && 'events' in value)
            this.workerEvents = readEntries(value.events);
        })
        .catch(() => {}),
      (async () => {
        const response = await fetch(new URL('ngsw/state', registration.scope), {
          cache: 'no-store',
          signal: AbortSignal.timeout(1500),
        });
        if (!response.ok) return;
        const text = (await response.text()).slice(0, 24 * 1024);
        if (generation !== this.accountGeneration) return;
        this.worker['driverState'] = text.match(/^Driver state: (\w+)/m)?.[1];
        this.worker['latestManifest'] = text.match(/^Latest manifest hash: ([a-f0-9]{40})$/m)?.[1];
        this.worker['driverReason'] = /Initialization failed|failed initialization/.test(text)
          ? 'initialization-failed'
          : text.includes('Degraded due to:')
            ? 'degraded'
            : undefined;
      })().catch(() => {}),
      (async () => {
        if (!('caches' in window)) return;
        const index = await caches.match(new URL('index.html', registration.scope));
        if (generation === this.accountGeneration) this.worker['cachedIndex'] = !!index;
      })().catch(() => {}),
    ]);
  }

  private workerCommand(action: 'snapshot' | 'clear'): Promise<unknown> {
    const controller = navigator.serviceWorker?.controller;
    if (!controller || typeof MessageChannel === 'undefined') return Promise.resolve({ events: [] });
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => {
        channel.port1.close();
        reject(new Error('Worker diagnostics timeout'));
      }, 1500);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        channel.port1.close();
        resolve(event.data);
      };
      try {
        controller.postMessage({ type: 'CHAHUA_DIAGNOSTICS', action, uid: this.account ?? null }, [channel.port2]);
      } catch (error) {
        window.clearTimeout(timer);
        channel.port1.close();
        reject(error);
      }
    });
  }

  private report(): string {
    this.persist();
    return JSON.stringify(
      {
        version: 1,
        appVersion,
        capturedAt: new Date().toISOString(),
        environment: {
          route: diagnosticUrl(location.href),
          online: navigator.onLine,
          visibility: document.visibilityState,
          userAgent: navigator.userAgent.slice(0, 512),
        },
        connection: this.connection,
        worker: this.worker,
        events: this.entries,
        workerEvents: this.workerEvents,
      },
      null,
      2,
    );
  }

  async export(): Promise<string> {
    await this.captureWorker();
    return this.report();
  }

  copy(): Promise<void> {
    // Safari requires clipboard.write during the click, even when report collection is asynchronous.
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined')
      return navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': this.export().then((text) => new Blob([text], { type: 'text/plain' })) }),
      ]);
    const copied = copyText(this.report());
    void this.captureWorker();
    return copied;
  }

  private persist() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ account: this.account, entries: this.entries }));
    } catch {
      /* Diagnostics must never prevent normal application use. */
    }
  }
}
