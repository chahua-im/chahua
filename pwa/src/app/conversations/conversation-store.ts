import { isMembershipMessage } from '../messages/system-message';
import { ChatSettingsChanged, SessionStore } from '../session/session-store';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, map, Subject, takeUntil } from 'rxjs';
import { RpcApi } from '../../generated/rpc-api';
import type { MessagesListParams } from '../../generated/rpc-models';
import {
  ServerWsMessageType,
  GroupKind,
  type MessagePreview,
  type MessageResponse,
  type MessageSyncReset,
  type ReactionSummary,
  type ThreadUpdatePayload,
} from '../../generated/models';
import { Connection, ResyncReason } from '../api/connection';
import { ChatChangeKind, ChatStore } from '../chats/chat-store';
import { decodeId, type SnowflakeID } from '../api/snowflake-id';
import {
  messageChangePatch,
  redactDeletedMessage,
  redactRecalledCitations,
  redactRemovedMessage,
  replaceEditedMessage,
  replaceMessageCitation,
  toMessagePreview,
  type MessageChange,
} from '../messages/message-change';
import { mergeMessageArrivals, mergeMessages, patchItems } from '../messages/message-merge';
import { isVisibleMessage } from '../messages/message-visibility';
import { MessageSync, requiresMessagePurge } from '../messages/message-sync';
import { preserveReactionOwnership } from '../messages/reaction-state';
import { Diagnostics } from '../pwa/diagnostics';
import { acceptsConversationMessage, type ConversationContext, type MessageRange } from './conversation-window';
import { RecentConversationWindows } from './recent-conversation-windows';
export enum PageDirection {
  Older,
  Newer,
}
export enum ConversationError {
  Missing = 1,
  Open,
  Page,
}
type MessageUpdate = (message: MessageResponse) => MessageResponse;
type MessagePageParams = Omit<MessagesListParams, 'chatId' | 'max' | 'threadId'>;

interface SyncWindow {
  around?: SnowflakeID;
  latestAnchor?: () => SnowflakeID | undefined;
  restore?: () => void;
}

interface WindowRead {
  around?: SnowflakeID;
  policyGeneration: number;
  viewport?: SyncWindow;
  received?: boolean;
}

class InaccessibleMessagePage extends Error {}
@Injectable()
export class ConversationStore {
  private readonly api = inject(RpcApi);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly diagnostics = inject(Diagnostics);
  private readonly sync = inject(MessageSync);
  private readonly recent = inject(RecentConversationWindows);
  private version = 0;
  private readonly cancel = new Subject<void>();
  private latestSeenId?: SnowflakeID;
  hideMembershipMessages = false;
  private pageHidesMembershipMessages = false;
  private needsResync = false;
  private retryNewer = false;
  private needsWindow = false;
  private alignedGeneration?: number;
  private readSyncWindow?: () => SyncWindow | undefined;
  private windowRead?: WindowRead;
  private retryReplacement?: () => void;
  private readonly pendingCreates = new Map<SnowflakeID, MessageResponse>();
  private readonly pendingUpdates = new Map<SnowflakeID, MessageUpdate>();
  /** Ids recalled in this context; their snapshots inside quoting messages must be redacted too. */
  private readonly deletedIds = new Set<SnowflakeID>();
  /** Latest previews of messages updated in this context; quoting messages' snapshots refresh from here. */
  private readonly editedPreviews = new Map<SnowflakeID, MessagePreview>();
  private readonly currentPage = signal<MessageRange | undefined>(undefined);
  private readonly replacedWindows = new Subject<MessageRange>();
  readonly replacedWindows$ = this.replacedWindows.asObservable();
  private readonly isLoading = signal(false);
  private readonly pageDirection = signal<PageDirection | undefined>(undefined);
  private readonly currentError = signal<ConversationError | undefined>(undefined);
  private readonly failedPageDirection = signal<PageDirection | undefined>(undefined);
  private readonly restoredRange = signal(false);
  readonly provisional = this.restoredRange.asReadonly();
  readonly page = this.currentPage.asReadonly();
  readonly items = computed(() => this.page()?.messages ?? []);
  readonly loading = this.isLoading.asReadonly();
  readonly pagingDirection = this.pageDirection.asReadonly();
  readonly paging = computed(() => this.pageDirection() !== undefined);
  readonly error = this.currentError.asReadonly();
  readonly errorDirection = computed(() =>
    this.error() === ConversationError.Page ? this.failedPageDirection() : undefined,
  );
  readonly atLatest = computed(() => !!this.page() && !this.page()?.newerCursor && !this.loading());
  private readonly realtime = inject(Connection);
  private readonly chatInfo = inject(ChatStore);
  private context?: ConversationContext;
  private contextAccount?: number;

  constructor() {
    this.destroyRef.onDestroy(() => this.reset());
    this.chatInfo.changes$.pipe(takeUntilDestroyed()).subscribe(({ kind, chatId, threadId }) => {
      if (chatId !== this.context?.chatId) return;
      if (kind === ChatChangeKind.Removed && (threadId == null || threadId === this.context.threadId)) {
        this.clearInaccessiblePage();
        return;
      }
      if (kind !== ChatChangeKind.MembershipMessagePolicy || this.context.threadId) return;
      this.alignedGeneration = undefined;
      if (this.chatInfo.membershipPolicy(chatId)?.canView === false) {
        this.currentPage.update(
          (page) => page && { ...page, messages: page.messages.filter((message) => !isMembershipMessage(message)) },
        );
      }
    });
    this.realtime.changes$.pipe(takeUntilDestroyed()).subscribe((event) => this.applyMessageChange(event));
    this.realtime.messages$.pipe(takeUntilDestroyed()).subscribe((message) => {
      if (this.sync.active()) this.receive(message);
    });
    this.sync.resets$.pipe(takeUntilDestroyed()).subscribe((reset) => this.receiveReset(reset));
    this.sync.accountResets$.pipe(takeUntilDestroyed()).subscribe(() => this.reset());
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe((reason) => {
      if (reason === ResyncReason.Connected && !this.sync.active()) this.alignedGeneration = undefined;
    });
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === ServerWsMessageType.threadUpdate && !this.sync.active()) this.updateThread(event.payload);
    });
  }

  /** The page owns geometry; the store owns cancellation and window replacement. */
  setSyncWindow(readWindow: () => SyncWindow | undefined) {
    this.readSyncWindow = readWindow;
  }

  private syncWindow(includeRetained = false): SyncWindow | undefined {
    const visible = this.readSyncWindow?.();
    if (visible || (this.readSyncWindow && !includeRetained)) return visible;
    const page = this.page();
    return { around: page?.newerCursor != null ? page.messages[Math.floor(page.messages.length / 2)]?.id : undefined };
  }

  private receiveReset({ chatId, reason }: MessageSyncReset) {
    if (chatId !== this.context?.chatId) return;
    const page = this.page();
    const purge = requiresMessagePurge(reason);
    if (!page && !purge) return;
    const recovery = this.syncWindow();
    const pending = this.windowRead;
    this.needsWindow = true;
    this.alignedGeneration = undefined;
    this.retryNewer = false;
    this.latestSeenId = undefined;
    const provisional = this.provisional();
    if (purge) {
      this.currentPage.set(undefined);
      this.restoredRange.set(false);
    }
    if (pending && !pending.received && (provisional || (recovery && (!page || pending.around === recovery.around)))) {
      // This scope already awaits a replacing page. A page-triggered reset
      // precedes its PageResult, so retrying here would discard a fresh snapshot.
      pending.policyGeneration = this.chatInfo.membershipPolicyRequestGeneration();
      if (!provisional) pending.viewport = recovery;
      return;
    }
    if (provisional && !purge && !pending) return;
    this.cancelLoading();
    if (recovery) void this.open(recovery.around, false, this.hideMembershipMessages, recovery);
  }

  canLoad(direction: PageDirection) {
    const page = this.page();
    const cursor = direction === PageDirection.Older ? page?.olderCursor : page?.newerCursor;
    return (
      !!cursor &&
      !this.needsWindow &&
      !this.provisional() &&
      !this.loading() &&
      !this.paging() &&
      this.pageHidesMembershipMessages === this.hideMembershipMessages
    );
  }

  reset(chatId?: SnowflakeID, threadId?: SnowflakeID) {
    this.context = chatId ? { chatId, threadId } : undefined;
    this.contextAccount = this.session.user()?.uid;
    this.cancelLoading();
    this.latestSeenId = undefined;
    this.needsResync = false;
    this.needsWindow = false;
    this.alignedGeneration = undefined;
    this.restoredRange.set(false);
    this.retryNewer = false;
    this.currentPage.set(undefined);
  }

  retainRecent(anchor?: SnowflakeID, atBottom = false) {
    const scope = this.context;
    const range = this.page();
    if (!scope || !range || this.contextAccount !== this.session.user()?.uid) return;
    this.recent.keep(scope, {
      range,
      anchor,
      atBottom,
      hideMembershipMessages: this.pageHidesMembershipMessages,
      alignedGeneration: this.needsWindow || this.needsResync ? undefined : this.alignedGeneration,
    });
  }

  takeRecent(hideMembershipMessages: boolean) {
    if (!this.context) return undefined;
    const saved = this.recent.take(this.context, hideMembershipMessages);
    if (!saved) return undefined;
    this.hideMembershipMessages = this.pageHidesMembershipMessages = saved.hideMembershipMessages;
    this.alignedGeneration = saved.alignedGeneration;
    this.restoredRange.set(true);
    this.currentPage.set(saved.range);
    return { anchor: saved.anchor, atBottom: saved.atBottom };
  }

  private hasSyncAlignment() {
    return (
      this.sync.active() &&
      this.alignedGeneration != null &&
      this.context != null &&
      (this.alignedGeneration === this.sync.connectionGeneration || this.sync.isCovered(this.context.chatId))
    );
  }

  private clearInaccessiblePage() {
    this.reset(this.context!.chatId, this.context!.threadId);
    this.currentError.set(ConversationError.Open);
  }

  cancelLoading() {
    this.version++;
    this.cancel.next();
    this.clearPatches();
    this.windowRead = undefined;
    this.retryReplacement = undefined;
    this.isLoading.set(false);
    this.pageDirection.set(undefined);
    this.currentError.set(undefined);
  }

  async open(
    around?: SnowflakeID,
    exact = false,
    hideMembershipMessages = this.hideMembershipMessages,
    viewport?: SyncWindow,
  ): Promise<boolean> {
    this.retryReplacement = undefined;
    this.retryNewer = false;
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
    this.clearPatches();
    this.windowRead = undefined;
    this.pageDirection.set(undefined);
    this.isLoading.set(false);
    this.currentError.set(undefined);
    const provisional = this.provisional();
    if (provisional) {
      if (filterChanged) {
        this.currentPage.set(undefined);
        this.restoredRange.set(false);
        this.alignedGeneration = undefined;
      } else {
        if (!this.realtime.connected()) return false;
        try {
          await this.sync.waitForResume();
        } catch {
          return false;
        }
        if (version !== this.version) return false;
        const page = this.page();
        if (
          page &&
          !this.needsWindow &&
          this.hasSyncAlignment() &&
          (around == null
            ? page.newerCursor == null
            : exact
              ? page.messages.some((message) => message.id === around && isVisibleMessage(message))
              : page.messages.length > 0 && page.messages[0].id <= around && around <= page.messages.at(-1)!.id)
        ) {
          this.alignedGeneration = this.sync.connectionGeneration;
          this.needsResync = false;
          this.restoredRange.set(false);
          return true;
        }
      }
      this.needsWindow = true;
    }
    if (
      !this.needsResync &&
      !this.needsWindow &&
      !filterChanged &&
      exact &&
      this.items().some((message) => message.id === around && isVisibleMessage(message))
    )
      return true;
    if (!this.needsResync && !this.needsWindow && !filterChanged && !around && this.atLatest()) return true;
    this.isLoading.set(true);
    this.needsResync = false;
    const windowRead: WindowRead = {
      around,
      viewport,
      policyGeneration: this.chatInfo.membershipPolicyRequestGeneration(),
    };
    this.windowRead = windowRead;
    const sync = this.sync.active();
    const startedAt = performance.now();
    try {
      const mentionVersion = this.chatInfo.snapshot();
      const user = this.session.user();
      let page = await firstValueFrom(this.getMessages(around ? { around } : {}, user, windowRead));
      if (version !== this.version) return false;
      // A reconnect can happen while the first response is in flight. Reconcile once before committing it.
      if (
        !provisional &&
        !sync &&
        ((!page.newerCursor && this.needsResync) || (!page.messages.length && this.latestSeenId))
      ) {
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
      if (windowRead.policyGeneration !== this.chatInfo.membershipPolicyRequestGeneration())
        throw new ChatSettingsChanged();
      if (this.provisional()) {
        // An unedited history row predates any confirmed edit in the retained window.
        const edits = new Map(
          this.items()
            .filter((row) => row.isEdited && !row.isDeleted)
            .map((row) => [row.id, row]),
        );
        page.messages = page.messages.map((row) => {
          const edit = edits.get(row.id);
          if (!edit || row.isEdited || row.isDeleted) return row;
          return {
            ...row,
            isEdited: true,
            message: edit.message,
            metadata: edit.metadata,
            mentions: edit.mentions,
            hasAttachments: edit.hasAttachments,
            attachments: edit.attachments,
          };
        });
      }
      page = this.applyPendingUpdates(page, sync && !page.newerCursor, sync && !page.olderCursor);
      const latestAnchor = windowRead.viewport?.latestAnchor?.();
      if (
        latestAnchor != null &&
        latestAnchor !== around &&
        ((page.olderCursor && latestAnchor < page.olderCursor) || (page.newerCursor && latestAnchor > page.newerCursor))
      ) {
        // Keep the existing window until a replacement covers the new reading position.
        return this.open(latestAnchor, false, hideMembershipMessages, windowRead.viewport);
      }
      this.chatInfo.rememberMentions(page.messages, mentionVersion);
      // `around` also returns neighbours when the target has been deleted.
      const missing = exact && !page.messages.some((message) => message.id === around && isVisibleMessage(message));
      if (missing && !this.needsWindow) {
        this.currentError.set(ConversationError.Missing);
        return false;
      }
      const replaced = this.needsWindow;
      this.pageHidesMembershipMessages = this.hideMembershipMessages;
      this.needsWindow = false;
      this.alignedGeneration = sync ? this.sync.connectionGeneration : undefined;
      const nextPage = sync ? page : this.withLiveCursor(page);
      this.currentPage.set(nextPage);
      this.restoredRange.set(false);
      if (replaced) this.replacedWindows.next(nextPage);
      windowRead.viewport?.restore?.();
      if (missing) this.currentError.set(ConversationError.Missing);
      return !missing;
    } catch (error) {
      if (version === this.version && error instanceof ChatSettingsChanged) {
        return this.open(
          around,
          exact,
          this.filtersMembershipMessages() &&
            (!(this.session.user()?.showMembershipMessages ?? true) ||
              this.chatInfo.membershipPolicy(this.context!.chatId)?.canView === false),
          windowRead.viewport,
        );
      }
      if (version === this.version && error instanceof InaccessibleMessagePage) {
        this.clearInaccessiblePage();
        return false;
      }
      if (version === this.version) {
        this.diagnostics.recordError('conversation.open.failed', error, {
          operation: sync ? 'messageSync.page' : 'messages.list',
          chatId: this.context && decodeId(this.context.chatId),
          threadId: this.context?.threadId != null ? decodeId(this.context.threadId) : undefined,
          durationMs: Math.round(performance.now() - startedAt),
        });
        void this.diagnostics.captureWorker();
        this.needsResync = true;
        if (windowRead.viewport?.restore)
          this.retryReplacement = () => void this.open(around, exact, this.hideMembershipMessages, windowRead.viewport);
        this.currentError.set(ConversationError.Open);
      }
      return false;
    } finally {
      if (version === this.version) {
        this.isLoading.set(false);
        this.clearPatches();
        this.windowRead = undefined;
      }
    }
  }

  retrySyncWindow() {
    const retry = this.retryReplacement;
    if (!retry) return false;
    retry();
    return true;
  }

  async load(direction: PageDirection, beforeMerge?: () => void | Promise<void>) {
    if (!this.canLoad(direction)) return;
    const current = this.page()!;
    const user = this.session.user();
    const policyGeneration = this.chatInfo.membershipPolicyRequestGeneration();
    const cursor = direction === PageDirection.Older ? current.olderCursor : current.newerCursor;
    const version = this.version;
    this.clearPatches();
    const sync = this.sync.active();
    if (direction === PageDirection.Newer) this.needsResync = false;
    this.pageDirection.set(direction);
    this.currentError.set(undefined);
    const startedAt = performance.now();
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
        const combined = mergeMessages(value.messages, this.applyPendingUpdates(page).messages);
        const messages = mergeMessageArrivals(
          combined,
          [...this.pendingCreates.values()].map((message) => this.applyPendingUpdate(message)),
          sync && direction === PageDirection.Newer && !page.newerCursor,
          sync && !(direction === PageDirection.Older ? page.olderCursor : value.olderCursor),
        );
        const updated = {
          ...value,
          chatSettings: page.chatSettings,
          membershipMessagePolicy: page.membershipMessagePolicy,
          messages,
        };
        // Before/after responses only describe the requested edge.
        return direction === PageDirection.Older
          ? { ...updated, olderCursor: page.olderCursor }
          : sync
            ? { ...updated, newerCursor: page.newerCursor }
            : this.withLiveCursor({ ...updated, newerCursor: page.newerCursor });
      });
      if (direction === PageDirection.Newer) this.retryNewer = false;
    } catch (error) {
      if (version === this.version && error instanceof InaccessibleMessagePage) {
        this.clearInaccessiblePage();
        return;
      }
      if (version === this.version && !(error instanceof ChatSettingsChanged)) {
        this.diagnostics.recordError('conversation.page.failed', error, {
          operation: sync ? 'messageSync.page' : 'messages.list',
          chatId: this.context && decodeId(this.context.chatId),
          threadId: this.context?.threadId != null ? decodeId(this.context.threadId) : undefined,
          direction: PageDirection[direction],
          durationMs: Math.round(performance.now() - startedAt),
        });
        void this.diagnostics.captureWorker();
        this.failedPageDirection.set(direction);
        this.currentError.set(ConversationError.Page);
      }
    } finally {
      if (version === this.version) {
        this.pageDirection.set(undefined);
        this.clearPatches();
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
    const incoming = this.refreshCitation(message);
    if (this.sync.active() && (this.loading() || this.paging())) this.pendingCreates.set(message.id, incoming);
    const page = this.page();
    if (!page) return;
    const aligned =
      !this.needsWindow && (!this.provisional() || (this.sync.active() && this.alignedGeneration != null));
    const messages = mergeMessageArrivals(
      page.messages,
      [incoming],
      aligned && this.atLatest(),
      incoming.isDeleted && aligned && !this.loading() && page.olderCursor == null,
    );
    if (messages !== page.messages) this.currentPage.set({ ...page, messages });
  }

  private applyMessageChange(event: MessageChange) {
    switch (event.type) {
      case ServerWsMessageType.messageUpdated:
      case ServerWsMessageType.messageDeleted: {
        const message =
          event.type === ServerWsMessageType.messageDeleted ? { ...event.payload, isDeleted: true } : event.payload;
        if (!this.accepts(message)) break;
        if (event.type === ServerWsMessageType.messageDeleted && event.fromRecallRpc) {
          this.deletedIds.add(message.id);
          this.patch(message.id, messageChangePatch(event));
        } else {
          this.update(message, event.type === ServerWsMessageType.messageUpdated && event.restoreToTimeline);
        }
        if (message.isDeleted) this.restoreChatPreview(new Set([message.id]));
        break;
      }
      case ServerWsMessageType.messagesBulkDeleted:
        if (event.payload.chatId === this.context?.chatId && event.payload.messageIds.length) {
          const ids = new Set(event.payload.messageIds);
          this.deleteMessages(ids, event.removeFromTimeline);
          this.restoreChatPreview(ids);
        }
        break;
      case ServerWsMessageType.reactionUpdated:
        if (event.payload.chatId === this.context?.chatId)
          this.updateReactions(event.payload.messageId, event.payload.reactions);
        break;
    }
  }

  private restoreChatPreview(deletedIds: ReadonlySet<SnowflakeID>) {
    if (!this.context || this.provisional() || this.needsWindow || this.needsResync || !this.atLatest()) return;
    const { chatId, threadId } = this.context;
    const page = this.page()!;
    const listHidesMembership = this.hidesMembershipMessages({
      chatSettings: {
        ...page.chatSettings,
        showMembershipMessages: this.session.user()?.showMembershipMessages ?? page.chatSettings.showMembershipMessages,
      },
      membershipMessagePolicy: this.chatInfo.membershipPolicy(chatId) ?? page.membershipMessagePolicy,
    });
    if (
      listHidesMembership !== this.pageHidesMembershipMessages ||
      listHidesMembership !== this.hidesMembershipMessages(page)
    )
      return;
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

  update(message: MessageResponse, restoreToTimeline = false) {
    if (!this.accepts(message)) return;
    if (message.isDeleted) {
      this.deletedIds.add(message.id);
      message = redactDeletedMessage(message);
    } else this.editedPreviews.set(message.id, toMessagePreview(message));
    const known = this.items().find((item) => item.id === message.id);
    this.patch(message.id, (current) => replaceEditedMessage(known ?? current, message));
    if (restoreToTimeline && (!known || this.loading())) this.receive(message);
  }

  delete(messageId: SnowflakeID) {
    this.deleteMessages(new Set([messageId]));
  }

  private deleteMessages(ids: ReadonlySet<SnowflakeID>, removeFromTimeline = false) {
    const redact = removeFromTimeline ? redactRemovedMessage : redactDeletedMessage;
    const pending = this.loading() || this.paging();
    for (const id of ids) {
      this.deletedIds.add(id);
      if (pending) this.queuePatch(id, redact);
    }
    this.patchPage((message) => this.refreshCitation(ids.has(message.id) ? redact(message) : message));
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
    if (this.loading() || this.paging()) this.queuePatch(messageId, update);
    this.patchPage((message) => this.refreshCitation(message.id === messageId ? update(message) : message));
  }

  private queuePatch(messageId: SnowflakeID, update: MessageUpdate) {
    const previous = this.pendingUpdates.get(messageId);
    this.pendingUpdates.set(messageId, previous ? (message) => update(previous(message)) : update);
  }

  private patchPage(update: MessageUpdate) {
    this.currentPage.update((page) => {
      if (!page) return page;
      const messages = patchItems(page.messages, update);
      return messages === page.messages ? page : { ...page, messages };
    });
  }

  private clearPatches() {
    this.pendingUpdates.clear();
    this.pendingCreates.clear();
    this.deletedIds.clear();
    this.editedPreviews.clear();
  }

  private applyPendingUpdates(page: MessageRange, includeTail = false, includeStart = false): MessageRange {
    const messages = mergeMessageArrivals(page.messages, this.pendingCreates.values(), includeTail, includeStart);
    return { ...page, messages: messages.map((message) => this.applyPendingUpdate(message)) };
  }

  private applyPendingUpdate(message: MessageResponse) {
    const updated = this.pendingUpdates.get(message.id)?.(message) ?? message;
    return this.refreshCitation(this.realtime.redactKnownRecalls(updated));
  }

  /** Quoting messages embed a server snapshot of the cited message; edits and recalls reach them through here. */
  private refreshCitation(message: MessageResponse): MessageResponse {
    const updated = redactRecalledCitations(message, this.deletedIds);
    const quote = updated.replyToMessage;
    const fresh = quote && !quote.isDeleted ? this.editedPreviews.get(quote.id) : undefined;
    return fresh ? replaceMessageCitation(updated, fresh) : updated;
  }

  accepts(message: MessageResponse) {
    return acceptsConversationMessage(this.context, message);
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

  private getMessages(params: MessagePageParams, user = this.session.user(), windowRead?: WindowRead) {
    const context = this.context!;
    const policyGeneration = this.chatInfo.membershipPolicyRequestGeneration();
    const query = { ...context, ...params, max: 50 };
    const response = this.sync.active()
      ? this.sync
          .page(query, () => {
            // The range already saw all changes through the page's checkpoint.
            // The callback runs before resolution, not in a later promise turn.
            if (windowRead) windowRead.received = true;
            this.clearPatches();
          })
          .pipe(
            map(({ page }) => {
              if (page == null) throw new InaccessibleMessagePage('Message sync chat is inaccessible');
              return page;
            }),
          )
      : this.api.messages.list(query);
    return response.pipe(
      map(({ chatSettings, messages, olderCursor, newerCursor, membershipMessagePolicy }): MessageRange => {
        if (!this.chatInfo.isAccessible(context.chatId, context.threadId)) throw new InaccessibleMessagePage();
        // A group restriction already hides these messages regardless of the account preference.
        this.session.requireChatSettings(
          chatSettings,
          user,
          this.filtersMembershipMessages() && membershipMessagePolicy?.canView !== false,
        );
        if (
          !this.chatInfo.acceptMembershipPolicy(
            context.chatId,
            membershipMessagePolicy,
            windowRead?.policyGeneration ?? policyGeneration,
          )
        )
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
    if (this.sync.active()) {
      const version = this.version;
      try {
        await this.sync.waitForResume();
      } catch {
        return;
      }
      if (
        version !== this.version ||
        !this.context ||
        !this.chatInfo.isAccessible(this.context.chatId, this.context.threadId)
      )
        return;
      if (!this.needsWindow && this.page() && this.hasSyncAlignment()) return;
      if (this.loading()) return;
      const window = this.syncWindow();
      if (window && (this.page() || this.needsWindow || this.error() === ConversationError.Open)) {
        this.needsWindow = true;
        await this.open(window.around, false, this.hideMembershipMessages, window);
      }
      return;
    }
    if (this.needsWindow) {
      if (this.loading()) return;
      const window = this.syncWindow(true);
      if (!(await this.open(window?.around, false, this.hideMembershipMessages, window))) return;
    }
    this.needsResync = true;
    if (this.retryNewer) {
      await this.load(PageDirection.Newer);
      return;
    }
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
    this.retryNewer = true;
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
