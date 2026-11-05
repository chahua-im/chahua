import { DestroyRef, InjectionToken, inject, Service, signal } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { CHAHUA_BASE_URL } from '../../generated/endpoints/chahua.base-url';
import { rpcMethodClasses } from '../../generated/rpc-codecs';
import type { SessionOpenResult } from '../../generated/rpc-models';
import { RpcError, RpcErrorCode, RpcTransportError } from './rpc-error';
import { Diagnostics } from '../pwa/diagnostics';

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_STALE_MS = 90_000;
const FOREGROUND_STALE_MS = 30_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_ORDINARY_SENT = 16;
const MAX_ORDINARY_QUEUED = 64;
const MAX_CONTROL_PENDING = 8;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const utf8 = new TextEncoder();

type RpcMethodClass = 'read' | 'mutation' | 'session' | 'control';
type RpcLane = 'ordinary' | 'control';
type RpcSocketEvent = MessageEvent<unknown>;

interface RpcSocket {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: RpcSocketEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

export type RpcWebSocketFactory = (url: string) => RpcSocket;

export const RPC_WEBSOCKET_FACTORY = new InjectionToken<RpcWebSocketFactory>('RPC_WEBSOCKET_FACTORY', {
  providedIn: 'root',
  factory: (): RpcWebSocketFactory => (url) => new WebSocket(url),
});

export enum RpcConnectionState {
  Closed,
  Connecting,
  Anonymous,
  Authenticated,
  Reconnecting,
}

export interface RpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

interface PendingCall {
  readonly id: string;
  readonly method: string;
  readonly epoch: number;
  readonly startedAt: number;
  readonly wire: string;
  readonly bytes: number;
  readonly lane: RpcLane;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  timer: number;
  sent: boolean;
  active: boolean;
  abandoned: boolean;
}

interface Attempt {
  readonly epoch: number;
  readonly appVersion: string;
  readonly reconnect: boolean;
}

interface RpcResponseError {
  readonly code: RpcErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

function isRpcError(value: unknown): value is RpcResponseError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const error = value as { code?: unknown; message?: unknown };
  return typeof error.code === 'number' && typeof error.message === 'string';
}

function isSessionOpenResult(value: unknown): value is SessionOpenResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = value as { protocolVersion?: unknown; authenticated?: unknown; uid?: unknown; clientId?: unknown };
  if (result.protocolVersion !== PROTOCOL_VERSION || typeof result.authenticated !== 'boolean') return false;
  return !result.authenticated || (typeof result.uid === 'number' && typeof result.clientId === 'string');
}

/**
 * Owns the negotiated JSON-RPC socket. Application services deliberately sit above
 * this boundary so reconnect, request lifetime, and protocol errors have one owner.
 */
@Service()
export class RpcTransport {
  private readonly stateValue = signal(RpcConnectionState.Closed);
  readonly state = this.stateValue.asReadonly();
  private readonly stateChanges = new BehaviorSubject<RpcConnectionState>(RpcConnectionState.Closed);
  readonly state$ = this.stateChanges.asObservable();
  private readonly notifications = new Subject<RpcNotification>();
  readonly notifications$ = this.notifications.asObservable();
  private readonly foreground = new Subject<void>();
  readonly foreground$ = this.foreground.asObservable();

  private readonly baseUrl = inject(CHAHUA_BASE_URL);
  private readonly socketFactory = inject(RPC_WEBSOCKET_FACTORY);
  private readonly destroyRef = inject(DestroyRef);
  private readonly diagnostics = inject(Diagnostics);
  private socket?: RpcSocket;
  private attempt?: Attempt;
  private epoch = 0;
  private requestNumber = 0;
  private reconnectToken?: string;
  private reconnectTimer?: number;
  private heartbeatTimer?: number;
  private handshakeTimer?: number;
  private readonly pending = new Map<string, PendingCall>();
  private readonly ordinaryQueue: PendingCall[] = [];
  private readonly controlQueue: PendingCall[] = [];
  private ordinarySent = 0;
  private controlSent = false;
  private queuedBytes = 0;
  private retryAttempt = 0;
  private retryAllowed = false;
  private hasAuthenticatedSession = false;
  private pingOutstanding = false;
  private lastHeartbeat = 0;
  private drainingPending = false;
  private wasForeground = this.appIsForeground();
  private openSubscriber?: { epoch: number; next: (result: SessionOpenResult) => void; error: (error: Error) => void };

  constructor() {
    const lifecycleChanged = () => this.handleLifecycleChange();
    document.addEventListener('visibilitychange', lifecycleChanged);
    window.addEventListener('focus', lifecycleChanged);
    window.addEventListener('blur', lifecycleChanged);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', lifecycleChanged);
      window.removeEventListener('focus', lifecycleChanged);
      window.removeEventListener('blur', lifecycleChanged);
      this.close();
    });
  }

  open(options: { token?: string; appVersion: string }): Observable<SessionOpenResult> {
    return new Observable<SessionOpenResult>((subscriber) => {
      let settled = false;
      const epoch = this.beginOpen(options, {
        next: (result) => {
          if (settled) return;
          settled = true;
          subscriber.next(result);
          subscriber.complete();
        },
        error: (error) => {
          if (settled) return;
          settled = true;
          subscriber.error(error);
        },
      });
      return () => {
        if (!settled && this.openSubscriber?.epoch === epoch) this.cancelOpening(epoch);
      };
    });
  }

  call<T>(method: string, params?: object): Observable<T> {
    return new Observable<T>((subscriber) => {
      if (!this.canCall(method)) {
        const error = new RpcTransportError('disconnected', 'The RPC session is not authenticated');
        subscriber.error(this.admissionError(method, undefined, error));
        return;
      }
      const pending = this.createPending(
        method,
        params,
        (result) => {
          subscriber.next(result as T);
          subscriber.complete();
        },
        (error) => subscriber.error(error),
      );
      if (!pending) return;
      this.admit(pending);
      return () => this.detach(pending);
    });
  }

  close(): void {
    this.retryAllowed = false;
    this.reconnectToken = undefined;
    this.hasAuthenticatedSession = false;
    this.stopCurrent(new RpcTransportError('disconnected', 'The RPC transport was closed'), false);
  }

  /** Changes only the credential used by a future reconnect, never the live session. */
  setReconnectToken(token: string): void {
    this.reconnectToken = token;
  }

  private beginOpen(
    options: { token?: string; appVersion: string },
    subscriber: { next: (result: SessionOpenResult) => void; error: (error: Error) => void },
  ) {
    this.stopCurrent(new RpcTransportError('disconnected', 'A new RPC session was opened'), false);
    this.reconnectToken = options.token;
    this.retryAllowed = true;
    this.hasAuthenticatedSession = false;
    this.retryAttempt = 0;
    return this.createSocket(options.appVersion, false, subscriber);
  }

  private createSocket(
    appVersion: string,
    reconnect: boolean,
    subscriber?: { next: (result: SessionOpenResult) => void; error: (error: Error) => void },
  ) {
    const epoch = ++this.epoch;
    this.requestNumber = 0;
    this.attempt = { epoch, appVersion, reconnect };
    this.openSubscriber = subscriber && { epoch, ...subscriber };
    this.transition(reconnect ? RpcConnectionState.Reconnecting : RpcConnectionState.Connecting);
    let socket: RpcSocket;
    try {
      socket = this.socketFactory(this.socketUrl());
    } catch (error) {
      this.diagnostics.recordError('rpc.socket.failed', error, { epoch });
      const transportError = new RpcTransportError('disconnected', 'Unable to create the RPC socket');
      this.attempt = undefined;
      this.transition(RpcConnectionState.Closed);
      this.finishOpenError(epoch, transportError);
      return epoch;
    }
    this.socket = socket;
    this.handshakeTimer = window.setTimeout(() => {
      if (this.epoch === epoch)
        this.rejectSessionOpen(epoch, new RpcTransportError('timeout', 'RPC session.open timed out'));
    }, REQUEST_TIMEOUT_MS);
    socket.onopen = () => {
      if (!this.isCurrent(socket, epoch)) return;
      const pending = this.createPending(
        'session.open',
        {
          protocolVersion: PROTOCOL_VERSION,
          ...(this.reconnectToken == null ? {} : { token: this.reconnectToken }),
          appVersion,
        },
        (result) => this.acceptSessionOpen(epoch, result),
        (error) => this.rejectSessionOpen(epoch, error),
      );
      if (pending) this.admit(pending);
    };
    socket.onmessage = (event) => {
      if (this.isCurrent(socket, epoch)) this.handleMessage(event.data);
    };
    socket.onerror = () => {
      // WebSocket errors are followed by close in browsers. Keep the socket alive
      // until that close so a valid final frame is not discarded.
    };
    socket.onclose = (event) => {
      if (this.isCurrent(socket, epoch)) {
        this.diagnostics.record('rpc.close', { epoch, closeCode: event.code, wasClean: event.wasClean });
        this.handleSocketClose(epoch);
      }
    };
    return epoch;
  }

  private acceptSessionOpen(epoch: number, result: unknown): void {
    if (epoch !== this.epoch || !isSessionOpenResult(result)) {
      this.protocolFailure('Invalid session.open result');
      return;
    }
    this.clearHandshakeDeadline();
    this.lastHeartbeat = Date.now();
    if (result.authenticated) {
      this.hasAuthenticatedSession = true;
      this.retryAttempt = 0;
      this.transition(RpcConnectionState.Authenticated);
      this.sendAppState();
      this.startHeartbeat();
    } else {
      this.transition(RpcConnectionState.Anonymous);
    }
    const subscriber = this.openSubscriber;
    if (subscriber?.epoch === epoch) {
      this.openSubscriber = undefined;
      subscriber.next(result);
    }
  }

  private rejectSessionOpen(epoch: number, error: Error): void {
    if (epoch !== this.epoch) return;
    if (error instanceof RpcError && error.code === RpcErrorCode.Unauthorized) {
      this.retryAllowed = false;
      this.reconnectToken = undefined;
    }
    const retry =
      this.attempt?.reconnect === true && !(error instanceof RpcError && error.code === RpcErrorCode.Unauthorized);
    this.stopCurrent(error, retry);
  }

  private cancelOpening(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.openSubscriber = undefined;
    this.retryAllowed = false;
    this.stopCurrent(new RpcTransportError('disconnected', 'Opening the RPC session was cancelled'), false);
  }

  private canCall(method: string) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    if (this.state() === RpcConnectionState.Authenticated) return true;
    return this.state() === RpcConnectionState.Anonymous && method === 'auth.createDevSession';
  }

  private admissionError(method: string, requestId: string | undefined, error: Error): Error {
    const details = { method, requestId, epoch: this.epoch };
    this.diagnostics.correlate(error, details);
    this.diagnostics.recordError('rpc.rejected', error, details);
    return error;
  }

  private createPending(
    method: string,
    params: object | undefined,
    resolve: (result: unknown) => void,
    reject: (error: Error) => void,
  ): PendingCall | undefined {
    const id = String(++this.requestNumber);
    const wire = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    const bytes = utf8.encode(wire).byteLength;
    if (bytes > MAX_REQUEST_BYTES || this.queuedBytes + bytes > MAX_REQUEST_BYTES) {
      reject(this.admissionError(method, id, new RpcTransportError('overloaded', 'The RPC request queue is full')));
      return undefined;
    }
    const lane = this.laneFor(method);
    if (lane === 'control' && this.controlPendingCount() >= MAX_CONTROL_PENDING) {
      reject(this.admissionError(method, id, new RpcTransportError('overloaded', 'The RPC control queue is full')));
      return undefined;
    }
    if (
      lane === 'ordinary' &&
      this.ordinarySent >= MAX_ORDINARY_SENT &&
      this.ordinaryQueue.length >= MAX_ORDINARY_QUEUED
    ) {
      reject(this.admissionError(method, id, new RpcTransportError('overloaded', 'The RPC request queue is full')));
      return undefined;
    }
    const pending: PendingCall = {
      id,
      method,
      wire,
      epoch: this.epoch,
      startedAt: performance.now(),
      bytes,
      lane,
      resolve,
      reject,
      timer: 0,
      sent: false,
      active: true,
      abandoned: false,
    };
    pending.timer = window.setTimeout(() => this.expire(pending), REQUEST_TIMEOUT_MS);
    this.pending.set(id, pending);
    this.queuedBytes += bytes;
    return pending;
  }

  private admit(pending: PendingCall): void {
    if (!pending.active) return;
    if (pending.lane === 'ordinary') {
      if (this.ordinarySent >= MAX_ORDINARY_SENT) this.ordinaryQueue.push(pending);
      else this.send(pending);
    } else if (this.controlSent) {
      this.controlQueue.push(pending);
    } else {
      this.send(pending);
    }
  }

  private send(pending: PendingCall): void {
    if (!pending.active || !this.socket || this.socket.readyState !== 1) {
      if (this.release(pending))
        this.rejectCall(pending, new RpcTransportError('disconnected', 'The RPC socket is closed'));
      return;
    }
    pending.sent = true;
    if (pending.lane === 'ordinary') this.ordinarySent++;
    else this.controlSent = true;
    if (pending.lane === 'ordinary' || pending.method === 'session.open')
      this.diagnostics.record('rpc.sent', { method: pending.method, requestId: pending.id, epoch: pending.epoch });
    try {
      this.socket.send(pending.wire);
    } catch {
      this.stopCurrent(new RpcTransportError('disconnected', 'The RPC socket failed while sending'), true);
    }
  }

  private pump(): void {
    while (this.ordinarySent < MAX_ORDINARY_SENT && this.ordinaryQueue.length) {
      const next = this.ordinaryQueue.shift()!;
      if (next.active) this.send(next);
    }
    if (!this.controlSent) {
      const next = this.controlQueue.shift();
      if (next?.active) this.send(next);
    }
  }

  private detach(pending: PendingCall): void {
    if (!pending.active) return;
    if (pending.sent) {
      pending.abandoned = true;
      window.clearTimeout(pending.timer);
      return;
    }
    this.release(pending);
  }

  private expire(pending: PendingCall): void {
    if (!pending.active) return;
    if (pending.sent) {
      pending.abandoned = true;
      window.clearTimeout(pending.timer);
      this.rejectCall(pending, new RpcTransportError('timeout', `RPC request ${pending.method} timed out`));
      return;
    }
    if (this.release(pending))
      this.rejectCall(pending, new RpcTransportError('timeout', `RPC request ${pending.method} timed out`));
  }

  private rejectCall(pending: PendingCall, error: Error, correlate = true) {
    const details = {
      method: pending.method,
      requestId: pending.id,
      epoch: pending.epoch,
      durationMs: Math.round(performance.now() - pending.startedAt),
      sent: pending.sent,
    };
    if (correlate) this.diagnostics.correlate(error, details);
    this.diagnostics.recordError('rpc.failed', error, details);
    pending.reject(error);
  }

  private release(pending: PendingCall) {
    if (!pending.active) return false;
    pending.active = false;
    window.clearTimeout(pending.timer);
    this.pending.delete(pending.id);
    this.queuedBytes -= pending.bytes;
    if (pending.sent) {
      if (pending.lane === 'ordinary') this.ordinarySent--;
      else this.controlSent = false;
    } else {
      const queue = pending.lane === 'ordinary' ? this.ordinaryQueue : this.controlQueue;
      const index = queue.indexOf(pending);
      if (index >= 0) queue.splice(index, 1);
    }
    if (!this.drainingPending) this.pump();
    return true;
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') {
      this.protocolFailure('RPC frames must be text');
      return;
    }
    if (utf8.encode(raw).byteLength + this.queuedBytes > MAX_REQUEST_BYTES) {
      this.protocolFailure('The RPC frame exceeds the transport byte budget');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.protocolFailure('Invalid JSON-RPC frame');
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.protocolFailure('Invalid JSON-RPC envelope');
      return;
    }
    const envelope = value as Record<string, unknown>;
    const jsonrpc = envelope['jsonrpc'];
    if (jsonrpc !== '2.0') {
      this.protocolFailure('Invalid JSON-RPC envelope');
      return;
    }
    const method = envelope['method'];
    if (typeof method === 'string') {
      if (Object.hasOwn(envelope, 'id') || Object.hasOwn(envelope, 'result') || Object.hasOwn(envelope, 'error')) {
        this.protocolFailure('Invalid JSON-RPC notification');
        return;
      }
      const notification: RpcNotification = Object.hasOwn(envelope, 'params')
        ? { jsonrpc: '2.0', method, params: envelope['params'] }
        : { jsonrpc: '2.0', method };
      this.handleNotification(notification);
      return;
    }
    const id = envelope['id'];
    if (!Object.hasOwn(envelope, 'id') || (typeof id !== 'string' && typeof id !== 'number' && id !== null)) {
      this.protocolFailure('Invalid JSON-RPC response');
      return;
    }
    const hasResult = Object.hasOwn(envelope, 'result');
    const hasError = Object.hasOwn(envelope, 'error');
    if (hasResult === hasError || Object.hasOwn(envelope, 'params')) {
      this.protocolFailure('Invalid JSON-RPC response');
      return;
    }
    const pending = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (!pending) return;
    const responseError = envelope['error'];
    if (hasError && !isRpcError(responseError)) {
      this.release(pending);
      this.protocolFailure('Malformed correlated JSON-RPC response');
      if (!pending.abandoned)
        this.rejectCall(pending, new RpcTransportError('protocol', 'Malformed JSON-RPC error response'));
      return;
    }
    const result = envelope['result'];
    if (
      !hasError &&
      pending.method === 'auth.createDevSession' &&
      (typeof result !== 'object' ||
        result === null ||
        Array.isArray(result) ||
        !('token' in result) ||
        typeof result.token !== 'string')
    ) {
      this.release(pending);
      this.protocolFailure('Malformed correlated JSON-RPC response');
      if (!pending.abandoned)
        this.rejectCall(pending, new RpcTransportError('protocol', 'Malformed development session result'));
      return;
    }
    if (!hasError && pending.method === 'auth.createDevSession') {
      this.hasAuthenticatedSession = true;
      this.retryAttempt = 0;
      this.transition(RpcConnectionState.Authenticated);
      this.sendAppState();
      this.startHeartbeat();
    }
    if (!hasError && pending.method === 'session.ping') this.lastHeartbeat = Date.now();
    this.release(pending);
    if (pending.abandoned) return;
    if (hasError && isRpcError(responseError))
      this.rejectCall(pending, new RpcError(responseError.code, responseError.message, responseError.data));
    else {
      if (pending.lane === 'ordinary')
        this.diagnostics.record('rpc.completed', {
          method: pending.method,
          requestId: pending.id,
          epoch: pending.epoch,
          durationMs: Math.round(performance.now() - pending.startedAt),
        });
      pending.resolve(result);
    }
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === 'session.invalidated') {
      this.retryAllowed = false;
      this.reconnectToken = undefined;
      this.stopCurrent(new RpcError(RpcErrorCode.Unauthorized, 'Session invalidated'), false);
      this.notifications.next(notification);
      return;
    }
    if (notification.method === 'session.unavailable') {
      this.stopCurrent(new RpcTransportError('disconnected', 'Session authentication is unavailable'), true);
    }
    this.notifications.next(notification);
  }

  private protocolFailure(message: string): void {
    this.retryAllowed = false;
    this.stopCurrent(new RpcTransportError('protocol', message), false);
  }

  private handleSocketClose(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.socket = undefined;
    this.clearHeartbeat();
    this.clearHandshakeDeadline();
    const error = new RpcTransportError('disconnected', 'The RPC socket closed');
    const pending = this.takePending();
    this.scheduleReconnect();
    this.finishOpenError(epoch, error);
    this.rejectPending(pending, error);
  }

  private stopCurrent(error: Error, reconnect: boolean): void {
    this.diagnostics.recordError('rpc.stopped', error, {
      epoch: this.epoch,
      reason: error instanceof RpcTransportError ? error.message : undefined,
    });
    const closingEpoch = this.epoch;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    this.clearHandshakeDeadline();
    const socket = this.socket;
    this.socket = undefined;
    if (!reconnect) this.attempt = undefined;
    ++this.epoch;
    const pending = this.takePending();
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Closing an already-failed browser socket is harmless.
      }
    }
    if (reconnect) this.scheduleReconnect();
    else this.transition(RpcConnectionState.Closed);
    this.finishOpenError(closingEpoch, error);
    this.rejectPending(pending, error);
  }

  private takePending(): PendingCall[] {
    const pending = [...this.pending.values()];
    this.drainingPending = true;
    for (const call of pending) this.release(call);
    this.drainingPending = false;
    return pending.filter((call) => !call.abandoned);
  }

  private rejectPending(pending: readonly PendingCall[], error: Error): void {
    this.diagnostics.correlate(error, { epoch: this.epoch });
    for (const call of pending) this.rejectCall(call, error, false);
  }

  private scheduleReconnect(): void {
    if (!this.hasAuthenticatedSession || !this.retryAllowed || !this.reconnectToken || !this.attempt?.appVersion) {
      this.transition(RpcConnectionState.Closed);
      return;
    }
    const appVersion = this.attempt.appVersion;
    const delay =
      Math.min(RECONNECT_INITIAL_MS * 2 ** this.retryAttempt++, RECONNECT_MAX_MS) * (0.8 + Math.random() * 0.4);
    this.transition(RpcConnectionState.Reconnecting);
    this.diagnostics.record('rpc.reconnect', {
      epoch: this.epoch,
      reconnectAttempt: this.retryAttempt,
      reconnectInMs: Math.round(delay),
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.retryAllowed || !this.reconnectToken) return;
      this.createSocket(appVersion, true);
    }, delay);
  }

  private finishOpenError(epoch: number, error: Error): void {
    const subscriber = this.openSubscriber;
    if (subscriber?.epoch !== epoch) return;
    this.openSubscriber = undefined;
    subscriber.error(error);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = window.setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.pingOutstanding = false;
  }

  private clearHandshakeDeadline(): void {
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private heartbeat(): void {
    if (this.state() !== RpcConnectionState.Authenticated) return;
    if (Date.now() - this.lastHeartbeat > HEARTBEAT_STALE_MS) {
      this.stopCurrent(new RpcTransportError('disconnected', 'The RPC heartbeat is stale'), true);
      return;
    }
    if (this.pingOutstanding) return;
    this.pingOutstanding = true;
    this.enqueueInternalControl('session.ping', { state: this.appState() }, () => {
      this.pingOutstanding = false;
    });
  }

  private sendAppState(): void {
    if (this.state() !== RpcConnectionState.Authenticated) return;
    this.enqueueInternalControl('session.setAppState', { state: this.appState() });
  }

  private enqueueInternalControl(method: string, params: object, onSuccess?: () => void): void {
    const pending = this.createPending(method, params, onSuccess ?? (() => {}), () => {});
    if (pending) this.admit(pending);
  }

  private handleLifecycleChange(): void {
    const foreground = this.appIsForeground();
    const resumed = foreground && !this.wasForeground;
    this.wasForeground = foreground;
    if (this.state() !== RpcConnectionState.Authenticated) return;
    if (foreground && Date.now() - this.lastHeartbeat > FOREGROUND_STALE_MS) {
      this.stopCurrent(new RpcTransportError('disconnected', 'The RPC socket is stale after foregrounding'), true);
      return;
    }
    if (resumed) this.foreground.next();
    this.sendAppState();
  }

  private laneFor(method: string): RpcLane {
    const methodClass: RpcMethodClass | undefined = rpcMethodClasses[method];
    return methodClass === 'session' || methodClass === 'control' ? 'control' : 'ordinary';
  }

  private controlPendingCount() {
    return this.controlQueue.length + (this.controlSent ? 1 : 0);
  }

  private transition(state: RpcConnectionState): void {
    this.diagnostics.record('rpc.state', {
      previousState: RpcConnectionState[this.state()],
      state: RpcConnectionState[state],
      epoch: this.epoch,
      pending: this.pending.size,
      queued: this.ordinaryQueue.length + this.controlQueue.length,
    });
    this.stateValue.set(state);
    this.stateChanges.next(state);
  }

  private isCurrent(socket: RpcSocket, epoch: number) {
    return this.socket === socket && this.epoch === epoch;
  }

  private socketUrl() {
    const url = new URL(`${this.baseUrl}/ws`, window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  private appIsForeground() {
    return !document.hidden && document.hasFocus();
  }

  private appState() {
    return this.appIsForeground() ? 'active' : 'inactive';
  }
}
