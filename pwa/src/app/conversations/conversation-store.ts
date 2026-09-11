import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, map, Subject, takeUntil } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import {
  ServerWsMessageType,
  type GetMessagesParams,
  type ListMessagesResponse,
  type MessageResponse,
  type ReactionSummary,
  type ThreadUpdatePayload,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { type SnowflakeID } from '../api/snowflake-id';
import { type MessageChange } from '../messages/message-change';
import { mergeMessages } from '../messages/message-merge';
import { preserveReactionOwnership } from '../messages/reaction-state';
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
  private readonly realtime = inject(Connection);
  private context?: ConversationContext;

  constructor() {
    this.destroyRef.onDestroy(() => this.reset());
    this.realtime.changes$.pipe(takeUntilDestroyed()).subscribe((event) => this.applyMessageChange(event));
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === ServerWsMessageType.threadUpdate) this.updateThread(event.payload);
    });
  }

  canLoad(direction: PageDirection) {
    const page = this.page();
    const cursor = direction === PageDirection.Older ? page?.olderCursor : page?.newerCursor;
    return !!cursor && !this.loading() && !this.paging();
  }

  reset(chatId?: SnowflakeID, threadId?: SnowflakeID) {
    this.context = chatId ? { chatId, threadId } : undefined;
    this.cancelLoading();
    this.latestSeenId = undefined;
    this.needsResync = false;
    this.currentPage.set(undefined);
  }

  cancelLoading() {
    this.version++;
    this.cancel.next();
    this.pendingUpdates.clear();
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
}
