import { computed, effect, inject, Service, signal } from '@angular/core';
import { filter, map, Subject } from 'rxjs';
import { CHAHUA_BASE_URL } from '../../generated/endpoints/chahua.base-url';
import { wsPayloadCodecs } from '../../generated/json-codecs';
import type { ConversationView, MessageResponse, ServerWsMessage } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';
import { isMessageChange, type MessageChange, type PinChange } from '../messages/message-change';
import { SessionStore } from '../session/session-store';
import { encodeJsonIds } from './json-ids';
import { decodeId, type SnowflakeID } from './snowflake-id';

const enum WsControl {
  Auth = 'auth',
  Ping = 'ping',
  Pong = 'pong',
  AppState = 'appState',
  WatchPresence = 'watchPresence',
  WatchConversationUnread = 'watchConversationUnread',
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

export enum ResyncReason {
  Connected,
  Foreground,
}

@Service()
export class Connection {
  readonly connected = signal(false);
  private readonly session = inject(SessionStore);
  private readonly baseUrl = inject(CHAHUA_BASE_URL);
  private readonly resync = new Subject<ResyncReason>();
  private readonly events = new Subject<ServerWsMessage>();
  readonly events$ = this.events.asObservable();
  readonly messages$ = this.events$.pipe(
    filter((event) => event.type === ServerWsMessageType.message),
    map((event) => event.payload),
  );
  readonly changes$ = this.events$.pipe(filter(isMessageChange));
  readonly resync$ = this.resync.asObservable();
  private readonly acceptedIds = new Set<SnowflakeID>();
  private socket?: WebSocket;

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

  /** Replaces this socket's server-side presence watch scope when authenticated. */
  watchPresence(requestId: number, userIds: readonly number[], chatIds: readonly SnowflakeID[]) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        type: WsControl.WatchPresence,
        requestId,
        userIds,
        chatIds: chatIds.map(decodeId),
      }),
    );
  }

  watchConversationUnread(requestId: number, views: readonly ConversationView[], appBadge: boolean) {
    if (!this.connected() || this.socket?.readyState !== WebSocket.OPEN) return;
    const refs = (items: ConversationView['selector']['include']) =>
      items?.map((ref) => ({
        chatId: decodeId(ref.chatId),
        ...(ref.threadId == null ? {} : { threadId: decodeId(ref.threadId) }),
      }));
    this.socket.send(
      JSON.stringify({
        type: WsControl.WatchConversationUnread,
        requestId,
        appBadge,
        views: views.map((view) => ({
          ...view,
          selector: {
            ...view.selector,
            include: refs(view.selector.include),
            exclude: refs(view.selector.exclude),
          },
        })),
      }),
    );
  }

  constructor() {
    const uid = computed(() => this.session.user()?.uid);
    effect((onCleanup) => {
      const token = this.session.token();
      if (!uid() || !token) return;
      const url = new URL(`${this.baseUrl}/ws`, window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      let socket: WebSocket;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let attempts = 0;
      let connected = false;
      let lastPong = Date.now();
      const state = () => (document.hidden || !document.hasFocus() ? WsAppState.Inactive : WsAppState.Active);
      let wasActive = state() === WsAppState.Active;
      const connect = () => {
        socket = new WebSocket(url);
        this.socket = socket;
        socket.onopen = () => {
          lastPong = Date.now();
          socket.send(JSON.stringify({ type: WsControl.Auth, ticket: token }));
          socket.send(JSON.stringify({ type: WsControl.AppState, state: state() }));
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
          if ('payload' in message) this.session.updateProfile(message.payload);
          if (message.type === WsControl.Pong || message.type === ServerWsMessageType.presenceUpdate)
            lastPong = Date.now();
          if (message.type === ServerWsMessageType.presenceUpdate && !connected) {
            connected = true;
            this.connected.set(true);
            attempts = 0;
            this.resync.next(ResyncReason.Connected);
          }
          if (message.type === ServerWsMessageType.message) this.accept(message.payload);
          else if (message.type !== WsControl.Pong) this.events.next(message);
        };
        socket.onclose = () => {
          if (this.socket === socket) this.socket = undefined;
          connected = false;
          this.connected.set(false);
          clearInterval(heartbeat);
          retry = setTimeout(
            connect,
            Math.min(RECONNECT_DELAY_MS * 2 ** attempts++, RECONNECT_MAX_DELAY_MS) * (0.8 + Math.random() * 0.4),
          );
        };
      };
      const visibilityChanged = () => {
        const active = state() === WsAppState.Active;
        const resumed = active && !wasActive;
        wasActive = active;
        if (socket.readyState === WebSocket.OPEN && active && Date.now() - lastPong > FOREGROUND_STALE_MS) {
          socket.close();
          return;
        }
        if (resumed) this.resync.next(ResyncReason.Foreground);
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: WsControl.AppState, state: state() }));
      };
      connect();
      document.addEventListener(VISIBILITY_CHANGE, visibilityChanged);
      window.addEventListener('focus', visibilityChanged);
      window.addEventListener('blur', visibilityChanged);
      onCleanup(() => {
        this.connected.set(false);
        this.acceptedIds.clear();
        clearTimeout(retry);
        clearInterval(heartbeat);
        document.removeEventListener(VISIBILITY_CHANGE, visibilityChanged);
        window.removeEventListener('focus', visibilityChanged);
        window.removeEventListener('blur', visibilityChanged);
        if (this.socket === socket) this.socket = undefined;
        socket.onclose = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close();
      });
    });
  }
}
