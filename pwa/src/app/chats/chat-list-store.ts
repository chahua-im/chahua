import {
  computed,
  DestroyRef,
  effect,
  inject,
  Service,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, Subject, takeUntil, timer, type Observable } from 'rxjs';
import { RpcApi } from '../../generated/rpc-api';
import { ChatSettingsChanged, SessionStore } from '../session/session-store';
import { conversationUnread } from './conversation-unread';
import { conversationView } from './conversation-views';
import { ListTab, type ListSelection } from './list-tabs';
import {
  FriendRequestStatus,
  GroupKind,
  MessageType,
  NotificationType,
  ServerWsMessageType,
  SystemMessageKind,
  type ChatListItem,
  type ConversationUnreadSummary,
  type ConversationView,
  type FriendRequestHistoryEntry,
  type MessageResponse,
  type ThreadListItem,
} from '../../generated/models';
import { Connection, ResyncReason } from '../api/connection';
import { activeQuery, readPages } from '../api/query';
import { type SnowflakeID } from '../api/snowflake-id';
import { isMessageChange, type MessageChange } from '../messages/message-change';
import { ChatChangeKind, ChatStore } from './chat-store';

export enum ChatListError {
  Load = 1,
  Unread,
  Recent,
  More,
  Row,
}
export interface ChatQuery {
  readonly items: Signal<ChatListItem[]>;
  readonly loading: Signal<boolean>;
  readonly error: Signal<ChatListError | undefined>;
  readonly listError: Signal<ChatListError | undefined>;
  readonly hasMore: Signal<boolean>;
  readonly loadingMore: Signal<boolean>;
  readonly loadedThrough: Signal<number>;
  activate(): () => void;
  refresh(): void;
  retry(): Promise<void>;
  loadMore(): Promise<void>;
}
enum ListFetch {
  Load,
  Recent,
  More,
}
interface QueryState {
  archived: boolean;
  showMembershipMessages: boolean;
  ids: WritableSignal<SnowflakeID[]>;
  cursor: WritableSignal<SnowflakeID | undefined>;
  loading: WritableSignal<boolean>;
  loadingMore: WritableSignal<boolean>;
  loadedThrough: WritableSignal<number>;
  listError: WritableSignal<ChatListError | undefined>;
  unreadErrors: WritableSignal<ReadonlySet<SnowflakeID>>;
  dirty: WritableSignal<boolean>;
  consumers: Set<symbol>;
  generation: number;
  recentVersion: number;
  cancel: Subject<void>;
  requests: Map<ListFetch, Promise<void>>;
  /** Chats whose unread changed while no list was visible; refreshed by id on activation. */
  pendingUnread: Set<SnowflakeID>;
  pendingRows: Map<SnowflakeID, number>;
  rowRequests: Map<SnowflakeID, Promise<void>>;
  rowErrors: WritableSignal<ReadonlySet<SnowflakeID>>;
  /** A message arrived for a chat outside the loaded ids; only the head page can place it. */
  headStale: boolean;
}
export enum FriendRequestAction {
  Accept,
  Reject,
  Archive,
}
type QueryRequest = { cancel: Subject<void>; promise: Promise<void> };
function createThreadQuery(archived: boolean) {
  return {
    archived,
    ids: signal<SnowflakeID[]>([]),
    cursor: signal<string | undefined>(undefined),
    loading: signal(false),
    loadingMore: signal(false),
    loadedThrough: signal(Infinity),
    listError: signal<ChatListError | undefined>(undefined),
    unreadErrors: signal<ReadonlySet<SnowflakeID>>(new Set()),
    dirty: true,
    version: 0,
    consumers: 0,
    headOnly: false,
    headBoundary: -Infinity,
    pendingReads: new Set<SnowflakeID>(),
    pendingRows: new Map<SnowflakeID, number>(),
    rowRequests: new Map<SnowflakeID, Promise<void>>(),
    rowErrors: signal<ReadonlySet<SnowflakeID>>(new Set()),
    request: undefined as QueryRequest | undefined,
  };
}
type ThreadQuery = ReturnType<typeof createThreadQuery>;

function listErrors(state: Pick<QueryState, 'ids' | 'listError' | 'rowErrors' | 'unreadErrors'>) {
  const listError = computed(() => state.listError() ?? (state.rowErrors().size ? ChatListError.Row : undefined));
  const error = computed(() => {
    const listFailure = listError();
    if (listFailure != null) return listFailure;
    const unreadErrors = state.unreadErrors();
    return unreadErrors.size && state.ids().some((id) => unreadErrors.has(id)) ? ChatListError.Unread : undefined;
  });
  return { listError, error };
}

@Service()
export class ChatListStore {
  private readonly rpc = inject(RpcApi);
  private readonly chatInfo = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly realtime = inject(Connection);
  private readonly watchActivity = signal(0);
  private readonly watchVisible = signal(!document.hidden);
  private readonly queries = new Map<boolean, { state: QueryState; handle: ChatQuery }>();
  private readonly resolvedRequests = new Map<SnowflakeID, number>();
  private readonly membershipStates = new Map<SnowflakeID, string>();
  private rowRevision = 0;
  private threadRefreshPending?: Promise<void>;
  private readonly threadMessages = new Set<SnowflakeID>();
  private readonly friendsApi = this.rpc.friends;
  private readonly threadsApi = this.rpc.threads;
  private readonly activeRequests = this.requestCache(false);
  private readonly historicalRequests = this.requestCache(true);
  private readonly activeThreads = this.threadCache(false);
  private readonly archivedThreads = this.threadCache(true);
  private readonly session = inject(SessionStore);
  readonly selection = signal<ListSelection>({ tab: ListTab.Messages, archived: false, requestHistory: false });
  readonly viewUnread = conversationUnread(this.realtime, this.session, this.destroyRef);
  readonly unread = {
    activate: this.viewUnread.activate,
    value: computed(() => {
      const unreadCount = this.viewUnread.appBadgeCount();
      return unreadCount == null ? undefined : { unreadCount };
    }),
  };
  summary(view: ConversationView): ConversationUnreadSummary | undefined {
    return this.viewUnread.value()?.find((summary) => summary.key === view.key);
  }
  /** Unmuted unread conversation counts and mention flags shared by the tab bar and the document title. */
  tabBadges(showThreadsInMessages: boolean) {
    const badge = (tab: ListTab) => {
      const summary = this.summary(
        conversationView({ tab, archived: false, requestHistory: false }, showThreadsInMessages),
      );
      return {
        count: summary?.unreadUnmutedConversationCount ?? 0,
        mention: !!summary?.unreadUnmutedAttentionCount,
      };
    };
    return {
      messages: badge(ListTab.Messages),
      groups: badge(ListTab.Groups),
      friends: badge(ListTab.Friends),
      threads: badge(ListTab.Threads),
    };
  }

  constructor() {
    for (const archived of [false, true]) this.queries.set(archived, this.createQuery(archived));
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe((reason) => {
      // Request history archiving has no cross-device event, so keep its calibration.
      void this.invalidateRequests();
      if (reason === ResyncReason.Foreground && this.realtime.connected()) return;
      this.membershipStates.clear();
      void this.invalidateThreads();
    });
    const visible = () => {
      this.watchVisible.set(!document.hidden);
      if (document.hidden) return;
      for (const { state } of this.queries.values()) {
        if (!state.consumers.size) continue;
        if (state.dirty()) void this.fetchQuery(state, ListFetch.Load);
        else this.reconcile(state);
        this.flushRows(state);
      }
      for (const { state } of [this.activeThreads, this.archivedThreads]) {
        if (!state.consumers) continue;
        if (state.dirty) void this.loadThreads(state);
        this.flushThreadReads(state);
        this.flushRows(state);
      }
    };
    document.addEventListener('visibilitychange', visible);
    this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', visible));
    effect((onCleanup) => {
      this.watchActivity();
      if (!this.watchVisible()) return;
      const scopes = [...this.queries.values()].flatMap(({ state }) =>
        state.consumers.size ? state.ids().map((chatId) => ({ chatId })) : [],
      );
      const threads = [this.activeThreads.state, this.archivedThreads.state].flatMap((state) =>
        state.consumers
          ? state.ids().flatMap((threadId) => {
              const thread = this.chatInfo.thread(threadId);
              return thread ? [{ chatId: thread.chatId, threadId }] : [];
            })
          : [],
      );
      onCleanup(this.chatInfo.watchReadStates([...scopes, ...threads]));
    });
    effect(() => {
      const show = this.session.user()?.showMembershipMessages ?? true;
      untracked(() => this.syncChatSettings(show));
    });
    // Live events keep a foregrounded list current; only a dropped socket can have missed rows.
    let wasConnected = this.realtime.connected();
    let dropped = false;
    effect(() => {
      const connected = this.realtime.connected();
      if (!connected && wasConnected) dropped = true;
      if (connected && dropped) {
        dropped = false;
        untracked(() => this.refreshChats());
      }
      wasConnected = connected;
    });
    this.chatInfo.changes$.pipe(takeUntilDestroyed()).subscribe(({ kind, chatId, threadId }) => {
      if (kind === ChatChangeKind.MembershipMessagePolicy) {
        this.refreshChats();
        return;
      }
      if (kind === ChatChangeKind.Read) {
        if (threadId)
          for (const { state } of [this.activeThreads, this.archivedThreads]) this.clearUnreadErrors(state, [threadId]);
        else for (const { state } of this.queries.values()) this.clearUnreadErrors(state, [chatId]);
        return;
      }
      if (kind === ChatChangeKind.Removed || kind === ChatChangeKind.MessagePurge) {
        const removedThreads = new Set(
          [this.activeThreads.state, this.archivedThreads.state]
            .flatMap((state) => state.ids())
            .filter((id) => (threadId ? id === threadId : this.chatInfo.threadBelongsTo(id, chatId))),
        );
        for (const { state } of this.queries.values()) {
          if (kind === ChatChangeKind.Removed && !threadId) {
            state.ids.update((ids) => ids.filter((id) => id !== chatId));
            state.pendingRows.delete(chatId);
            this.clearRowError(state, chatId);
            state.pendingUnread.delete(chatId);
          }
          if (kind === ChatChangeKind.MessagePurge) this.invalidateQuery(state);
        }
        for (const { state } of [this.activeThreads, this.archivedThreads]) {
          state.ids.update((ids) => ids.filter((id) => !removedThreads.has(id)));
          for (const id of removedThreads) {
            state.pendingRows.delete(id);
            this.clearRowError(state, id);
            state.pendingReads.delete(id);
          }
          if (kind === ChatChangeKind.MessagePurge) {
            this.invalidate(state);
            if (state.consumers && !document.hidden) void this.loadThreads(state);
          }
        }
        return;
      }
      if (kind === ChatChangeKind.Restored) {
        this.refreshChats();
        void this.invalidateThreads();
        return;
      }
      if (kind === ChatChangeKind.Attention) {
        if (threadId) this.refreshThreadRead(threadId);
        else this.queueUnread(chatId);
        return;
      }
      if (kind === ChatChangeKind.PreviewRecalled) {
        this.queueRow(chatId, threadId, { supersede: false });
        return;
      }
      if (threadId) {
        if (kind === ChatChangeKind.Membership) this.membershipChanged(chatId, threadId);
      } else {
        if (kind === ChatChangeKind.Membership) this.membershipChanged(chatId);
      }
    });
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (isMessageChange(event) && !('recallEcho' in event && event.recallEcho)) {
        this.receiveChange(event);
        this.receiveThreadChange(event);
      }
      switch (event.type) {
        case ServerWsMessageType.chatMembershipChanged:
          this.queueRow(event.payload.chatId);
          break;
        case ServerWsMessageType.message:
          this.receiveMessage(event.payload);
          if (event.payload.replyRootId) {
            this.threadMessages.add(event.payload.id);
            if (this.threadMessages.size > 256) this.threadMessages.delete(this.threadMessages.values().next().value!);
            this.chatInfo.invalidateThreadReads([event.payload.replyRootId]);
            this.refreshThreadRead(event.payload.replyRootId, true, false);
          }
          break;
        case ServerWsMessageType.friendRequestReceived:
        case ServerWsMessageType.friendRequestResolved:
          if (event.type === ServerWsMessageType.friendRequestResolved) {
            const id = event.payload.requestId;
            this.resolvedRequests.set(id, (this.resolvedRequests.get(id) ?? 0) + 1);
            if (this.resolvedRequests.size > 256)
              this.resolvedRequests.delete(this.resolvedRequests.keys().next().value!);
          }
          void this.invalidateRequests();
          if (
            event.type === ServerWsMessageType.friendRequestResolved &&
            event.payload.status === FriendRequestStatus.accepted
          )
            this.refreshChats();
          break;
        case ServerWsMessageType.threadUpdate: {
          const { chatId, threadRootId } = event.payload;
          if (this.chatInfo.threadUpdateNeedsRow(event.payload))
            this.queueRow(chatId, threadRootId, { supersede: false, listedOnly: true });
          else if (this.chatInfo.threadUpdateNeedsRead(event.payload)) this.refreshThreadRead(threadRootId);
          break;
        }
        case ServerWsMessageType.threadMembershipChanged:
          if (event.payload.status) this.membershipChanged(event.payload.chatId, event.payload.threadRootId);
          else void this.invalidateThreads();
          break;
        case ServerWsMessageType.chatArchiveStateChanged: {
          this.membershipChanged(event.payload.chatId);
          break;
        }
        case ServerWsMessageType.readReceiptChanged:
          if (
            !event.payload.privacyChanged &&
            this.showsPeerReceipt(event.payload.chatId, event.payload.threadRootId)
          ) {
            this.chatInfo.applyPeerRead(event.payload);
          }
          break;
        case ServerWsMessageType.notification: {
          const { chatId, threadRootId, notificationType } = event.payload;
          const kind =
            this.chatInfo.get(chatId)?.kind ??
            (threadRootId ? this.chatInfo.thread(threadRootId)?.chatKind : undefined);
          if (kind === GroupKind.dm && notificationType !== NotificationType.reaction) break;
          if (threadRootId) {
            this.chatInfo.invalidateThreadReads([threadRootId]);
            this.refreshThreadRead(threadRootId, this.threadMessages.has(event.payload.messageId));
          } else {
            this.chatInfo.invalidateReads(new Set([chatId]));
            this.queueUnread(chatId);
          }
          break;
        }
      }
    });
  }

  chats(archived: boolean): ChatQuery {
    return this.queries.get(archived)!.handle;
  }

  private settingsVisibility = this.session.user()?.showMembershipMessages ?? true;

  private syncChatSettings(show = this.session.user()?.showMembershipMessages ?? true) {
    if (show === this.settingsVisibility) return false;
    this.settingsVisibility = show;
    this.refreshChats();
    return true;
  }

  private createQuery(archived: boolean): { state: QueryState; handle: ChatQuery } {
    const state: QueryState = {
      archived,
      showMembershipMessages: this.session.user()?.showMembershipMessages ?? true,
      ids: signal([]),
      cursor: signal(undefined),
      loading: signal(false),
      loadingMore: signal(false),
      loadedThrough: signal(Infinity),
      listError: signal(undefined),
      unreadErrors: signal<ReadonlySet<SnowflakeID>>(new Set()),
      dirty: signal(true),
      consumers: new Set(),
      generation: 0,
      recentVersion: 0,
      cancel: new Subject(),
      requests: new Map(),
      pendingUnread: new Set(),
      pendingRows: new Map(),
      rowRequests: new Map(),
      rowErrors: signal<ReadonlySet<SnowflakeID>>(new Set()),
      headStale: false,
    };
    const errors = listErrors(state);
    const handle: ChatQuery = {
      items: computed(() =>
        state
          .ids()
          .filter((id) => this.chatInfo.isAccessible(id))
          .map((id) => this.chatInfo.chat(id))
          .filter((chat) => chat.archived === archived)
          .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')),
      ),
      loading: state.loading.asReadonly(),
      ...errors,
      hasMore: computed(() => !state.dirty() && !!state.cursor()),
      loadingMore: state.loadingMore.asReadonly(),
      loadedThrough: state.loadedThrough.asReadonly(),
      activate: () => {
        const consumer = Symbol();
        state.consumers.add(consumer);
        this.watchActivity.update((value) => value + 1);
        if (state.dirty() && !state.requests.has(ListFetch.Load)) void this.fetchQuery(state, ListFetch.Load);
        else this.reconcile(state);
        this.flushRows(state);
        return () => {
          state.consumers.delete(consumer);
          this.watchActivity.update((value) => value + 1);
          if (!state.consumers.size && state.requests.size) this.cancelQuery(state);
        };
      },
      refresh: () => {
        this.chatInfo.invalidateReads(new Set(state.ids()));
        this.invalidateQuery(state);
      },
      retry: () =>
        errors.listError() === ChatListError.Row && !state.dirty()
          ? this.retryRows(state)
          : this.fetchQuery(
              state,
              state.listError() === ChatListError.More && !state.dirty() && state.cursor()
                ? ListFetch.More
                : ListFetch.Load,
            ),
      loadMore: () => {
        if (!state.consumers.size || state.dirty() || state.loading() || !state.cursor()) return Promise.resolve();
        return this.fetchQuery(state, ListFetch.More);
      },
    };
    return { state, handle };
  }

  private cancelQuery(query: QueryState) {
    // A cancelled head read still has to place a conversation missed outside the loaded ids.
    if (query.requests.has(ListFetch.Recent)) query.headStale = true;
    query.generation++;
    query.cancel.next();
    query.cancel.complete();
    query.cancel = new Subject();
    query.requests.clear();
    query.loading.set(false);
    query.loadingMore.set(false);
  }

  private invalidateQuery(query: QueryState) {
    query.dirty.set(true);
    this.cancelQuery(query);
    query.pendingUnread.clear();
    query.headStale = false;
    query.listError.set(undefined);
    if (query.consumers.size && !document.hidden && !this.destroyRef.destroyed)
      void this.fetchQuery(query, ListFetch.Load);
  }

  /** Reconciles a list hidden from view without reloading rows that live events kept current. */
  private reconcile(query: QueryState) {
    if (!query.consumers.size || this.destroyRef.destroyed) return;
    for (const chatId of query.pendingUnread) void this.syncHiddenUnread(query, chatId);
    if (!query.headStale || query.dirty() || query.requests.size) return;
    query.headStale = false;
    void this.fetchQuery(query, ListFetch.Recent);
  }

  private fetchQuery(query: QueryState, mode: ListFetch): Promise<void> {
    const pending = query.requests.get(mode);
    if (pending) return pending;
    const generation = query.generation;
    const after = mode === ListFetch.More ? query.cursor() : undefined;
    const startRecentVersion = query.recentVersion;
    if (mode === ListFetch.Load) query.loading.set(true);
    if (mode === ListFetch.More) query.loadingMore.set(true);
    query.listError.set(undefined);
    const promise = (async () => {
      try {
        while (true) {
          const recentVersion = query.recentVersion;
          if (mode === ListFetch.Load) {
            if (!(await this.readFromHead(query, generation))) return;
            query.dirty.set(false);
            this.flushRows(query);
          } else if (mode === ListFetch.Recent) {
            if (!(await this.readRecent(query, generation))) return;
          } else {
            const result = await this.readPage(query, after);
            if (this.destroyRef.destroyed || generation !== query.generation) return;
            const { page, version } = result;
            this.acceptChatPage(query, result);
            query.ids.update((ids) => [
              ...new Set([
                ...ids,
                ...page.chats.filter((chat) => this.chatInfo.acceptsSnapshot(chat.id, version)).map((chat) => chat.id),
              ]),
            ]);
            this.applyBoundary(query, page.chats, page.nextCursor);
          }
          if (mode !== ListFetch.Recent || recentVersion === query.recentVersion) return;
        }
      } catch (error) {
        if (!this.destroyRef.destroyed && generation === query.generation) {
          if (error instanceof ChatSettingsChanged) {
            if (!this.syncChatSettings()) this.invalidateQuery(query);
            return;
          }
          query.listError.set(
            mode === ListFetch.Load
              ? ChatListError.Load
              : mode === ListFetch.More
                ? ChatListError.More
                : ChatListError.Recent,
          );
          if (mode === ListFetch.Recent) query.dirty.set(true);
        }
      } finally {
        if (generation === query.generation) {
          query.requests.delete(mode);
          if (mode === ListFetch.Load) query.loading.set(false);
          if (mode === ListFetch.More) query.loadingMore.set(false);
          if (
            mode === ListFetch.Load &&
            !query.dirty() &&
            query.consumers.size &&
            !this.destroyRef.destroyed &&
            startRecentVersion !== query.recentVersion
          ) {
            void this.fetchQuery(query, ListFetch.Recent);
          }
        }
      }
    })();
    query.requests.set(mode, promise);
    return promise;
  }

  private readPage(query: QueryState, cursor?: SnowflakeID, show = query.showMembershipMessages) {
    // Snapshot before the request so live previews received meanwhile keep their version.
    const version = this.chatInfo.snapshot();
    const rowRevision = this.rowRevision;
    const policyGeneration = this.chatInfo.membershipPolicyRequestGeneration();
    const user = this.session.user();
    return firstValueFrom(
      this.rpc.chats
        .list({
          limit: 50,
          ...(query.archived ? { archived: true } : {}),
          ...(cursor ? { after: cursor } : {}),
        })
        .pipe(takeUntil(query.cancel), takeUntilDestroyed(this.destroyRef)),
    ).then((page) => {
      this.session.requireChatSettings(page.chatSettings, user);
      if (
        page.chatSettings.showMembershipMessages !== show ||
        policyGeneration !== this.chatInfo.membershipPolicyRequestGeneration()
      )
        throw new ChatSettingsChanged();
      return { page, version, policyGeneration, rowRevision };
    });
  }

  private acceptChatPage(query: QueryState, result: Awaited<ReturnType<ChatListStore['readPage']>>) {
    const { page, version, policyGeneration, rowRevision } = result;
    this.chatInfo.acceptChats(page.chats, version, policyGeneration);
    // A whole-page read can clear rows already pending when it started, but not later invalidations.
    for (const { id } of page.chats)
      if (
        (query.pendingRows.get(id) ?? Infinity) <= rowRevision &&
        this.chatInfo.acceptsSnapshot(id, version) &&
        !this.chatInfo.chat(id).lastMessage?.isDeleted
      )
        this.finishRow(query, id);
    this.clearUnreadErrors(
      query,
      page.chats.map(({ id }) => id),
    );
  }

  /** Applies each page before reading the next, up to the depth already loaded or the tail. */
  private async readFromHead(query: QueryState, generation: number) {
    const depth = query.ids().length;
    const show = this.session.user()?.showMembershipMessages ?? true;
    const filterChanged = query.showMembershipMessages !== show;
    const pages: Awaited<ReturnType<ChatListStore['readPage']>>[] = [];
    const read = new Map<SnowflakeID, number>();
    const apply = (result: Awaited<ReturnType<ChatListStore['readPage']>>) => {
      const { page, version } = result;
      this.acceptChatPage(query, result);
      query.ids.update((ids) => [
        ...new Set([
          ...ids,
          ...page.chats.filter((chat) => this.chatInfo.acceptsSnapshot(chat.id, version)).map((chat) => chat.id),
        ]),
      ]);
      this.applyBoundary(query, page.chats, page.nextCursor);
    };
    let loaded = 0;
    let cursor: SnowflakeID | undefined;
    do {
      const result = await this.readPage(query, cursor, show);
      if (this.destroyRef.destroyed || generation !== query.generation) return false;
      if (filterChanged) pages.push(result);
      else apply(result);
      for (const chat of result.page.chats) read.set(chat.id, result.version);
      loaded += result.page.chats.length;
      cursor = result.page.nextCursor;
    } while (cursor && loaded < depth);
    for (const page of pages) apply(page);
    query.showMembershipMessages = show;
    query.ids.set([...read].filter(([id, version]) => this.chatInfo.acceptsSnapshot(id, version)).map(([id]) => id));
    return true;
  }

  /** Bridge the new head to the previously loaded window without moving its pagination cursor. */
  private async readRecent(query: QueryState, generation: number) {
    const boundary = query.loadedThrough();
    let cursor: SnowflakeID | undefined;
    do {
      const result = await this.readPage(query, cursor);
      if (this.destroyRef.destroyed || generation !== query.generation) return false;
      const { page, version } = result;
      this.acceptChatPage(query, result);
      query.ids.update((ids) => [
        ...new Set([
          ...ids,
          ...page.chats.filter((chat) => this.chatInfo.acceptsSnapshot(chat.id, version)).map((chat) => chat.id),
        ]),
      ]);
      cursor = page.nextCursor;
      const time = page.chats.at(-1)?.lastMessageAt;
      if (time && Date.parse(time) < boundary) break;
    } while (cursor);
    return true;
  }

  private applyBoundary(query: QueryState, chats: readonly ChatListItem[], next?: SnowflakeID) {
    query.cursor.set(next);
    // Use the server page boundary, not rows subsequently moved by live messages.
    const time = chats.at(-1)?.lastMessageAt;
    query.loadedThrough.set(next && time ? Date.parse(time) : -Infinity);
  }

  private receiveMessage(message: MessageResponse) {
    if (message.replyRootId) return;
    const uid = this.session.user()?.uid;
    // The dedicated membership event reconciles this row, including hidden announcements.
    if (
      uid != null &&
      message.messageType === MessageType.system &&
      ((message.systemKind === SystemMessageKind.member_joined && message.sender.uid === uid) ||
        (message.systemKind === SystemMessageKind.member_added && message.systemLinks?.uid === uid))
    ) {
      return;
    }
    const active = [...this.queries.values()].map(({ state }) => state).filter((query) => query.consumers.size);
    this.queueUnread(message.chatId);
    if (!this.chatInfo.isChatMessageVisible(message)) return;
    for (const query of active) {
      if (!query.ids().includes(message.chatId)) {
        query.recentVersion++;
        if (document.hidden) query.headStale = true;
        else if (!query.requests.has(ListFetch.Load))
          void this.fetchQuery(query, query.dirty() ? ListFetch.Load : ListFetch.Recent);
      }
    }
    // A hidden list keeps its rows; live previews cover the message itself, so record only the gaps.
    for (const { state } of this.queries.values()) {
      if (state.consumers.size || state.dirty()) continue;
      if (!state.ids().includes(message.chatId)) {
        state.headStale = true;
        continue;
      }
      state.pendingUnread.add(message.chatId);
    }
  }

  private clearUnreadErrors(query: QueryState | ThreadQuery, ids: readonly SnowflakeID[]) {
    if (!query.unreadErrors().size) return;
    query.unreadErrors.update((errors) => {
      const remaining = new Set(errors);
      for (const id of ids) {
        // A list response can be older than a live invalidation and be rejected by ChatStore.
        // Only an accepted, current read snapshot resolves that scope's unread failure.
        const thread = 'generation' in query ? undefined : this.chatInfo.thread(id);
        const fresh =
          'generation' in query
            ? this.chatInfo.cachedReadState(id)
            : thread && this.chatInfo.threadReadState(thread.chatId, id);
        if (fresh) remaining.delete(id);
      }
      return remaining;
    });
  }

  private async syncHiddenUnread(query: QueryState, chatId: SnowflakeID) {
    try {
      await this.chatInfo.scheduleReadState(chatId);
      query.pendingUnread.delete(chatId);
      this.clearUnreadErrors(query, [chatId]);
    } catch {
      // Keep it pending: activation retries and only a visible list reports the failure.
      if (query.consumers.size && !this.destroyRef.destroyed && !this.chatInfo.cachedReadState(chatId))
        query.unreadErrors.update((ids) => new Set(ids).add(chatId));
    }
  }

  private receiveChange(change: MessageChange) {
    if (change.type === ServerWsMessageType.reactionUpdated) return;
    if (
      change.type === ServerWsMessageType.messagesBulkDeleted &&
      (change.payload.complete === false || change.threadRepliesOnly)
    )
      return;
    if (change.type !== ServerWsMessageType.messagesBulkDeleted && change.payload.replyRootId) return;
    // Edits are already applied to the shared preview; they never change list membership or order.
    if (change.type === ServerWsMessageType.messageUpdated) return;
    this.queueRow(change.payload.chatId);
  }

  private membershipChanged(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const state = threadId ? this.chatInfo.cachedSubscription(chatId, threadId) : this.chatInfo.chatState(chatId);
    const key = JSON.stringify(threadId ? state : state && { archived: state.archived });
    if (key && this.membershipStates.get(threadId ?? chatId) === key) return;
    if (key) this.membershipStates.set(threadId ?? chatId, key);
    if (threadId) {
      const status = this.chatInfo.cachedSubscription(chatId, threadId);
      if (status && (!status.subscribed || this.chatInfo.thread(threadId))) {
        for (const { state: query } of [this.activeThreads, this.archivedThreads]) {
          query.ids.update((ids) => [
            ...new Set([
              ...ids.filter((id) => id !== threadId),
              ...(status.subscribed && status.archived === query.archived ? [threadId] : []),
            ]),
          ]);
        }
        return;
      }
    } else if ([...this.queries.values()].some(({ state }) => state.ids().includes(chatId))) {
      const archived = this.chatInfo.chatState(chatId)?.archived;
      for (const { state: query } of this.queries.values()) {
        query.ids.update((ids) => [
          ...new Set([...ids.filter((id) => id !== chatId), ...(archived === query.archived ? [chatId] : [])]),
        ]);
      }
      return;
    }
    this.queueRow(chatId, threadId);
  }

  private queueRow(
    chatId: SnowflakeID,
    threadId?: SnowflakeID,
    { supersede = true, listedOnly = false }: { supersede?: boolean; listedOnly?: boolean } = {},
  ) {
    const id = threadId ?? chatId;
    const queries = threadId
      ? [this.activeThreads.state, this.archivedThreads.state]
      : [...this.queries.values()].map(({ state }) => state);
    for (const query of queries) {
      if (listedOnly && !query.ids().includes(id)) continue;
      if (!supersede && query.pendingRows.has(id)) continue;
      query.pendingRows.set(id, ++this.rowRevision);
      this.flushRows(query);
    }
  }

  private async retryRows(query: QueryState | ThreadQuery) {
    this.flushRows(query);
    await Promise.all(query.rowRequests.values());
  }

  private finishRow(query: QueryState | ThreadQuery, id: SnowflakeID) {
    query.pendingRows.delete(id);
    this.clearRowError(query, id);
  }

  private clearRowError(query: QueryState | ThreadQuery, id: SnowflakeID) {
    query.rowErrors.update((errors) => {
      if (!errors.has(id)) return errors;
      const remaining = new Set(errors);
      remaining.delete(id);
      return remaining;
    });
  }

  /** Reconcile one row without touching the loaded page boundary or other rows. */
  private flushRows(query: QueryState | ThreadQuery) {
    const visible = () => !document.hidden && ('generation' in query ? query.consumers.size > 0 : query.consumers > 0);
    const dirty = () => ('generation' in query ? query.dirty() : query.dirty);
    if (!visible() || dirty()) return;
    for (const id of query.pendingRows.keys()) {
      if (query.rowRequests.has(id)) continue;
      let revision: number | undefined;
      const request = (async () => {
        await Promise.resolve();
        while (!this.destroyRef.destroyed && visible() && query.pendingRows.has(id)) {
          revision = query.pendingRows.get(id);
          const version = this.chatInfo.snapshot();
          const policyGeneration = this.chatInfo.membershipPolicyRequestGeneration();
          const subscriptionVersion = this.chatInfo.subscriptionSnapshot();
          const user = this.session.user();
          const visibility = user?.showMembershipMessages ?? true;
          if ('generation' in query) {
            const page = await this.response(
              this.rpc.chats.list({
                limit: 1,
                chatId: id,
                archived: query.archived,
              }),
            );
            try {
              this.session.requireChatSettings(page.chatSettings, user);
            } catch (error) {
              if (!(error instanceof ChatSettingsChanged)) throw error;
              if (!this.syncChatSettings()) this.invalidateQuery(query);
              return;
            }
            if (
              policyGeneration !== this.chatInfo.membershipPolicyRequestGeneration() ||
              query.pendingRows.get(id) !== revision ||
              visibility !== (this.session.user()?.showMembershipMessages ?? true)
            )
              continue;
            if (dirty()) return;
            this.chatInfo.acceptChats(page.chats, version, policyGeneration);
            this.clearUnreadErrors(
              query,
              page.chats.map((chat) => chat.id),
            );
            query.ids.update((ids) => [
              ...new Set([
                ...ids.filter((value) => value !== id),
                ...page.chats.filter((row) => this.chatInfo.acceptsSnapshot(row.id, version)).map((row) => row.id),
              ]),
            ]);
          } else {
            const lastReplyId = this.chatInfo.threadSummary(id)?.lastReply?.id;
            const page = await this.response(this.threadsApi.list({ limit: 1, rootId: id, archived: query.archived }));
            if (
              query.pendingRows.get(id) !== revision ||
              visibility !== (this.session.user()?.showMembershipMessages ?? true)
            )
              continue;
            if (dirty()) return;
            if (!page.threads.length) {
              // A reply received during the read can make an empty snapshot obsolete.
              if (this.hasNewThreadReply(query, id, lastReplyId)) continue;
              query.pendingReads.delete(id);
            }
            this.chatInfo.acceptThreads(page.threads, version, subscriptionVersion, id);
            this.clearUnreadErrors(
              query,
              page.threads.map((thread) => thread.threadRootMessage.id),
            );
            query.ids.update((ids) => [
              ...new Set([
                ...ids.filter((value) => value !== id),
                ...page.threads
                  .filter((row) => this.chatInfo.acceptsSnapshot(row.chatId, version, row.threadRootMessage.id))
                  .map((row) => row.threadRootMessage.id),
              ]),
            ]);
          }
          this.finishRow(query, id);
        }
      })()
        .catch(() => {
          if (!this.destroyRef.destroyed && revision != null && query.pendingRows.get(id) === revision)
            query.rowErrors.update((errors) => new Set(errors).add(id));
        })
        .finally(() => {
          query.rowRequests.delete(id);
          const pending = query.pendingRows.get(id);
          // Accepting a stale preview can queue a new revision before this request settles.
          if (pending != null && pending !== revision) this.flushRows(query);
        });
      query.rowRequests.set(id, request);
      this.chatInfo.shareListRowRead(id, request, 'generation' in query ? 'chat' : 'thread');
    }
  }

  private hasNewThreadReply(query: ThreadQuery, id: SnowflakeID, lastReplyId?: SnowflakeID) {
    const thread = this.chatInfo.thread(id);
    const reply = thread?.lastReply;
    return (
      thread?.archived === query.archived &&
      reply &&
      !reply.isDeleted &&
      (lastReplyId == null || reply.id > lastReplyId)
    );
  }

  private queueUnread(chatId: SnowflakeID) {
    for (const { state } of this.queries.values()) {
      if (!state.ids().includes(chatId)) continue;
      state.pendingUnread.add(chatId);
      if (state.consumers.size && !document.hidden) void this.syncHiddenUnread(state, chatId);
    }
  }

  private refreshThreadRead(rootId: SnowflakeID, newMessage = true, discover = true) {
    let known = false;
    for (const { state } of [this.activeThreads, this.archivedThreads]) {
      if (!state.ids().includes(rootId)) continue;
      known = true;
      state.pendingReads.add(rootId);
      this.flushThreadReads(state);
    }
    if (!known && discover) void this.scheduleThreadHead(newMessage);
  }

  private flushThreadReads(state: ThreadQuery) {
    if (!state.consumers || document.hidden || state.dirty) return;
    for (const id of state.pendingReads) {
      const thread = this.chatInfo.thread(id);
      if (!thread) {
        state.pendingReads.delete(id);
        continue;
      }
      const isNeeded = () => !!state.consumers && !document.hidden && state.pendingReads.has(id);
      void this.chatInfo
        .getThreadReadState(thread.chatId, id, { isNeeded })
        .then(() => {
          state.pendingReads.delete(id);
          this.clearUnreadErrors(state, [id]);
        })
        .catch(() => {
          if (isNeeded() && !this.chatInfo.threadReadState(thread.chatId, id))
            state.unreadErrors.update((ids) => new Set(ids).add(id));
        });
    }
  }

  private scheduleThreadHead(headOnly = true) {
    for (const { state } of [this.activeThreads, this.archivedThreads]) {
      if (!headOnly) state.headOnly = false;
      else if (!state.dirty) state.headOnly = state.ids().length > 0;
      state.dirty = true;
      state.version++;
    }
    if (this.threadRefreshPending) return this.threadRefreshPending;
    this.threadRefreshPending = this.response(timer(100))
      .then(async () => {
        if (!document.hidden)
          await Promise.all(
            [this.activeThreads, this.archivedThreads].map(({ state }) =>
              state.consumers ? this.loadThreads(state) : undefined,
            ),
          );
      })
      .catch(() => {})
      .finally(() => {
        this.threadRefreshPending = undefined;
      });
    return this.threadRefreshPending;
  }

  refreshChats() {
    if (this.destroyRef.destroyed) return;
    this.chatInfo.invalidateReads();
    for (const { state } of this.queries.values()) this.invalidateQuery(state);
  }

  private receiveThreadChange(change: MessageChange) {
    if (change.type === ServerWsMessageType.reactionUpdated || change.type === ServerWsMessageType.messageUpdated)
      return;
    if (change.type === ServerWsMessageType.messageDeleted) {
      if (change.payload.replyRootId) this.queueRow(change.payload.chatId, change.payload.replyRootId);
      else if (change.payload.threadInfo || this.chatInfo.thread(change.payload.id))
        this.queueRow(change.payload.chatId, change.payload.id);
      return;
    }
    if (change.payload.complete === false) return;
    if (change.payload.threadRootIds) {
      for (const id of change.payload.threadRootIds) this.queueRow(change.payload.chatId, id);
      return;
    }
    // Legacy bulk events have no scope list: only reconcile loaded threads in that chat.
    const ids = new Set([...this.activeThreads.state.ids(), ...this.archivedThreads.state.ids()]);
    for (const id of ids)
      if (this.chatInfo.thread(id)?.chatId === change.payload.chatId) this.queueRow(change.payload.chatId, id);
  }

  private showsPeerReceipt(chatId: SnowflakeID, threadRootId?: SnowflakeID) {
    return threadRootId
      ? this.activeThreads.state.ids().includes(threadRootId) || this.archivedThreads.state.ids().includes(threadRootId)
      : [...this.queries.values()].some(({ state }) => state.ids().includes(chatId));
  }

  friendRequests(history: boolean) {
    return history ? this.historicalRequests : this.activeRequests;
  }

  threads(archived: boolean) {
    return (archived ? this.archivedThreads : this.activeThreads).view;
  }

  private requestCache(archived: boolean) {
    const { value, ...query } = activeQuery<FriendRequestHistoryEntry[]>(
      this.destroyRef,
      async (cancel) => {
        const page = await this.response(this.friendsApi.listRequests({ archived }), cancel);
        return page.requests;
      },
      [],
    );
    return { ...query, items: value };
  }

  private threadCache(archived: boolean) {
    const state = createThreadQuery(archived);
    const errors = listErrors(state);
    return {
      state,
      view: {
        loadedThrough: state.loadedThrough.asReadonly(),
        items: computed(() =>
          state.ids().flatMap((id) => {
            const thread = this.chatInfo.thread(id);
            return thread?.archived === archived ? [thread] : [];
          }),
        ),
        loading: state.loading.asReadonly(),
        ...errors,
        hasMore: computed(() => !!state.cursor()),
        loadingMore: state.loadingMore.asReadonly(),
        activate: () => this.activateThreadQuery(state),
        refresh: () => {
          this.invalidate(state);
          return this.loadThreads(state);
        },
        retry: () =>
          errors.listError() === ChatListError.Row && !state.dirty
            ? this.retryRows(state)
            : this.loadThreads(
                state,
                state.listError() === ChatListError.More && !state.dirty ? state.cursor() : undefined,
              ),
        loadMore: () => {
          const cursor = state.cursor();
          return (
            state.request?.promise ?? (!cursor || state.dirty ? Promise.resolve() : this.loadThreads(state, cursor))
          );
        },
      },
    };
  }

  private activateThreadQuery(current: ThreadQuery) {
    current.consumers++;
    this.watchActivity.update((value) => value + 1);
    if (current.dirty) void this.loadThreads(current);
    else this.flushThreadReads(current);
    this.flushRows(current);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.watchActivity.update((value) => value + 1);
      if (--current.consumers || !current.request) return;
      this.invalidate(current);
      const pending = current.request;
      current.request = undefined;
      pending.cancel.next();
      current.loading.set(false);
      current.loadingMore.set(false);
    };
  }

  private invalidate(current: ThreadQuery) {
    current.dirty = true;
    current.headOnly = false;
    current.version++;
    this.chatInfo.invalidateThreadReads(current.ids());
  }

  private response<T>(source: Observable<T>, cancel?: Observable<void>) {
    return firstValueFrom((cancel ? source.pipe(takeUntil(cancel)) : source).pipe(takeUntilDestroyed(this.destroyRef)));
  }

  private async invalidateRequests() {
    await Promise.all([this.activeRequests.refresh(), this.historicalRequests.refresh()]);
  }

  async decideRequest(id: SnowflakeID, action: FriendRequestAction) {
    const revision = this.resolvedRequests.get(id);
    try {
      await this.response<unknown>(
        action === FriendRequestAction.Accept
          ? this.friendsApi.acceptRequest({ requestId: id })
          : action === FriendRequestAction.Reject
            ? this.friendsApi.rejectRequest({ requestId: id })
            : this.friendsApi.archiveRequest({ requestId: id }),
      );
      if (
        !this.destroyRef.destroyed &&
        action === FriendRequestAction.Accept &&
        revision === this.resolvedRequests.get(id)
      )
        this.refreshChats();
    } finally {
      // A conflict can mean another device has already decided the request.
      if (!this.destroyRef.destroyed && revision === this.resolvedRequests.get(id)) await this.invalidateRequests();
    }
  }

  private async invalidateThreads() {
    await Promise.all(
      [this.activeThreads, this.archivedThreads].map(({ state }) => {
        this.invalidate(state);
        return state.consumers && !document.hidden ? this.loadThreads(state) : undefined;
      }),
    );
  }

  private loadThreads(current: ThreadQuery, before?: string) {
    if (current.request || this.destroyRef.destroyed) return current.request?.promise ?? Promise.resolve();
    const operation = { cancel: new Subject<void>(), promise: Promise.resolve() };
    current.request = operation;
    current.version++;
    current.loading.set(!before);
    current.loadingMore.set(!!before);
    current.listError.set(undefined);
    operation.promise = (async () => {
      await Promise.resolve();
      while (!this.destroyRef.destroyed && current.request === operation) {
        const version = current.version;
        const headOnly = current.headOnly && !before;
        const previousReplies =
          !before && !headOnly
            ? new Map(current.ids().map((id) => [id, this.chatInfo.threadSummary(id)?.lastReply?.id]))
            : undefined;
        const readVersion = this.chatInfo.snapshot();
        const rowRevision = this.rowRevision;
        const subscriptionVersion = this.chatInfo.subscriptionSnapshot();
        try {
          const read = async (cursor?: string) => {
            const page = await this.response(
              this.threadsApi.list({
                limit: 20,
                archived: current.archived,
                ...(cursor ? { before: cursor } : {}),
              }),
              operation.cancel,
            );
            return { items: page.threads, cursor: page.nextCursor };
          };
          const head = async () => {
            const boundary = current.headBoundary;
            const items: ThreadListItem[] = [];
            let cursor: string | undefined;
            do {
              const page = await read(cursor);
              items.push(...page.items);
              cursor = page.cursor;
              if (!page.items.length || Date.parse(page.items.at(-1)!.lastReplyAt) <= boundary) break;
            } while (cursor && version === current.version);
            return { items, cursor: current.cursor() };
          };
          const result = before
            ? await read(before)
            : headOnly
              ? await head()
              : await readPages(read, current.ids().length, () => version === current.version);
          const page = { threads: result.items, nextCursor: result.cursor };
          if (this.destroyRef.destroyed || current.request !== operation) return;
          if (version === current.version) {
            this.chatInfo.acceptThreads(page.threads, readVersion, subscriptionVersion);
            for (const {
              chatId,
              threadRootMessage: { id },
            } of page.threads)
              if (
                (current.pendingRows.get(id) ?? Infinity) <= rowRevision &&
                this.chatInfo.acceptsSnapshot(chatId, readVersion, id) &&
                !this.chatInfo.thread(id)?.lastReply?.isDeleted
              )
                this.finishRow(current, id);
            this.clearUnreadErrors(
              current,
              page.threads.map((thread) => thread.threadRootMessage.id),
            );
            const returned = new Set(
              page.threads
                .filter((thread) =>
                  this.chatInfo.acceptsSnapshot(thread.chatId, readVersion, thread.threadRootMessage.id),
                )
                .map((thread) => thread.threadRootMessage.id),
            );
            const retained = previousReplies
              ? current
                  .ids()
                  .filter((id) => !returned.has(id) && this.hasNewThreadReply(current, id, previousReplies.get(id)))
              : current.ids();
            if (previousReplies)
              for (const id of retained)
                if (!current.pendingRows.has(id)) current.pendingRows.set(id, ++this.rowRevision);
            current.ids.set([...new Set([...retained, ...returned])]);
            current.cursor.set(page.nextCursor);
            if (!before && page.threads.length) current.headBoundary = Date.parse(page.threads[0].lastReplyAt);
            if (!headOnly) current.loadedThrough.set(page.nextCursor ? Date.parse(page.nextCursor) : -Infinity);
            current.dirty = false;
            current.headOnly = false;
            this.flushThreadReads(current);
            this.flushRows(current);
            return;
          }
        } catch {
          if (this.destroyRef.destroyed || current.request !== operation) return;
          if (version === current.version) {
            current.listError.set(before ? ChatListError.More : headOnly ? ChatListError.Recent : ChatListError.Load);
            return;
          }
        }
        if (!current.consumers) return;
        before = undefined;
        current.loading.set(true);
        current.loadingMore.set(false);
      }
    })().finally(() => {
      if (current.request !== operation) return;
      current.request = undefined;
      current.loading.set(false);
      current.loadingMore.set(false);
    });
    return operation.promise;
  }
}
