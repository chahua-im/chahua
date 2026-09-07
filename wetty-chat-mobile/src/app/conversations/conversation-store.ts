import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, map, Subject, takeUntil, type Observable } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import {
  type GetMessagesParams,
  type ListMessagesResponse,
  type MessageResponse,
  type ReactionSummary,
  type ThreadUpdatePayload,
  ServerWsMessageType,
  type PinResponse,
} from '../../generated/models';
import { mergeMessages } from '../messages/message-merge';
import { type MessageChange } from '../messages/message-change';
import { type SnowflakeID } from '../api/snowflake-id';
import { preserveReactionOwnership } from './reaction-state';
import { PinsService } from '../../generated/endpoints/pins/pins.service';
import { Connection } from '../api/connection';
export enum PageDirection {
  Older,
  Newer,
}
export enum ConversationError {
  Missing = 1,
  Open,
  Page,
}
type MessageRange = Pick<ListMessagesResponse, 'messages' | 'olderCursor' | 'newerCursor'>;
type MessageUpdate = (message: MessageResponse) => MessageResponse;
type ConversationContext = Readonly<{ chatId: SnowflakeID; threadId?: SnowflakeID }>;
@Injectable()
export class ConversationStore {
  private readonly api = inject(ChatsService);
  private readonly destroyRef = inject(DestroyRef);
  private version = 0;
  private readonly cancel = new Subject<void>();
  private latestSeenId?: SnowflakeID;
  private needsResync = false;
  private readonly pendingUpdates = new Map<SnowflakeID, MessageUpdate>();
  private readonly currentPage = signal<MessageRange | undefined>(undefined);
  private readonly isLoading = signal(false);
  private readonly pageDirection = signal<PageDirection | undefined>(undefined);
  private readonly currentError = signal<ConversationError | undefined>(undefined);
  readonly page = this.currentPage.asReadonly();
  readonly items = computed(() => this.page()?.messages ?? []);
  readonly loading = this.isLoading.asReadonly();
  readonly pagingDirection = this.pageDirection.asReadonly();
  readonly paging = computed(() => this.pageDirection() !== undefined);
  readonly error = this.currentError.asReadonly();
  readonly atLatest = computed(() => !!this.page() && !this.page()?.newerCursor && !this.loading());
  private readonly pinsApi = inject(PinsService);
  private readonly realtime = inject(Connection);
  private context?: ConversationContext;
  private readonly cancelPins = new Subject<void>();
  private pinsFresh = false;
  private pinRevision = 0;
  private readonly pinItems = signal<PinResponse[]>([]);
  private readonly pendingPins = signal<Promise<void> | undefined>(undefined);
  readonly pins = this.pinItems.asReadonly();
  readonly pinsLoading = computed(() => this.pendingPins() !== undefined);

  constructor() {
    this.destroyRef.onDestroy(() => this.reset());
    this.realtime.changes$.pipe(takeUntilDestroyed()).subscribe((event) => this.applyMessageChange(event));
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === ServerWsMessageType.threadUpdate) this.updateThread(event.payload);
      if (
        event.type !== ServerWsMessageType.pinAdded &&
        event.type !== ServerWsMessageType.pinRemoved &&
        event.type !== ServerWsMessageType.threadPinAdded &&
        event.type !== ServerWsMessageType.threadPinRemoved
      )
        return;
      const { chatId, threadRootId, pinId, pin } = event.payload;
      if (chatId !== this.context?.chatId || threadRootId !== this.context.threadId) return;
      this.applyPin(pinId, pin);
    });
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.pinsFresh = false;
      this.pinRevision++;
    });
  }

  canLoad(direction: PageDirection) {
    const page = this.page();
    const cursor = direction === PageDirection.Older ? page?.olderCursor : page?.newerCursor;
    return !!cursor && !this.loading() && !this.paging();
  }

  reset(chatId?: SnowflakeID, threadId?: SnowflakeID) {
    this.context = chatId === undefined ? undefined : { chatId, threadId };
    this.pinsFresh = false;
    this.pinRevision++;
    this.cancelPins.next();
    this.pinItems.set([]);
    this.pendingPins.set(undefined);

    this.version++;
    this.cancel.next();
    this.latestSeenId = undefined;
    this.needsResync = false;
    this.pendingUpdates.clear();
    this.currentPage.set(undefined);
    this.isLoading.set(false);
    this.pageDirection.set(undefined);
    this.currentError.set(undefined);
  }

  async open(around?: SnowflakeID, exact = false): Promise<boolean> {
    const version = ++this.version;
    this.cancel.next();
    this.pendingUpdates.clear();
    this.pageDirection.set(undefined);
    this.isLoading.set(false);
    this.currentError.set(undefined);
    if (exact && this.items().some((message) => message.id === around && !message.isDeleted)) return true;
    if (!around && this.atLatest()) return true;
    this.isLoading.set(true);
    this.needsResync = false;
    try {
      let page = await firstValueFrom(this.getMessages(around ? { around } : {}));
      if (version !== this.version) return false;
      // A reconnect can happen while the first response is in flight. Reconcile once before committing it.
      if ((!page.newerCursor && this.needsResync) || (!page.messages.length && this.latestSeenId)) {
        this.needsResync = false;
        const lastId = page.messages.at(-1)?.id;
        const newer = await firstValueFrom(this.getMessages(lastId ? { after: lastId } : {}));
        if (version !== this.version) return false;
        page = lastId
          ? { ...page, messages: mergeMessages(page.messages, newer.messages), newerCursor: newer.newerCursor }
          : newer;
      }
      page = this.applyPendingUpdates(page);
      // `around` also returns neighbours when the target has been deleted.
      if (exact && !page.messages.some((message) => message.id === around && !message.isDeleted)) {
        this.currentError.set(ConversationError.Missing);
        return false;
      }
      this.currentPage.set(this.withLiveCursor(page));
      return true;
    } catch {
      if (version === this.version) this.currentError.set(ConversationError.Open);
      return false;
    } finally {
      if (version === this.version) {
        this.isLoading.set(false);
        this.pendingUpdates.clear();
      }
    }
  }

  async load(direction: PageDirection, beforeMerge?: () => void | Promise<void>) {
    if (!this.canLoad(direction)) return;
    const current = this.page()!;
    const cursor = direction === PageDirection.Older ? current.olderCursor : current.newerCursor;
    const version = this.version;
    this.pendingUpdates.clear();
    if (direction === PageDirection.Newer) this.needsResync = false;
    this.pageDirection.set(direction);
    this.currentError.set(undefined);
    try {
      const page = await firstValueFrom(
        this.getMessages(direction === PageDirection.Older ? { before: cursor! } : { after: cursor! }),
      );
      if (version !== this.version) return;
      await beforeMerge?.();
      if (version !== this.version) return;
      this.currentPage.update((value) => {
        if (!value) return value;
        const messages = mergeMessages(value.messages, this.applyPendingUpdates(page).messages);
        // Before/after responses only describe the requested edge.
        return direction === PageDirection.Older
          ? { ...value, messages, olderCursor: page.olderCursor }
          : this.withLiveCursor({ ...value, messages, newerCursor: page.newerCursor });
      });
    } catch {
      if (version === this.version) this.currentError.set(ConversationError.Page);
    } finally {
      if (version === this.version) {
        this.pageDirection.set(undefined);
        this.pendingUpdates.clear();
      }
    }
  }

  receive(message: MessageResponse) {
    if (!this.accepts(message)) return;
    if (!this.latestSeenId || message.id > this.latestSeenId) this.latestSeenId = message.id;
    // A live message cannot bridge a gap between historical messages and the present.
    if (!this.atLatest()) return;
    const page = this.page()!;
    this.currentPage.set({ ...page, messages: mergeMessages(page.messages, [message]) });
  }

  private applyMessageChange(event: MessageChange) {
    this.updatePinnedMessages(event);
    switch (event.type) {
      case ServerWsMessageType.messageUpdated:
        this.update(event.payload);
        break;
      case ServerWsMessageType.messageDeleted:
        this.update({ ...event.payload, isDeleted: true });
        break;
      case ServerWsMessageType.messagesBulkDeleted:
        if (event.payload.chatId === this.context?.chatId) {
          for (const id of event.payload.messageIds) this.delete(id);
        }
        break;
      case ServerWsMessageType.reactionUpdated:
        if (event.payload.chatId === this.context?.chatId)
          this.updateReactions(event.payload.messageId, event.payload.reactions);
        break;
    }
  }

  update(message: MessageResponse) {
    if (!this.accepts(message)) return;
    const known = this.items().find((item) => item.id === message.id);
    this.patch(message.id, (current) => ({
      ...message,
      reactions: preserveReactionOwnership(known?.reactions ?? current.reactions, message.reactions),
    }));
  }

  delete(messageId: SnowflakeID) {
    this.patch(messageId, (message) => ({ ...message, isDeleted: true }));
  }

  updateReactions(messageId: SnowflakeID, reactions: ReactionSummary[]) {
    const known = this.items().find((item) => item.id === messageId);
    this.patch(messageId, (message) => ({
      ...message,
      reactions: preserveReactionOwnership(known?.reactions ?? message.reactions, reactions),
    }));
  }

  private patch(messageId: SnowflakeID, update: MessageUpdate) {
    // A response already in flight may contain the pre-event snapshot, including messages not loaded yet.
    if (this.loading() || this.paging()) {
      const previous = this.pendingUpdates.get(messageId);
      this.pendingUpdates.set(messageId, previous ? (message) => update(previous(message)) : update);
    }
    this.currentPage.update(
      (page) =>
        page && {
          ...page,
          messages: page.messages.map((message) => (message.id === messageId ? update(message) : message)),
        },
    );
  }

  private applyPendingUpdates(page: MessageRange): MessageRange {
    return {
      ...page,
      messages: page.messages.map((message) => this.pendingUpdates.get(message.id)?.(message) ?? message),
    };
  }

  accepts(message: MessageResponse) {
    return (
      message.chatId === this.context?.chatId &&
      (this.context?.threadId
        ? message.replyRootId === this.context?.threadId || message.id === this.context?.threadId
        : !message.replyRootId)
    );
  }

  updateThread(update: ThreadUpdatePayload) {
    if (update.chatId !== this.context?.chatId) return;
    this.patch(update.threadRootId, (message) => ({
      ...message,
      threadInfo: update.replyCount > 0 ? { replyCount: update.replyCount } : undefined,
    }));
  }

  private getMessages(params: GetMessagesParams) {
    return this.api.getMessages(this.context!.chatId, { max: 50, ...params, threadId: this.context?.threadId }).pipe(
      map(({ messages, olderCursor, newerCursor }): MessageRange => ({ messages, olderCursor, newerCursor })),
      takeUntil(this.cancel),
      takeUntilDestroyed(this.destroyRef),
    );
  }

  async reconnect() {
    this.needsResync = true;
    if (!this.atLatest()) return;
    const page = this.page()!;
    this.needsResync = false;
    const lastId = page.messages.at(-1)?.id;
    if (!lastId) {
      this.currentPage.set(undefined);
      await this.open();
      return;
    }
    this.currentPage.set({ ...page, newerCursor: lastId });
    // Fetch one batch. Any remaining gap is traversed by normal forward pagination.
    await this.load(PageDirection.Newer);
  }

  private withLiveCursor(page: MessageRange): MessageRange {
    const lastId = page.messages.at(-1)?.id;
    return !page.newerCursor && lastId && (this.needsResync || (this.latestSeenId && this.latestSeenId > lastId))
      ? { ...page, newerCursor: lastId }
      : page;
  }

  pinFor(messageId: SnowflakeID) {
    return this.pins().find((pin) => pin.message.id === messageId);
  }

  ensurePins(): Promise<void> {
    const context = this.context;
    if (!context) return Promise.resolve();
    if (this.pinsFresh) return Promise.resolve();
    const pendingPins = this.pendingPins();
    if (pendingPins) return pendingPins;
    const request = this.loadPins(context).finally(() => {
      if (this.pendingPins() === request) this.pendingPins.set(undefined);
    });
    this.pendingPins.set(request);
    return request;
  }

  private async loadPins(context: ConversationContext) {
    try {
      while (context === this.context && !this.destroyRef.destroyed) {
        const revision = this.pinRevision;
        const { pins } = await this.response(
          (context.threadId
            ? this.pinsApi.listThreadPins(context.chatId, context.threadId)
            : this.pinsApi.listPins(context.chatId)
          ).pipe(takeUntil(this.cancelPins)),
        );
        if (context !== this.context) return;
        if (revision !== this.pinRevision) continue;
        this.pinItems.set(pins);
        this.pinsFresh = true;
        return;
      }
    } catch (error: unknown) {
      if (context !== this.context) return;
      throw error;
    }
  }

  private applyPin(id: SnowflakeID, pin?: PinResponse) {
    this.pinRevision++;
    this.pinItems.update((pins) => {
      const remaining = pins.filter((existing) => existing.id !== id);
      return pin ? [pin, ...remaining] : remaining;
    });
  }

  private updatePinnedMessages(event: MessageChange) {
    if (event.payload.chatId !== this.context?.chatId) return;
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

  async setPinned(message: MessageResponse, pinned: boolean) {
    const context = this.context;
    if (!context) return;
    await this.ensurePins();
    if (context !== this.context) return;
    const existing = this.pinFor(message.id);
    if (pinned === !!existing) return;
    if (existing) {
      await this.response(
        context.threadId
          ? this.pinsApi.deleteThreadPin(context.chatId, context.threadId, existing.id)
          : this.pinsApi.deletePin(context.chatId, existing.id),
      );
      if (context === this.context)
        this.realtime.acceptPin({
          type: context.threadId ? ServerWsMessageType.threadPinRemoved : ServerWsMessageType.pinRemoved,
          payload: {
            chatId: context.chatId,
            threadRootId: context.threadId,
            messageId: message.id,
            pinId: existing.id,
          },
        });
      return;
    }

    const revision = this.pinRevision;
    const pin = await this.response(
      context.threadId
        ? this.pinsApi.createThreadPin(context.chatId, context.threadId, { messageId: message.id })
        : this.pinsApi.createPin(context.chatId, { messageId: message.id }),
    );
    if (context !== this.context) return;
    if (revision === this.pinRevision)
      this.realtime.acceptPin({
        type: context.threadId ? ServerWsMessageType.threadPinAdded : ServerWsMessageType.pinAdded,
        payload: { chatId: context.chatId, threadRootId: context.threadId, messageId: message.id, pinId: pin.id, pin },
      });
    else if (!this.pins().some((current) => current.id === pin.id)) {
      // A removal can arrive before the create response; do not restore that older pin.
      this.pinsFresh = false;
      await this.ensurePins().catch(() => {});
    }
  }
}
