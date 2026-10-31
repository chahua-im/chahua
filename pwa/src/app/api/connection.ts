import { DestroyRef, inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, map, Subject } from 'rxjs';
import { rpcEvents, rpcMethods, rpcSchemas } from '../../generated/rpc-codecs';
import type { ConversationRef, ConversationView, MessageResponse, ServerWsMessage } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';
import { isMessageChange, type MessageChange, type PinChange } from '../messages/message-change';
import { decodeJsonIds, encodeJsonIds } from './json-ids';
import { RpcConnectionState, RpcTransport, type RpcNotification } from './rpc-transport';
import type { SnowflakeID } from './snowflake-id';

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
  watchPresence(requestId: number, userIds: readonly number[], chatIds: readonly SnowflakeID[]) {
    this.watch('presence.watch', { requestId, userIds, chatIds });
  }

  watchConversationStates(requestId: number, conversations: readonly ConversationRef[]) {
    this.watch('conversations.watchStates', { requestId, conversations });
  }

  watchConversationUnread(requestId: number, views: readonly ConversationView[], appBadge: boolean) {
    this.watch('conversations.watchUnread', { requestId, appBadge, views });
  }

  /** Clears delivery state when SessionStore changes the authenticated account. */
  reset() {
    this.acceptedIds.clear();
  }

  constructor() {
    let authenticated = false;
    this.transport.state$.pipe(takeUntilDestroyed(this.destroy)).subscribe((state) => {
      const connected = state === RpcConnectionState.Authenticated;
      this.connected.set(connected);
      if (connected && !authenticated) this.resync.next(ResyncReason.Connected);
      authenticated = connected;
    });
    this.transport.foreground$.pipe(takeUntilDestroyed(this.destroy)).subscribe(() => {
      if (this.connected()) this.resync.next(ResyncReason.Foreground);
    });
    this.transport.notifications$
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe((notification) => this.receive(notification));
  }

  private watch(method: keyof typeof rpcMethods, params: object) {
    if (!this.connected()) return;
    const wire = decodeJsonIds(params, rpcMethods[method].params, rpcSchemas) as object;
    this.transport.call<void>(method, wire).subscribe({ error: () => {} });
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
