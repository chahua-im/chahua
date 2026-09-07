import { computed, signal, type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, type Observable } from 'rxjs';
import type { PinsService } from '../../generated/endpoints/pins/pins.service';
import { ServerWsMessageType, type MessageResponse, type PinResponse } from '../../generated/models';
import type { Connection } from '../api/connection';
import type { SnowflakeID } from '../api/snowflake-id';
import type { MessageChange } from '../messages/message-change';
import { preserveReactionOwnership } from '../messages/reaction-state';

/** One lazily loaded pin collection, owned and shared by ChatStore. */
export class ChatPins {
  private pinsFresh = false;
  private pinRevision = 0;
  private readonly pinItems = signal<PinResponse[]>([]);
  private readonly pendingPins = signal<Promise<void> | undefined>(undefined);
  readonly items = this.pinItems.asReadonly();
  readonly loading = computed(() => !!this.pendingPins());
  constructor(
    readonly chatId: SnowflakeID,
    readonly threadId: SnowflakeID | undefined,
    private readonly pinsApi: PinsService,
    private readonly realtime: Connection,
    private readonly destroyRef: DestroyRef,
  ) {}

  invalidate() {
    this.pinsFresh = false;
    this.pinRevision++;
  }
  get(messageId: SnowflakeID) {
    return this.items().find((pin) => pin.message.id === messageId);
  }
  ensure(): Promise<void> {
    if (this.pinsFresh) return Promise.resolve();
    const pendingPins = this.pendingPins();
    if (pendingPins) return pendingPins;
    const request = this.loadPins().finally(() => {
      if (this.pendingPins() === request) this.pendingPins.set(undefined);
    });
    this.pendingPins.set(request);
    return request;
  }
  private async loadPins() {
    while (!this.destroyRef.destroyed) {
      const revision = this.pinRevision;
      const { pins } = await this.response(
        this.threadId ? this.pinsApi.listThreadPins(this.chatId, this.threadId) : this.pinsApi.listPins(this.chatId),
      );
      if (revision !== this.pinRevision) continue;
      this.pinItems.set(pins);
      this.pinsFresh = true;
      return;
    }
  }
  apply(id: SnowflakeID, pin?: PinResponse) {
    this.pinRevision++;
    this.pinItems.update((pins) => {
      const remaining = pins.filter((existing) => existing.id !== id);
      return pin ? [pin, ...remaining] : remaining;
    });
  }
  receiveChange(event: MessageChange) {
    if (event.payload.chatId !== this.chatId) return;
    this.pinRevision++;
    this.pinItems.update((pins) =>
      pins.map((pin) => {
        const message = pin.message;
        switch (event.type) {
          case ServerWsMessageType.messageUpdated:
          case ServerWsMessageType.messageDeleted:
            return message.id === event.payload.id
              ? {
                  ...pin,
                  message: {
                    ...event.payload,
                    isDeleted: event.type === ServerWsMessageType.messageDeleted || event.payload.isDeleted,
                    reactions: preserveReactionOwnership(message.reactions, event.payload.reactions),
                  },
                }
              : pin;
          case ServerWsMessageType.messagesBulkDeleted:
            return event.payload.messageIds.includes(message.id)
              ? { ...pin, message: { ...message, isDeleted: true } }
              : pin;
          case ServerWsMessageType.reactionUpdated:
            return message.id === event.payload.messageId
              ? {
                  ...pin,
                  message: {
                    ...message,
                    reactions: preserveReactionOwnership(message.reactions, event.payload.reactions),
                  },
                }
              : pin;
        }
        return pin;
      }),
    );
  }
  private response<T>(request: Observable<T>) {
    return firstValueFrom(request.pipe(takeUntilDestroyed(this.destroyRef)));
  }
  async set(message: MessageResponse, pinned: boolean) {
    await this.ensure();
    const existing = this.get(message.id);
    if (pinned === !!existing) return;
    if (existing) {
      await this.response(
        this.threadId
          ? this.pinsApi.deleteThreadPin(this.chatId, this.threadId, existing.id)
          : this.pinsApi.deletePin(this.chatId, existing.id),
      );
      this.realtime.acceptPin({
        type: this.threadId ? ServerWsMessageType.threadPinRemoved : ServerWsMessageType.pinRemoved,
        payload: {
          chatId: this.chatId,
          threadRootId: this.threadId,
          messageId: message.id,
          pinId: existing.id,
        },
      });
      return;
    }

    const revision = this.pinRevision;
    const pin = await this.response(
      this.threadId
        ? this.pinsApi.createThreadPin(this.chatId, this.threadId, { messageId: message.id })
        : this.pinsApi.createPin(this.chatId, { messageId: message.id }),
    );
    if (revision === this.pinRevision)
      this.realtime.acceptPin({
        type: this.threadId ? ServerWsMessageType.threadPinAdded : ServerWsMessageType.pinAdded,
        payload: { chatId: this.chatId, threadRootId: this.threadId, messageId: message.id, pinId: pin.id, pin },
      });
    else if (!this.items().some((current) => current.id === pin.id)) {
      // A removal can arrive before the create response; do not restore that older pin.
      this.pinsFresh = false;
      await this.ensure().catch(() => {});
    }
  }
}
