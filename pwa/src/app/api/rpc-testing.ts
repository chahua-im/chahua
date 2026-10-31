import { InjectionToken, Injector, Service, inject, type Provider } from '@angular/core';
import { vi } from 'vitest';
import { RPC_WEBSOCKET_FACTORY, RpcTransport, type RpcWebSocketFactory } from './rpc-transport';

export interface RpcTestingOptions {
  readonly autoLifecycle?: boolean;
}

const RPC_TESTING_OPTIONS = new InjectionToken<RpcTestingOptions>('RPC_TESTING_OPTIONS', {
  factory: () => ({ autoLifecycle: true }),
});

interface CapturedRequest {
  readonly socket: RpcTestSocket;
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  return (
    leftKeys.length === Object.keys(rightObject).length &&
    leftKeys.every((key) => Object.hasOwn(rightObject, key) && sameJson(leftObject[key], rightObject[key]))
  );
}

export class RpcTestSocket {
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  private state = 0;

  constructor(
    readonly url: string,
    private readonly peer: RpcTestPeer,
  ) {}

  get readyState() {
    return this.state;
  }

  send(data: string): void {
    this.peer.capture(this, data);
  }

  close(): void {
    if (this.state === 3) return;
    this.state = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  open(): void {
    if (this.state !== 0) return;
    this.state = 1;
    this.onopen?.(new Event('open'));
  }

  receive(message: unknown): void {
    this.receiveRaw(JSON.stringify(message));
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

/** A captured client request whose response is explicitly controlled by the test. */
export class RpcTestRequest {
  private settled = false;

  constructor(
    private readonly peer: RpcTestPeer,
    private readonly request: CapturedRequest,
  ) {}

  get id() {
    return this.request.id;
  }

  get params() {
    return this.request.params;
  }

  flush(result: unknown): void {
    if (this.settled) throw new Error(`RPC request ${this.request.method} was already answered`);
    this.settled = true;
    this.peer.answer(this, { jsonrpc: '2.0', id: this.request.id, result });
  }

  error(code: number, message = 'RPC error', data?: unknown): void {
    if (this.settled) throw new Error(`RPC request ${this.request.method} was already answered`);
    this.settled = true;
    this.peer.answer(this, {
      jsonrpc: '2.0',
      id: this.request.id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  get method() {
    return this.request.method;
  }

  deliver(envelope: unknown): void {
    this.request.socket.receive(envelope);
  }
}

/**
 * A real WebSocket peer for transport and consumer tests. It records only wire
 * requests; tests explicitly decide every application response and notification.
 */
@Service()
export class RpcTestPeer {
  private readonly injector = inject(Injector);
  private readonly options = inject(RPC_TESTING_OPTIONS);
  private readonly sockets: RpcTestSocket[] = [];
  private readonly captured: CapturedRequest[] = [];
  private readonly claimed = new Set<RpcTestRequest>();

  readonly websocketFactory: RpcWebSocketFactory = (url) => {
    const socket = new RpcTestSocket(url, this);
    this.sockets.push(socket);
    return socket;
  };

  get latest(): RpcTestSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('No RPC socket has been created');
    return socket;
  }

  authenticate(options: { uid?: number; clientId?: string } = {}): void {
    this.injector
      .get(RpcTransport)
      .open({ token: 'fixture-token', appVersion: 'test' })
      .subscribe({
        error: (error: unknown) => {
          throw error;
        },
      });
    this.open();
    this.expect('session.open').flush({
      protocolVersion: 1,
      authenticated: true,
      uid: options.uid ?? 1,
      clientId: options.clientId ?? 'fixture-client',
    });
  }

  open(): void {
    this.latest.open();
  }

  expect(
    method: string,
    paramsOrPredicate?: Record<string, unknown> | ((params: Record<string, unknown>) => boolean),
  ): RpcTestRequest {
    const index = this.captured.findIndex((request) => {
      if (request.method !== method) return false;
      if (!paramsOrPredicate) return true;
      const params = request.params ?? {};
      return typeof paramsOrPredicate === 'function' ? paramsOrPredicate(params) : sameJson(params, paramsOrPredicate);
    });
    if (index < 0) throw new Error(`Expected RPC request ${method}`);
    return this.claim(this.captured.splice(index, 1)[0]);
  }

  /** Waits for an explicitly selected request across asynchronous consumer work. */
  async expectAsync(
    method: string,
    paramsOrPredicate?: Record<string, unknown> | ((params: Record<string, unknown>) => boolean),
  ): Promise<RpcTestRequest> {
    return vi.waitFor(() => this.expect(method, paramsOrPredicate), { interval: 1 });
  }

  match(method: string): RpcTestRequest[] {
    const matches: RpcTestRequest[] = [];
    for (let index = this.captured.length - 1; index >= 0; index--) {
      if (this.captured[index].method === method) matches.unshift(this.claim(this.captured.splice(index, 1)[0]));
    }
    return matches;
  }

  expectNone(method: string): void {
    if (this.captured.some((request) => request.method === method)) throw new Error(`Unexpected RPC request ${method}`);
  }

  notify(method: string, params?: unknown): void {
    this.latest.receive({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  disconnect(): void {
    this.latest.close();
  }

  verify(): void {
    if (this.captured.length)
      throw new Error(`Unexpected RPC requests: ${this.captured.map((request) => request.method).join(', ')}`);
    if (this.claimed.size)
      throw new Error(`Unanswered RPC requests: ${[...this.claimed].map((request) => request.method).join(', ')}`);
  }

  capture(socket: RpcTestSocket, wire: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(wire);
    } catch {
      throw new Error(`Client sent invalid JSON: ${wire}`);
    }
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      throw new Error(`Client sent an invalid JSON-RPC request: ${wire}`);
    }
    const requestEnvelope = envelope as Record<string, unknown>;
    if (
      requestEnvelope['jsonrpc'] !== '2.0' ||
      typeof requestEnvelope['id'] !== 'string' ||
      typeof requestEnvelope['method'] !== 'string' ||
      (Object.hasOwn(requestEnvelope, 'params') &&
        (typeof requestEnvelope['params'] !== 'object' ||
          requestEnvelope['params'] === null ||
          Array.isArray(requestEnvelope['params'])))
    )
      throw new Error(`Client sent an invalid JSON-RPC request: ${wire}`);
    const request: CapturedRequest = {
      socket,
      id: requestEnvelope['id'],
      method: requestEnvelope['method'],
      ...(Object.hasOwn(requestEnvelope, 'params')
        ? { params: requestEnvelope['params'] as Record<string, unknown> }
        : {}),
    };
    if (
      this.options.autoLifecycle !== false &&
      (request.method === 'session.ping' || request.method === 'session.setAppState')
    ) {
      socket.receive({ jsonrpc: '2.0', id: request.id, result: null });
      return;
    }
    this.captured.push(request);
  }

  answer(request: RpcTestRequest, envelope: unknown): void {
    if (!this.claimed.delete(request)) throw new Error(`RPC request ${request.method} is not pending`);
    request.deliver(envelope);
  }

  private claim(request: CapturedRequest): RpcTestRequest {
    const claimed = new RpcTestRequest(this, request);
    this.claimed.add(claimed);
    return claimed;
  }
}

/** Installs the controllable socket before RpcTransport can be constructed. */
export function provideRpcTesting(options: RpcTestingOptions = {}): Provider[] {
  return [
    { provide: RPC_TESTING_OPTIONS, useValue: { autoLifecycle: options.autoLifecycle ?? true } },
    RpcTestPeer,
    {
      provide: RPC_WEBSOCKET_FACTORY,
      useFactory: (peer: RpcTestPeer) => peer.websocketFactory,
      deps: [RpcTestPeer],
    },
  ];
}
