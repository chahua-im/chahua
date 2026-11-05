import { DestroyRef, inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, map, Subject, type Subscription } from 'rxjs';
import { rpcEvents, rpcMethods, rpcSchemas } from '../../generated/rpc-codecs';
import type { ConversationRef, ConversationView, MessageResponse, ServerWsMessage } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';
import { isMessageChange, type MessageChange, type PinChange } from '../messages/message-change';
import { decodeJsonIds, encodeJsonIds } from './json-ids';
import { RpcConnectionState, RpcTransport, type RpcNotification } from './rpc-transport';
import type { SnowflakeID } from './snowflake-id';
import { RpcError, RpcErrorCode, RpcTransportError } from './rpc-error';

type WatchMethod = 'presence.watch' | 'conversations.watchStates' | 'conversations.watchUnread';
interface WatchRequest {
  wire: object;
  onError?: (error: unknown) => void;
  delay: number;
  timer?: ReturnType<typeof setTimeout>;
  subscription?: Subscription;
}

export enum ResyncReason {
  Connected,
  Foreground,
}

@Service()
export class Connection {
  readonly connected = signal(false);
  private readonly destroy = inject(DestroyRef);
  private readonly transport = inject(RpcTransport);
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
  private readonly watches = new Map<WatchMethod, WatchRequest>();

  /** RPC confirmations and their notification echoes share one delivery path. */
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

  /** Replaces this connection's server-side presence watch scope when authenticated. */
  watchPresence(
    requestId: number,
    userIds: readonly number[],
    chatIds: readonly SnowflakeID[],
    onError?: (error: unknown) => void,
  ) {
    this.watch('presence.watch', { requestId, userIds, chatIds }, onError);
  }

  watchConversationStates(
    requestId: number,
    conversations: readonly ConversationRef[],
    onError?: (error: unknown) => void,
  ) {
    this.watch('conversations.watchStates', { requestId, conversations }, onError);
  }

  watchConversationUnread(
    requestId: number,
    views: readonly ConversationView[],
    appBadge: boolean,
    onError?: (error: unknown) => void,
  ) {
    this.watch('conversations.watchUnread', { requestId, appBadge, views }, onError);
  }

  /** Clears delivery state when SessionStore changes the authenticated account. */
  reset() {
    this.acceptedIds.clear();
    this.clearWatches();
  }

  constructor() {
    let authenticated = false;
    this.transport.state$.pipe(takeUntilDestroyed(this.destroy)).subscribe((state) => {
      const connected = state === RpcConnectionState.Authenticated;
      this.connected.set(connected);
      if (!connected) this.clearWatches();
      if (connected && !authenticated) this.resync.next(ResyncReason.Connected);
      authenticated = connected;
    });
    this.transport.foreground$.pipe(takeUntilDestroyed(this.destroy)).subscribe(() => {
      if (this.connected()) this.resync.next(ResyncReason.Foreground);
    });
    this.transport.notifications$
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe((notification) => this.receive(notification));
    this.destroy.onDestroy(() => this.clearWatches());
  }

  private clearWatch(method: WatchMethod) {
    const request = this.watches.get(method);
    this.watches.delete(method);
    clearTimeout(request?.timer);
    request?.subscription?.unsubscribe();
  }

  private clearWatches() {
    for (const method of this.watches.keys()) this.clearWatch(method);
  }

  private watch(method: WatchMethod, params: object, onError?: (error: unknown) => void) {
    this.clearWatch(method);
    if (!this.connected()) return;
    const wire = decodeJsonIds(params, rpcMethods[method].params, rpcSchemas) as object;
    const request: WatchRequest = { wire, onError, delay: 1_000 };
    this.watches.set(method, request);
    this.sendWatch(method, request);
  }

  private sendWatch(method: WatchMethod, request: WatchRequest) {
    request.subscription = this.transport.call<void>(method, request.wire).subscribe({
      error: (error: unknown) => {
        if (this.watches.get(method) !== request) return;
        request.onError?.(error);
        const retryable =
          (error instanceof RpcTransportError && error.kind !== 'protocol') ||
          (error instanceof RpcError &&
            [
              RpcErrorCode.Internal,
              RpcErrorCode.DispatcherInternal,
              RpcErrorCode.Unavailable,
              RpcErrorCode.Overloaded,
            ].includes(error.code));
        if (!retryable || !this.connected() || this.watches.get(method) !== request) return;
        request.timer = setTimeout(() => this.sendWatch(method, request), request.delay);
        request.delay = Math.min(request.delay * 2, 30_000);
      },
    });
  }

  private receive(notification: RpcNotification) {
    if (!notification.method.startsWith('events.')) return;
    const codec = rpcEvents[notification.method as keyof typeof rpcEvents];
    const type = notification.method.slice('events.'.length);
    if (!codec || !Object.values(ServerWsMessageType).includes(type as ServerWsMessageType)) return;
    const event = {
      type: type as ServerWsMessageType,
      payload: encodeJsonIds(notification.params, codec, rpcSchemas),
    } as unknown as ServerWsMessage;
    if (event.type === ServerWsMessageType.message) this.accept(event.payload);
    else this.events.next(event);
  }
}
