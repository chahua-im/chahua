import { computed, signal, type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, type Observable } from 'rxjs';
import type { RpcApi } from '../../generated/rpc-api';
import { ServerWsMessageType, type MessageResponse, type PinResponse } from '../../generated/models';
import type { Connection } from '../api/connection';
import { jsonEquals } from '../api/json-equals';
import type { SnowflakeID } from '../api/snowflake-id';
import {
  messageChangePatch,
  recalledMessageIds,
  redactDeletedMessage,
  redactRecalledCitations,
  type MessageChange,
} from '../messages/message-change';
import { patchItems } from '../messages/message-merge';

type PinPatch = (pins: PinResponse[]) => PinResponse[];
type MessagePatch = (message: MessageResponse) => MessageResponse;
interface PinRead {
  patches: PinPatch[];
  changes: MessagePatch[];
}
interface PinCreation {
  message: MessageResponse;
  needsRefresh: boolean;
}

function affectedByEdit(message: MessageResponse, id: SnowflakeID) {
  const quote = message.replyToMessage;
  return message.id === id || (quote?.id === id && !quote.isDeleted);
}

function patchPinnedMessages(pins: PinResponse[], update: MessagePatch) {
  return patchItems(pins, (pin) => {
    const message = update(pin.message);
    return message === pin.message ? pin : { ...pin, message };
  });
}

/** One lazily loaded pin collection, owned and shared by ChatStore. */
export class ChatPins {
  private pinsFresh = false;
  private listRevision = 0;
  private listRead?: PinRead;
  private readonly creations = new Set<PinCreation>();
  private readonly removedPins = new Set<SnowflakeID>();
  private readonly pinEpoch = signal(0);
  private readonly pinItems = signal<PinResponse[]>([]);
  private readonly pendingPins = signal<Promise<void> | undefined>(undefined);
  readonly items = this.pinItems.asReadonly();
  readonly pinPurgeGeneration = this.pinEpoch.asReadonly();
  readonly loading = computed(() => !!this.pendingPins());
  constructor(
    readonly chatId: SnowflakeID,
    readonly threadId: SnowflakeID | undefined,
    private readonly pinsApi: RpcApi['pins'],
    private readonly realtime: Connection,
    private readonly destroyRef: DestroyRef,
    private readonly accessible: () => boolean,
    private readonly accountUid: () => number | undefined,
  ) {}

  invalidate() {
    this.pinsFresh = false;
    this.listRevision++;
  }
  clear() {
    this.invalidate();
    this.pinEpoch.update((generation) => generation + 1);
    this.listRead = undefined;
    this.removedPins.clear();
    this.pendingPins.set(undefined);
    this.pinItems.set([]);
  }
  get(messageId: SnowflakeID) {
    return this.items().find((pin) => pin.message.id === messageId);
  }
  ensure(): Promise<void> {
    if (!this.accessible()) return Promise.resolve();
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
      if (!this.accessible()) return;
      const epoch = this.pinEpoch();
      const revision = this.listRevision;
      const read: PinRead = { patches: [], changes: [] };
      this.listRead = read;
      try {
        const { pins } = await this.response(
          this.threadId
            ? this.pinsApi.listForThread({ chatId: this.chatId, threadRootId: this.threadId })
            : this.pinsApi.list({ chatId: this.chatId }),
        );
        if (epoch !== this.pinEpoch() || !this.accessible()) return;
        if (revision !== this.listRevision) continue;
        const updated = read.patches
          .reduce((current, patch) => patch(current), pins)
          .filter((pin) => !this.removedPins.has(pin.id))
          .map((pin) => this.reconcile(pin));
        // A disagreeing edit or reaction cannot be ordered against the list. Only accept the list
        // directly when it already reflects those changes or they do not affect any returned pin.
        if (
          read.changes.length &&
          updated.some(
            ({ message }) =>
              !message.isDeleted &&
              !jsonEquals(
                message,
                read.changes.reduce((current, patch) => patch(current), message),
              ),
          )
        )
          continue;
        this.pinItems.set(updated);
        this.pinsFresh = true;
        return;
      } finally {
        if (this.listRead === read) this.listRead = undefined;
      }
    }
  }
  apply(id: SnowflakeID, pin?: PinResponse) {
    if (!this.accessible() || this.removedPins.has(id)) return;
    if (!pin) {
      this.removedPins.add(id);
      this.pinItems.update((pins) => pins.filter((existing) => existing.id !== id));
      return;
    }
    const next = this.reconcile(this.pinForViewer(pin));
    const update: PinPatch = (pins) => (pins.some((existing) => existing.id === id) ? pins : [next, ...pins]);
    this.listRead?.patches.push(update);
    this.pinItems.update(update);
  }
  receiveChange(event: MessageChange) {
    if (!this.accessible()) return;
    if (event.payload.chatId !== this.chatId) return;
    const update = messageChangePatch(event);
    const ids = recalledMessageIds(event);
    if (ids && this.listRead) {
      const recalls = new Set(ids);
      this.listRead.patches.push((pins) =>
        patchPinnedMessages(pins, (message) =>
          recalls.has(message.id) && !message.isDeleted
            ? redactDeletedMessage(message)
            : redactRecalledCitations(message, recalls),
        ),
      );
    } else if (event.type === ServerWsMessageType.messageUpdated && !event.payload.isDeleted) {
      const id = event.payload.id;
      this.listRead?.changes.push(update);
      for (const creation of this.creations) if (affectedByEdit(creation.message, id)) creation.needsRefresh = true;
    } else if (event.type === ServerWsMessageType.reactionUpdated) {
      const id = event.payload.messageId;
      this.listRead?.changes.push(update);
      for (const creation of this.creations) if (creation.message.id === id) creation.needsRefresh = true;
    }
    this.pinItems.update((pins) => patchPinnedMessages(pins, update));
  }
  private pinForViewer(pin: PinResponse): PinResponse {
    const uid = this.accountUid();
    if (uid === pin.pinnedBy || !pin.message.reactions.length) return pin;
    // The broadcast carries the pin creator's selection. A truncated sample can prove
    // membership but can only prove absence if it contains everyone who reacted.
    const reactions = pin.message.reactions.map((reaction) => {
      const { reactors, count } = reaction;
      const reactedByMe = reactors?.some((reactor) => reactor.uid === uid)
        ? true
        : reactors?.length === count
          ? false
          : undefined;
      return { ...reaction, reactedByMe };
    });
    return { ...pin, message: { ...pin.message, reactions } };
  }
  private reconcile(pin: PinResponse): PinResponse {
    const message = this.realtime.redactKnownRecalls(pin.message);
    return message === pin.message ? pin : { ...pin, message };
  }
  private response<T>(request: Observable<T>) {
    return firstValueFrom(request.pipe(takeUntilDestroyed(this.destroyRef)));
  }
  async set(message: MessageResponse, pinned: boolean) {
    await this.ensure();
    if (!this.accessible()) return;
    const existing = this.get(message.id);
    if (pinned === !!existing) return;
    if (existing) {
      await this.response(
        this.threadId
          ? this.pinsApi.deleteForThread({ chatId: this.chatId, threadRootId: this.threadId, pinId: existing.id })
          : this.pinsApi.delete({ chatId: this.chatId, pinId: existing.id }),
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

    const epoch = this.pinEpoch();
    const revision = this.listRevision;
    const creation: PinCreation = { message, needsRefresh: false };
    this.creations.add(creation);
    try {
      const pin = await this.response(
        this.threadId
          ? this.pinsApi.createForThread({ chatId: this.chatId, threadRootId: this.threadId, messageId: message.id })
          : this.pinsApi.create({ chatId: this.chatId, messageId: message.id }),
      );
      if (epoch !== this.pinEpoch() || !this.accessible() || this.removedPins.has(pin.id)) return;
      if (this.items().some((current) => current.id === pin.id)) return;
      if (revision !== this.listRevision || creation.needsRefresh) {
        this.invalidate();
        await this.ensure().catch(() => {});
        return;
      }
      this.realtime.acceptPin({
        type: this.threadId ? ServerWsMessageType.threadPinAdded : ServerWsMessageType.pinAdded,
        payload: { chatId: this.chatId, threadRootId: this.threadId, messageId: message.id, pinId: pin.id, pin },
      });
    } finally {
      this.creations.delete(creation);
    }
  }
}
