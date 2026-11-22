import { inject, Service } from '@angular/core';
import { defer, firstValueFrom, Observable, Subject, switchMap } from 'rxjs';
import {
  MessageSyncResetReason,
  ServerWsMessageType,
  type MessageResponse,
  type MessageSyncBatch,
  type MessageSyncPageResult,
  type MessageSyncReset,
  type MessageSyncRevoked,
  type ServerWsMessage,
} from '../../generated/models';
import { RpcApi } from '../../generated/rpc-api';
import type { MessageSyncPageParams } from '../../generated/rpc-models';
import { RpcTransportError } from '../api/rpc-error';
import { RpcTransport } from '../api/rpc-transport';
import type { SnowflakeID } from '../api/snowflake-id';
import type { MessageChange } from './message-change';
import { isVisibleMessage } from './message-visibility';

const CHUNK_SIZE = 128;
const PAGE_TIMEOUT_MS = 15_000;

export function requiresMessagePurge(reason: MessageSyncResetReason): boolean {
  return (
    reason === MessageSyncResetReason.visibilityChanged ||
    reason === MessageSyncResetReason.invalidCursor ||
    reason === MessageSyncResetReason.epochChanged
  );
}

interface MessageReceiver {
  accept(message: MessageResponse): void;
  acceptChange(event: MessageChange): void;
}

interface PendingPage {
  readonly chatId: SnowflakeID;
  readonly generation: number;
  readonly result: (payload: MessageSyncPageResult) => void;
  readonly fail: (error: Error) => void;
}

@Service()
export class MessageSync {
  private readonly api = inject(RpcApi);
  private readonly transport = inject(RpcTransport);
  readonly active = this.transport.messageSyncActive;
  private readonly cursors = new Map<SnowflakeID, string>();
  private readonly covered = new Set<SnowflakeID>();
  private readonly caughtUp = new Set<SnowflakeID>();
  private readonly resets = new Subject<MessageSyncReset>();
  readonly resets$ = this.resets.asObservable();
  private readonly revocations = new Subject<MessageSyncRevoked>();
  readonly revoked$ = this.revocations.asObservable();
  private readonly accountResets = new Subject<void>();
  readonly accountResets$ = this.accountResets.asObservable();
  private readonly pending = new Map<number, PendingPage>();
  private uid?: number;
  private generation = 0;
  private requestId = 0;
  private priority?: { chatId: SnowflakeID; owner: object };
  private barrier?: Promise<void>;

  get connectionGeneration(): number {
    return this.generation;
  }

  setPriority(chatId: SnowflakeID, owner: object) {
    this.priority = { chatId, owner };
  }

  clearPriority(owner: object) {
    if (this.priority?.owner === owner) this.priority = undefined;
  }

  connect(uid: number | undefined) {
    if (uid != null && this.uid != null && this.uid !== uid) this.reset();
    this.uid = uid;
    if (!this.active()) return;
    const generation = this.generation;
    const barrier = this.resume(generation);
    this.barrier = barrier;
    void barrier.catch(() => {
      if (generation === this.generation) this.transport.reconnect();
    });
  }

  disconnect() {
    this.generation++;
    this.covered.clear();
    this.caughtUp.clear();
    this.barrier = undefined;
    const error = this.disconnected();
    for (const page of this.pending.values()) page.fail(error);
  }

  reset() {
    this.disconnect();
    this.uid = undefined;
    this.cursors.clear();
    this.priority = undefined;
    this.requestId = 0;
    this.accountResets.next();
  }

  isCovered(chatId: SnowflakeID): boolean {
    return this.covered.has(chatId);
  }

  canNotify(chatId: SnowflakeID): boolean {
    return !this.active() || this.caughtUp.has(chatId);
  }

  async waitForResume(): Promise<void> {
    const generation = this.generation;
    if (this.active()) await this.barrier;
    if (generation !== this.generation) throw this.disconnected();
  }

  page(params: Omit<MessageSyncPageParams, 'requestId'>, onAt: (at: string) => void) {
    return defer(() => this.waitForResume()).pipe(
      switchMap(
        () =>
          new Observable<MessageSyncPageResult>((subscriber) => {
            if (!this.active()) {
              subscriber.error(this.disconnected());
              return;
            }
            const requestId = ++this.requestId;
            const pending: PendingPage = {
              chatId: params.chatId,
              generation: this.generation,
              result: (payload) => {
                if (payload.at != null) onAt(payload.at);
                subscriber.next(payload);
                subscriber.complete();
              },
              fail: (error) => subscriber.error(error),
            };
            // The event arrives before the acknowledgement. Keep the slot visible
            // even when the local test transport responds during the send call.
            this.pending.set(requestId, pending);
            const timer = setTimeout(() => {
              pending.fail(new RpcTransportError('timeout', 'Message sync page timed out'));
            }, PAGE_TIMEOUT_MS);
            const acknowledgement = this.api.messageSync.page({ ...params, requestId }).subscribe({
              error: (error: unknown) => subscriber.error(error),
            });
            return () => {
              this.pending.delete(requestId);
              clearTimeout(timer);
              acknowledgement.unsubscribe();
            };
          }),
      ),
    );
  }

  receive(event: ServerWsMessage, receiver: MessageReceiver): boolean {
    switch (event.type) {
      case ServerWsMessageType.messageSyncHello:
        return true;
      case ServerWsMessageType.messageSyncBatch:
        if (this.active()) this.apply(event.payload, receiver);
        return true;
      case ServerWsMessageType.messageSyncReady:
        if (this.active()) {
          const { chatId, cursor } = event.payload;
          const installed = this.cursors.get(chatId);
          if (installed == null || installed !== cursor) this.transport.reconnect();
          else {
            this.covered.add(chatId);
            this.caughtUp.add(chatId);
          }
        }
        return true;
      case ServerWsMessageType.messageSyncReset:
        if (this.active()) {
          const { chatId, cursor } = event.payload;
          this.cursors.set(chatId, cursor);
          this.covered.delete(chatId);
          this.caughtUp.add(chatId);
          this.resets.next(event.payload);
        }
        return true;
      case ServerWsMessageType.messageSyncRevoked:
        if (this.active()) {
          const { chatId } = event.payload;
          this.cursors.delete(chatId);
          this.covered.delete(chatId);
          this.caughtUp.delete(chatId);
          this.revocations.next(event.payload);
          for (const page of this.pending.values()) {
            if (page.chatId === chatId) page.fail(new Error('Message sync chat is inaccessible'));
          }
        }
        return true;
      case ServerWsMessageType.messageSyncPageResult:
        if (this.active()) this.receivePage(event.payload);
        return true;
      default:
        return false;
    }
  }

  private async resume(generation: number) {
    const manifest = Array.from(this.cursors, ([chatId, cursor]) => ({ chatId, cursor }));
    const priorityChatId = this.priority?.chatId;
    for (let i = 0; ; i += CHUNK_SIZE) {
      const last = i + CHUNK_SIZE >= manifest.length;
      await firstValueFrom(
        this.api.messageSync.resume({
          chats: manifest.slice(i, i + CHUNK_SIZE),
          last,
          priorityChatId: last ? priorityChatId : undefined,
        }),
      );
      if (generation !== this.generation) throw this.disconnected();
      if (last) return;
    }
  }

  private apply(batch: MessageSyncBatch, receiver: MessageReceiver) {
    const { chatId, from, to, changes } = batch;
    const installed = this.cursors.get(chatId);
    if (installed == null || installed !== from) {
      this.transport.reconnect();
      return;
    }
    const messageIds: SnowflakeID[] = [];
    const threadRootIds = new Set<SnowflakeID>();
    let threadRepliesOnly = true;
    for (const change of changes) {
      if (change.kind === 'upsert') {
        const { appeared, message } = change;
        const event: MessageChange = { type: ServerWsMessageType.messageUpdated, payload: message };
        // A previously hidden root can become visible when an existing audio reply finishes transcoding.
        if (message.isDeleted && isVisibleMessage(message)) event.restoreToTimeline = true;
        else if (appeared && !message.isDeleted) receiver.accept(message);
        receiver.acceptChange(event);
      } else {
        messageIds.push(change.messageId);
        if (change.threadRootId != null) threadRootIds.add(change.threadRootId);
        else threadRepliesOnly = false;
      }
    }
    if (messageIds.length)
      receiver.acceptChange({
        type: ServerWsMessageType.messagesBulkDeleted,
        removeFromTimeline: true,
        ...(threadRepliesOnly ? { threadRepliesOnly: true } : {}),
        payload: { chatId, messageIds, threadRootIds: [...threadRootIds] },
      });
    this.cursors.set(chatId, to);
  }

  private receivePage(payload: MessageSyncPageResult) {
    const page = this.pending.get(payload.requestId);
    if (!page || page.generation !== this.generation) return;
    if (
      page.chatId !== payload.chatId ||
      (payload.page != null && (payload.at == null || payload.at !== this.cursors.get(payload.chatId)))
    ) {
      this.transport.reconnect();
      return;
    }
    page.result(payload);
  }

  private disconnected() {
    return new RpcTransportError('disconnected', 'Message sync connection changed');
  }
}
