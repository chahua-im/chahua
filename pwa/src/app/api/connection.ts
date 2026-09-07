import { effect, inject, Service } from '@angular/core';
import { filter, map, Subject } from 'rxjs';
import { CHAHUA_BASE_URL } from '../../generated/endpoints/chahua.base-url';
import { wsPayloadCodecs } from '../../generated/json-codecs';
import type { MessageResponse, ServerWsMessage } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';
import { isMessageChange, type MessageChange, type PinChange } from '../messages/message-change';
import { SessionStore } from '../session/session-store';
import { encodeJsonIds } from './json-ids';
import type { SnowflakeID } from './snowflake-id';

const enum WsControl {
  Auth = 'auth',
  Ping = 'ping',
  Pong = 'pong',
  AppState = 'appState',
}

const enum WsAppState {
  Active = 'active',
  Inactive = 'inactive',
}

const VISIBILITY_CHANGE = 'visibilitychange';
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const FOREGROUND_STALE_MS = 30_000;
const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

@Service()
export class Connection {
  private readonly session = inject(SessionStore);
  private readonly baseUrl = inject(CHAHUA_BASE_URL);
  private readonly resync = new Subject<void>();
  private readonly events = new Subject<ServerWsMessage>();
  readonly events$ = this.events.asObservable();
  readonly messages$ = this.events$.pipe(
    filter((event) => event.type === ServerWsMessageType.message),
    map((event) => event.payload),
  );
  readonly changes$ = this.events$.pipe(filter(isMessageChange));
  readonly resync$ = this.resync.asObservable();
  private readonly acceptedIds = new Set<SnowflakeID>();

  /** HTTP success and its WebSocket echo share one delivery path. */
  accept(message: MessageResponse) {
    if (this.acceptedIds.has(message.id)) return;
    this.acceptedIds.add(message.id);
    if (this.acceptedIds.size > 256) this.acceptedIds.delete(this.acceptedIds.values().next().value!);
    this.events.next({ type: ServerWsMessageType.message, payload: message });
  }

  acceptPin(event: PinChange) {
    this.events.next(event);
  }

  acceptChange(event: MessageChange) {
    this.events.next(event);
  }

  constructor() {
    effect((onCleanup) => {
      const token = this.session.token();
      if (!this.session.user() || !token) return;
      const url = new URL(`${this.baseUrl}/ws`, window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      let socket: WebSocket;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let attempts = 0;
      let connected = false;
      let lastPong = Date.now();
      const state = () => (document.hidden ? WsAppState.Inactive : WsAppState.Active);
      const connect = () => {
        socket = new WebSocket(url);
        socket.onopen = () => {
          lastPong = Date.now();
          socket.send(JSON.stringify({ type: WsControl.Auth, ticket: token }));
          heartbeat = setInterval(() => {
            if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS) {
              socket.close();
              return;
            }
            if (socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: WsControl.Ping, state: state() }));
          }, HEARTBEAT_INTERVAL_MS);
        };
        socket.onmessage = (event: MessageEvent<string>) => {
          let message: ServerWsMessage | { type: WsControl.Pong };
          try {
            const parsed = JSON.parse(event.data);
            message = encodeJsonIds(parsed, { payload: wsPayloadCodecs[parsed?.type] }) as typeof message;
          } catch {
            return;
          }
          if (!message) return;
          if (message.type === WsControl.Pong || message.type === ServerWsMessageType.presenceUpdate)
            lastPong = Date.now();
          if (message.type === ServerWsMessageType.presenceUpdate && !connected) {
            connected = true;
            attempts = 0;
            this.resync.next();
          }
          if (message.type === ServerWsMessageType.message) this.accept(message.payload);
          else if (message.type !== WsControl.Pong) this.events.next(message);
        };
        socket.onclose = () => {
          connected = false;
          clearInterval(heartbeat);
          retry = setTimeout(
            connect,
            Math.min(RECONNECT_DELAY_MS * 2 ** attempts++, RECONNECT_MAX_DELAY_MS) * (0.8 + Math.random() * 0.4),
          );
        };
      };
      const visibilityChanged = () => {
        if (!document.hidden) this.resync.next();
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!document.hidden && Date.now() - lastPong > FOREGROUND_STALE_MS) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: WsControl.AppState, state: state() }));
      };
      connect();
      document.addEventListener(VISIBILITY_CHANGE, visibilityChanged);
      onCleanup(() => {
        this.acceptedIds.clear();
        clearTimeout(retry);
        clearInterval(heartbeat);
        document.removeEventListener(VISIBILITY_CHANGE, visibilityChanged);
        socket.onclose = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close();
      });
    });
  }
}
