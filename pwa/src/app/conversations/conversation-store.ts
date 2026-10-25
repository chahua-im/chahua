import { isMembershipMessage } from '../messages/system-message';
import { ChatSettingsChanged, SessionStore } from '../session/session-store';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, map, Subject, takeUntil } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import {
  ServerWsMessageType,
  GroupKind,
  type GetMessagesParams,
  type ListMessagesResponse,
  type MessagePreview,
  type MessageResponse,
  type ReactionSummary,
  type ThreadUpdatePayload,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { ChatChangeKind, ChatStore } from '../chats/chat-store';
import { type SnowflakeID } from '../api/snowflake-id';
import { type MessageChange } from '../messages/message-change';
import { mergeMessages } from '../messages/message-merge';
import { isVisibleMessage } from '../messages/message-visibility';
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
type MessageRange = Pick<
  ListMessagesResponse,
  'messages' | 'olderCursor' | 'newerCursor' | 'chatSettings' | 'membershipMessagePolicy'
>;
type MessageUpdate = (message: MessageResponse) => MessageResponse;
type ConversationContext = Readonly<{ chatId: SnowflakeID; threadId?: SnowflakeID }>;
@Injectable()
export class ConversationStore {
  private readonly api = inject(ChatsService);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private version = 0;
  private readonly cancel = new Subject<void>();
  private latestSeenId?: SnowflakeID;
  hideMembershipMessages = false;
  private pageHidesMembershipMessages = false;
  private needsResync = false;
  private readonly pendingUpdates = new Map<SnowflakeID, MessageUpdate>();
  /** Ids recalled in this context; their snapshots inside quoting messages must be redacted too. */
  private readonly deletedIds = new Set<SnowflakeID>();
  /** Latest previews of messages updated in this context; quoting messages' snapshots refresh from here. */
  private readonly editedPreviews = new Map<SnowflakeID, MessagePreview>();
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
  private readonly chatInfo = inject(ChatStore);
  private context?: ConversationContext;

  constructor() {
    this.destroyRef.onDestroy(() => this.reset());
    this.chatInfo.changes$.pipe(takeUntilDestroyed()).subscribe(({ kind, chatId }) => {
      if (kind !== ChatChangeKind.MembershipMessagePolicy || chatId !== this.context?.chatId || this.context.threadId)
        return;
      if (this.chatInfo.membershipPolicy(chatId)?.canView === false) {
        this.currentPage.update(
          (page) => page && { ...page, messages: page.messages.filter((message) => !isMembershipMessage(message)) },
        );
      }
    });
    this.realtime.changes$.pipe(takeUntilDestroyed()).subscribe((event) => this.applyMessageChange(event));
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === ServerWsMessageType.threadUpdate) this.updateThread(event.payload);
    });
  }

  canLoad(direction: PageDirection) {
    const page = this.page();
    const cursor = direction === PageDirection.Older ? page?.olderCursor : page?.newerCursor;
    return (
      !!cursor && !this.loading() && !this.paging() && this.pageHidesMembershipMessages === this.hideMembershipMessages
    );
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
    this.deletedIds.clear();
    this.editedPreviews.clear();
    this.isLoading.set(false);
    this.pageDirection.set(undefined);
    this.currentError.set(undefined);
  }

  async open(
    around?: SnowflakeID,
    exact = false,
    hideMembershipMessages = this.hideMembershipMessages,
  ): Promise<boolean> {
    // Returning to the retained page's filter still needs a fresh read: arrivals
    // during the cancelled refresh may have been deferred or hidden.
    const filterChanged =
      this.hideMembershipMessages !== hideMembershipMessages ||
      this.pageHidesMembershipMessages !== hideMembershipMessages;
    this.hideMembershipMessages = hideMembershipMessages;
    // Events seen under the previous preference cannot describe gaps in the new range.
    if (filterChanged) this.latestSeenId = undefined;
    const version = ++this.version;
    this.cancel.next();
    this.pendingUpdates.clear();
    this.deletedIds.clear();
    this.editedPreviews.clear();
    this.pageDirection.set(undefined);
    this.isLoading.set(false);
    this.currentError.set(undefined);
    if (
      !this.needsResync &&
      !filterChanged &&
      exact &&
      this.items().some((message) => message.id === around && isVisibleMessage(message))
    )
      return true;
    if (!this.needsResync && !filterChanged && !around && this.atLatest()) return true;
    this.isLoading.set(true);
    this.needsResync = false;
    try {
      const mentionVersion = this.chatInfo.snapshot();
      const policyGeneration = this.chatInfo.membershipPolicyRequestGeneration();
      const user = this.session.user();
      let page = await firstValueFrom(this.getMessages(around ? { around } : {}, user));
      if (version !== this.version) return false;
      // A reconnect can happen while the first response is in flight. Reconcile once before committing it.
      if ((!page.newerCursor && this.needsResync) || (!page.messages.length && this.latestSeenId)) {
        this.needsResync = false;
        const lastId = page.messages.at(-1)?.id;
        const newer = await firstValueFrom(this.getMessages(lastId ? { after: lastId } : {}, user));
        if (version !== this.version) return false;
        page = lastId
          ? {
              ...page,
              messages: mergeMessages(page.messages, newer.messages),
              newerCursor: newer.newerCursor,
            }
          : newer;
      }
      if (policyGeneration !== this.chatInfo.membershipPolicyRequestGeneration()) throw new ChatSettingsChanged();
      page = this.applyPendingUpdates(page);
      this.chatInfo.rememberMentions(page.messages, mentionVersion);
      // `around` also returns neighbours when the target has been deleted.
      if (exact && !page.messages.some((message) => message.id === around && isVisibleMessage(message))) {
        this.currentError.set(ConversationError.Missing);
        return false;
      }
      this.pageHidesMembershipMessages = hideMembershipMessages;
      this.currentPage.set(this.withLiveCursor(page));
      return true;
    } catch (error) {
      if (version === this.version && error instanceof ChatSettingsChanged) {
        return this.open(
          around,
          exact,
          this.filtersMembershipMessages() &&
            (!(this.session.user()?.showMembershipMessages ?? true) ||
              this.chatInfo.membershipPolicy(this.context!.chatId)?.canView === false),
        );
      }
      if (version === this.version) {
        this.needsResync = true;
        this.currentError.set(ConversationError.Open);
      }
      return false;
    } finally {
      if (version === this.version) {
        this.isLoading.set(false);
        this.pendingUpdates.clear();
        this.deletedIds.clear();
        this.editedPreviews.clear();
      }
    }
  }

  async load(direction: PageDirection, beforeMerge?: () => void | Promise<void>) {
    if (!this.canLoad(direction)) return;
    const current = this.page()!;
    const user = this.session.user();
    const policyGeneration = this.chatInfo.membershipPolicyRequestGeneration();
    const cursor = direction === PageDirection.Older ? current.olderCursor : current.newerCursor;
    const version = this.version;
    this.pendingUpdates.clear();
    this.deletedIds.clear();
    this.editedPreviews.clear();
    if (direction === PageDirection.Newer) this.needsResync = false;
    this.pageDirection.set(direction);
    this.currentError.set(undefined);
    try {
      const mentionVersion = this.chatInfo.snapshot();
      const page = await firstValueFrom(
        this.getMessages(direction === PageDirection.Older ? { before: cursor! } : { after: cursor! }, user),
      );
      if (version !== this.version) return;
      if (this.hidesMembershipMessages(page) !== this.hidesMembershipMessages(current)) throw new ChatSettingsChanged();
      this.chatInfo.rememberMentions(page.messages, mentionVersion);
      await beforeMerge?.();
      if (version !== this.version) return;
      this.session.requireChatSettings(
        page.chatSettings,
        user,
        this.filtersMembershipMessages() && page.membershipMessagePolicy?.canView !== false,
      );
      if (!this.chatInfo.acceptMembershipPolicy(this.context!.chatId, page.membershipMessagePolicy, policyGeneration))
        throw new ChatSettingsChanged();
      this.currentPage.update((value) => {
        if (!value) return value;
        const messages = mergeMessages(value.messages, this.applyPendingUpdates(page).messages);
        const updated = {
          ...value,
          chatSettings: page.chatSettings,
          membershipMessagePolicy: page.membershipMessagePolicy,
          messages,
        };
        // Before/after responses only describe the requested edge.
        return direction === PageDirection.Older
          ? { ...updated, olderCursor: page.olderCursor }
          : this.withLiveCursor({ ...updated, newerCursor: page.newerCursor });
      });
    } catch (error) {
      if (version === this.version && !(error instanceof ChatSettingsChanged))
        this.currentError.set(ConversationError.Page);
    } finally {
      if (version === this.version) {
        this.pageDirection.set(undefined);
        this.pendingUpdates.clear();
        this.deletedIds.clear();
        this.editedPreviews.clear();
      }
    }
  }

  receive(message: MessageResponse) {
    if (
      !this.accepts(message) ||
      ((this.hideMembershipMessages || this.chatInfo.membershipPolicy(message.chatId)?.canView === false) &&
        isMembershipMessage(message))
    )
      return;
    if (!this.latestSeenId || message.id > this.latestSeenId) this.latestSeenId = message.id;
    // A live message cannot bridge a gap between historical messages and the present.
    if (!this.atLatest()) return;
    const page = this.page()!;
    this.currentPage.set({
      ...page,
      messages: mergeMessages(page.messages, [message]),
    });
  }

  private applyMessageChange(event: MessageChange) {
    switch (event.type) {
      case ServerWsMessageType.messageUpdated:
        this.update(event.payload);
        break;
      case ServerWsMessageType.messageDeleted:
        this.update({ ...event.payload, isDeleted: true });
        if (this.accepts(event.payload)) this.restoreChatPreview(new Set([event.payload.id]));
        break;
      case ServerWsMessageType.messagesBulkDeleted:
        if (event.payload.chatId === this.context?.chatId) {
          for (const id of event.payload.messageIds) this.delete(id);
          this.restoreChatPreview(new Set(event.payload.messageIds));
        }
        break;
      case ServerWsMessageType.reactionUpdated:
        if (event.payload.chatId === this.context?.chatId)
          this.updateReactions(event.payload.messageId, event.payload.reactions);
        break;
    }
  }

  private restoreChatPreview(deletedIds: ReadonlySet<SnowflakeID>) {
    if (!this.context || !this.atLatest() || this.pageHidesMembershipMessages) return;
    const { chatId, threadId } = this.context;
    const page = this.page()!;
    const previous = page.messages
      .filter((message) => !message.isDeleted && (threadId ? message.replyRootId === threadId : !message.replyRootId))
      .at(-1);
    // An empty partial range says nothing about messages beyond its older edge.
    if (!previous && page.olderCursor) return;
    const knownDeleted = new Set(page.messages.filter((message) => deletedIds.has(message.id)).map(({ id }) => id));
    if (threadId) {
      const restored = this.chatInfo.restoreThreadPreview(chatId, threadId, knownDeleted, previous);
      if (restored && !previous) this.patch(threadId, (message) => ({ ...message, threadInfo: undefined }));
    } else this.chatInfo.restoreChatPreview(chatId, knownDeleted, previous);
  }

  update(message: MessageResponse) {
    if (!this.accepts(message)) return;
    if (message.isDeleted) this.deletedIds.add(message.id);
    else this.editedPreviews.set(message.id, toMessagePreview(message));
    const known = this.items().find((item) => item.id === message.id);
    this.patch(message.id, (current) => ({
      ...message,
      reactions: preserveReactionOwnership(known?.reactions ?? current.reactions, message.reactions),
    }));
  }

  delete(messageId: SnowflakeID) {
    this.deletedIds.add(messageId);
    // Bulk deletion carries ids only, so the recalled body must be dropped here.
    this.patch(messageId, (message) => ({
      ...message,
      isDeleted: true,
      forwardedFrom: undefined,
      forwardedPreview: undefined,
      forwardedBundleId: undefined,
      message: undefined,
      attachments: [],
      mentions: [],
      sticker: undefined,
    }));
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
          messages: page.messages.map((message) =>
            message.id === messageId ? update(message) : this.refreshCitation(message),
          ),
        },
    );
  }

  private applyPendingUpdates(page: MessageRange): MessageRange {
    return {
      ...page,
      messages: page.messages.map((message) =>
        this.refreshCitation(this.pendingUpdates.get(message.id)?.(message) ?? message),
      ),
    };
  }

  /** The recalled message stays in the timeline as a tombstone; messages quoting it lose their snapshot. */
  private redactCitation(message: MessageResponse) {
    const quote = message.replyToMessage;
    if (!quote || !this.deletedIds.has(quote.id)) return message;
    return {
      ...message,
      replyToMessage: {
        ...quote,
        isDeleted: true,
        message: undefined,
        attachments: [],
        mentions: [],
        sticker: undefined,
      },
    };
  }

  /** Quoting messages embed a server snapshot of the cited message; edits and recalls reach them through here. */
  private refreshCitation(message: MessageResponse): MessageResponse {
    const quote = message.replyToMessage;
    if (!quote) return message;
    if (this.deletedIds.has(quote.id)) return this.redactCitation(message);
    const fresh = this.editedPreviews.get(quote.id);
    return fresh ? { ...message, replyToMessage: fresh } : message;
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

  private filtersMembershipMessages() {
    return !this.context?.threadId && this.chatInfo.get(this.context!.chatId)?.kind !== GroupKind.dm;
  }

  private hidesMembershipMessages(page: Pick<MessageRange, 'chatSettings' | 'membershipMessagePolicy'>) {
    return (
      this.filtersMembershipMessages() &&
      (!page.chatSettings.showMembershipMessages || page.membershipMessagePolicy?.canView === false)
    );
  }

  private getMessages(params: GetMessagesParams, user = this.session.user()) {
    const policyGeneration = this.chatInfo.membershipPolicyRequestGeneration();
    return this.api
      .getMessages(this.context!.chatId, {
        max: 50,
        ...params,
        threadId: this.context?.threadId,
      })
      .pipe(
        map(({ chatSettings, messages, olderCursor, newerCursor, membershipMessagePolicy }): MessageRange => {
          // A group restriction already hides these messages regardless of the account preference.
          this.session.requireChatSettings(
            chatSettings,
            user,
            this.filtersMembershipMessages() && membershipMessagePolicy?.canView !== false,
          );
          if (!this.chatInfo.acceptMembershipPolicy(this.context!.chatId, membershipMessagePolicy, policyGeneration))
            throw new ChatSettingsChanged();
          const hidden = this.hidesMembershipMessages({ chatSettings, membershipMessagePolicy });
          if (membershipMessagePolicy && hidden !== this.hideMembershipMessages) throw new ChatSettingsChanged();
          return { chatSettings, messages, olderCursor, newerCursor, membershipMessagePolicy };
        }),
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
      this.needsResync = true;
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

/** Mirrors the server's MessagePreview shape embedded as replyToMessage. */
function toMessagePreview(message: MessageResponse): MessagePreview {
  return {
    id: message.id,
    clientGeneratedId: message.clientGeneratedId,
    forwardedFromName: message.forwardedFrom?.sender.name,
    createdAt: message.createdAt,
    sender: message.sender,
    message: message.message,
    messageType: message.messageType,
    systemKind: message.systemKind,
    systemLinks: message.systemLinks,
    sticker: message.sticker ? { emoji: message.sticker.emoji } : undefined,
    attachments: message.attachments.map(({ kind }) => ({ kind })),
    isDeleted: message.isDeleted,
    mentions: message.mentions ?? [],
  };
}
