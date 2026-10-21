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
import { firstValueFrom, Subject, takeUntil, type Observable } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { FriendsService } from '../../generated/endpoints/friends/friends.service';
import { ConversationsService } from '../../generated/endpoints/conversations/conversations.service';
import { SessionStore } from '../session/session-store';
import { builtinConversationViews } from './conversation-views';
import { ListTab, type ListSelection } from './list-tabs';
import { ThreadsService } from '../../generated/endpoints/threads/threads.service';
import {
  FriendRequestStatus,
  ServerWsMessageType,
  type ChatListItem,
  type ConversationUnreadSummary,
  type ConversationView,
  type FriendRequestHistoryEntry,
  type MessageResponse,
  type UnreadCountResponse,
  type UnreadThreadCountResponse,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { activeQuery, readPages } from '../api/query';
import { type SnowflakeID } from '../api/snowflake-id';
import { isMessageChange, type MessageChange } from '../messages/message-change';
import { ChatChangeKind, ChatStore } from './chat-store';

export enum ChatListError {
  Load = 1,
  Unread,
  Recent,
  More,
}
export interface ChatQuery {
  readonly items: Signal<ChatListItem[]>;
  readonly loading: Signal<boolean>;
  readonly error: Signal<ChatListError | undefined>;
  readonly hasMore: Signal<boolean>;
  readonly loadingMore: Signal<boolean>;
  readonly loadedThrough: Signal<number>;
  activate(): () => void;
  refresh(): void;
  loadMore(): Promise<void>;
}
enum ListFetch {
  Load,
  Recent,
  More,
}
interface QueryState {
  archived: boolean;
  ids: WritableSignal<SnowflakeID[]>;
  cursor: WritableSignal<SnowflakeID | undefined>;
  loading: WritableSignal<boolean>;
  loadingMore: WritableSignal<boolean>;
  loadedThrough: WritableSignal<number>;
  error: WritableSignal<ChatListError | undefined>;
  dirty: WritableSignal<boolean>;
  consumers: Set<symbol>;
  generation: number;
  recentVersion: number;
  cancel: Subject<void>;
  requests: Map<ListFetch, Promise<void>>;
  /** Chats whose unread changed while no list was visible; refreshed by id on activation. */
  pendingUnread: Set<SnowflakeID>;
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
    error: signal(false),
    dirty: true,
    version: 0,
    consumers: 0,
    request: undefined as QueryRequest | undefined,
  };
}
type ThreadQuery = ReturnType<typeof createThreadQuery>;
@Service()
export class ChatListStore {
  private readonly api = inject(ChatsService);
  private readonly chatInfo = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly realtime = inject(Connection);
  private readonly queries = new Map<boolean, { state: QueryState; handle: ChatQuery }>();
  private changeRefreshPending = false;
  private readonly friendsApi = inject(FriendsService);
  private readonly threadsApi = inject(ThreadsService);
  private readonly activeRequests = this.requestCache(false);
  private readonly historicalRequests = this.requestCache(true);
  private readonly activeThreads = this.threadCache(false);
  private readonly archivedThreads = this.threadCache(true);
  private readonly conversationApi = inject(ConversationsService);
  private readonly session = inject(SessionStore);
  readonly selection = signal<ListSelection>({ tab: ListTab.Messages, archived: false, requestHistory: false });
  private readonly viewQuery = activeQuery<
    { uid: number | undefined; summaries: ConversationUnreadSummary[] } | undefined
  >(
    this.destroyRef,
    async (cancel) => {
      const uid = this.session.user()?.uid;
      if (uid == null) return { uid, summaries: [] };
      const response = await this.response(
        this.conversationApi.unreadSummary({ views: builtinConversationViews() }),
        cancel,
      );
      return { uid, summaries: response.summaries };
    },
    undefined,
  );
  readonly viewUnread = {
    ...this.viewQuery,
    value: computed(() => {
      const snapshot = this.viewQuery.value();
      return snapshot?.uid === this.session.user()?.uid ? snapshot?.summaries : undefined;
    }),
  };
  summary(view: ConversationView): ConversationUnreadSummary | undefined {
    return this.viewUnread.value()?.find((summary) => summary.key === view.key);
  }

  readonly unread = activeQuery<UnreadCountResponse | undefined>(
    this.destroyRef,
    (cancel) => this.response(this.api.getUnreadCount({ timeout: 10000 }), cancel),
    undefined,
  );
  readonly threadUnread = activeQuery<UnreadThreadCountResponse | undefined>(
    this.destroyRef,
    (cancel) => this.response(this.threadsApi.getUnreadThreadCount(), cancel),
    undefined,
  );
  readonly archivedUnread = {
    chats: {
      ...this.unread,
      value: computed(() => this.unread.value()?.archivedUnreadCount),
    },
    threads: {
      ...this.threadUnread,
      value: computed(() => this.threadUnread.value()?.archivedUnreadMessageCount),
    },
    refresh: () => this.refreshArchivedUnread(),
    refreshChats: () => this.refreshChatUnread(),
  };

  constructor() {
    effect(() => {
      this.session.user()?.uid;
      untracked(() => void this.viewUnread.refresh());
    });
    for (const archived of [false, true]) this.queries.set(archived, this.createQuery(archived));
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      void this.invalidateRequests();
      void this.invalidateThreads();
      this.refreshArchivedUnread();
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
    this.chatInfo.changes$.pipe(takeUntilDestroyed()).subscribe(({ kind, threadId }) => {
      void this.viewUnread.refresh();
      if (threadId) {
        void this.threadUnread.refresh();
        if (kind === ChatChangeKind.Membership) void this.invalidateThreads();
      } else {
        this.refreshChatUnread();
        if (kind === ChatChangeKind.Membership) this.refreshChats();
      }
    });
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (isMessageChange(event)) {
        this.receiveChange(event);
        this.receiveThreadChange(event);
      }
      switch (event.type) {
        case ServerWsMessageType.message:
          void this.viewUnread.refresh();
          this.receiveMessage(event.payload);
          if (event.payload.replyRootId) {
            void this.invalidateThreads();
            void this.archivedUnread.threads.refresh();
          } else this.refreshChatUnread();
          break;
        case ServerWsMessageType.friendRequestReceived:
        case ServerWsMessageType.friendRequestResolved:
          void this.invalidateRequests();
          if (
            event.type === ServerWsMessageType.friendRequestResolved &&
            event.payload.status === FriendRequestStatus.accepted
          )
            this.refreshChats();
          break;
        case ServerWsMessageType.threadUpdate:
        case ServerWsMessageType.threadMembershipChanged:
          void this.viewUnread.refresh();
          void this.invalidateThreads();
          void this.archivedUnread.threads.refresh();
          break;
        case ServerWsMessageType.chatArchiveStateChanged: {
          this.refreshChats();
          this.refreshChatUnread();
          break;
        }
        case ServerWsMessageType.messageUpdated:
          if (!event.payload.replyRootId) this.chatInfo.invalidateReads(new Set([event.payload.chatId]));
          this.refreshChatUnread();
          if (this.chatInfo.unreadMentions(event.payload.chatId, event.payload.replyRootId) > 0) {
            if (event.payload.replyRootId) void this.invalidateThreads();
            else this.syncUnread(event.payload.chatId);
          }
          break;
        case ServerWsMessageType.notification:
          // Every notification type (mention/reply/reaction) changes a count
          // carried by the list, thread read state, or the global title
          // totals; refetch the authoritative scopes instead of guessing.
          this.refreshChatUnread();
          if (event.payload.threadRootId) {
            void this.invalidateThreads();
          } else {
            this.chatInfo.invalidateReads(new Set([event.payload.chatId]));
            this.syncUnread(event.payload.chatId);
          }
          break;
        case ServerWsMessageType.friendshipRemoved:
          this.refreshChatUnread();
          break;
        case ServerWsMessageType.messageDeleted:
          void this.viewUnread.refresh();
          if (event.payload.replyRootId) void this.archivedUnread.threads.refresh();
          else this.refreshChatUnread();
          break;
        case ServerWsMessageType.messagesBulkDeleted:
          this.refreshArchivedUnread();
          break;
      }
    });
  }

  chats(archived: boolean): ChatQuery {
    return this.queries.get(archived)!.handle;
  }

  private createQuery(archived: boolean): { state: QueryState; handle: ChatQuery } {
    const state: QueryState = {
      archived,
      ids: signal([]),
      cursor: signal(undefined),
      loading: signal(false),
      loadingMore: signal(false),
      loadedThrough: signal(Infinity),
      error: signal(undefined),
      dirty: signal(true),
      consumers: new Set(),
      generation: 0,
      recentVersion: 0,
      cancel: new Subject(),
      requests: new Map(),
      pendingUnread: new Set(),
      headStale: false,
    };
    const handle: ChatQuery = {
      items: computed(() =>
        state
          .ids()
          .map((id) => this.chatInfo.chat(id))
          .filter((chat) => chat.archived === archived)
          .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')),
      ),
      loading: state.loading.asReadonly(),
      error: state.error.asReadonly(),
      hasMore: computed(() => !state.dirty() && !!state.cursor()),
      loadingMore: state.loadingMore.asReadonly(),
      loadedThrough: state.loadedThrough.asReadonly(),
      activate: () => {
        const consumer = Symbol();
        state.consumers.add(consumer);
        if (state.dirty() && !state.requests.has(ListFetch.Load)) void this.fetchQuery(state, ListFetch.Load);
        else this.reconcile(state);
        return () => {
          state.consumers.delete(consumer);
          if (!state.consumers.size && state.requests.size) this.cancelQuery(state);
        };
      },
      refresh: () => {
        this.chatInfo.invalidateReads(new Set(state.ids()));
        this.invalidateQuery(state);
      },
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
    query.error.set(undefined);
    if (query.consumers.size && !this.destroyRef.destroyed) void this.fetchQuery(query, ListFetch.Load);
  }

  /** Reconciles a list hidden from view without reloading rows that live events kept current. */
  private reconcile(query: QueryState) {
    if (!query.consumers.size || this.destroyRef.destroyed) return;
    for (const chatId of query.pendingUnread) void this.syncUnread(chatId);
    query.pendingUnread.clear();
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
    query.error.set(undefined);
    const promise = (async () => {
      try {
        while (true) {
          const recentVersion = query.recentVersion;
          if (mode === ListFetch.Load) {
            if (!(await this.readFromHead(query, generation))) return;
            query.dirty.set(false);
          } else if (mode === ListFetch.Recent) {
            if (!(await this.readRecent(query, generation))) return;
          } else {
            const { page, version } = await this.readPage(query, after);
            if (this.destroyRef.destroyed || generation !== query.generation) return;
            this.chatInfo.acceptChats(page.chats, version);
            query.ids.update((ids) => [...new Set([...ids, ...page.chats.map((chat) => chat.id)])]);
            this.applyBoundary(query, page.chats, page.nextCursor);
          }
          if (mode !== ListFetch.Recent || recentVersion === query.recentVersion) return;
        }
      } catch {
        if (!this.destroyRef.destroyed && generation === query.generation) {
          query.error.set(
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

  private readPage(query: QueryState, cursor?: SnowflakeID) {
    // Snapshot before the request so live previews received meanwhile keep their version.
    const version = this.chatInfo.snapshot();
    return firstValueFrom(
      this.api
        .getChats({
          limit: 50,
          ...(query.archived ? { archived: true } : {}),
          ...(cursor ? { after: cursor } : {}),
        })
        .pipe(takeUntil(query.cancel), takeUntilDestroyed(this.destroyRef)),
    ).then((page) => ({ page, version }));
  }

  /** Applies each page before reading the next, up to the depth already loaded or the tail. */
  private async readFromHead(query: QueryState, generation: number) {
    const depth = query.ids().length;
    const read: SnowflakeID[] = [];
    let loaded = 0;
    let cursor: SnowflakeID | undefined;
    do {
      const { page, version } = await this.readPage(query, cursor);
      if (this.destroyRef.destroyed || generation !== query.generation) return false;
      this.chatInfo.acceptChats(page.chats, version);
      read.push(...page.chats.map((chat) => chat.id));
      query.ids.update((ids) => [...new Set([...ids, ...page.chats.map((chat) => chat.id)])]);
      loaded += page.chats.length;
      cursor = page.nextCursor;
      this.applyBoundary(query, page.chats, page.nextCursor);
    } while (cursor && loaded < depth);
    // Replace membership only after the refreshed window is complete.
    query.ids.set([...new Set(read)]);
    return true;
  }

  /** Bridge the new head to the previously loaded window without moving its pagination cursor. */
  private async readRecent(query: QueryState, generation: number) {
    const boundary = query.loadedThrough();
    let cursor: SnowflakeID | undefined;
    do {
      const { page, version } = await this.readPage(query, cursor);
      if (this.destroyRef.destroyed || generation !== query.generation) return false;
      this.chatInfo.acceptChats(page.chats, version);
      query.ids.update((ids) => [...new Set([...ids, ...page.chats.map((chat) => chat.id)])]);
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
    const active = [...this.queries.values()].map(({ state }) => state).filter((query) => query.consumers.size);
    if (active.length) this.syncUnread(message.chatId);
    for (const query of active) {
      if (!query.ids().includes(message.chatId)) {
        query.recentVersion++;
        if (!query.requests.has(ListFetch.Load))
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
      // Read now so uncovering the list does not wait for the read state.
      if (!document.hidden) void this.syncHiddenUnread(state, message.chatId);
    }
  }

  private async syncHiddenUnread(query: QueryState, chatId: SnowflakeID) {
    try {
      await this.chatInfo.getReadState(chatId);
      query.pendingUnread.delete(chatId);
    } catch {
      // Keep it pending: activation retries and only a visible list reports the failure.
    }
  }

  private receiveChange(change: MessageChange) {
    if (change.type === ServerWsMessageType.reactionUpdated) return;
    if (change.type !== ServerWsMessageType.messagesBulkDeleted && change.payload.replyRootId) return;
    // Edits are already applied to the shared preview; they never change list membership or order.
    if (change.type === ServerWsMessageType.messageUpdated) return;
    if (!this.changeRefreshPending) {
      this.changeRefreshPending = true;
      void Promise.resolve().then(() => {
        this.changeRefreshPending = false;
        this.refreshChats();
      });
    }
  }

  private syncUnread(chatId: SnowflakeID) {
    void this.chatInfo.getReadState(chatId).catch(() => {
      if (!this.destroyRef.destroyed) {
        for (const { state } of this.queries.values()) if (state.consumers.size) state.error.set(ChatListError.Unread);
      }
    });
  }

  refreshChats() {
    if (this.destroyRef.destroyed) return;
    void this.viewUnread.refresh();
    this.chatInfo.invalidateReads();
    for (const { state } of this.queries.values()) this.invalidateQuery(state);
  }

  private receiveThreadChange(change: MessageChange) {
    if (change.type === ServerWsMessageType.reactionUpdated) return;
    if (change.type === ServerWsMessageType.messageUpdated) {
      for (const { state } of [this.activeThreads, this.archivedThreads])
        if (state.request || !state.consumers) this.invalidate(state);
    } else void this.invalidateThreads();
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
        const page = await this.response(this.friendsApi.listFriendRequestHistory({ archived }), cancel);
        return page.requests;
      },
      [],
    );
    return { ...query, items: value };
  }

  private threadCache(archived: boolean) {
    const state = createThreadQuery(archived);
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
        error: state.error.asReadonly(),
        hasMore: computed(() => !!state.cursor()),
        loadingMore: state.loadingMore.asReadonly(),
        activate: () => this.activateThreadQuery(state),
        refresh: () => {
          this.invalidate(state);
          return this.loadThreads(state);
        },
        loadMore: () => {
          const cursor = state.cursor();
          return !cursor || state.request || state.dirty ? Promise.resolve() : this.loadThreads(state, cursor);
        },
      },
    };
  }

  private activateThreadQuery(current: ThreadQuery) {
    current.consumers++;
    if (current.dirty) void this.loadThreads(current);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
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
    try {
      await this.response<unknown>(
        action === FriendRequestAction.Accept
          ? this.friendsApi.acceptFriendRequest(id)
          : action === FriendRequestAction.Reject
            ? this.friendsApi.rejectFriendRequest(id)
            : this.friendsApi.archiveFriendRequest(id),
      );
      if (!this.destroyRef.destroyed && action === FriendRequestAction.Accept) this.refreshChats();
    } finally {
      // A conflict can mean another device has already decided the request.
      if (!this.destroyRef.destroyed) await this.invalidateRequests();
    }
  }

  private async invalidateThreads() {
    await Promise.all(
      [this.activeThreads, this.archivedThreads].map(({ state }) => {
        this.invalidate(state);
        return state.consumers ? this.loadThreads(state) : undefined;
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
    current.error.set(false);
    operation.promise = (async () => {
      await Promise.resolve();
      while (!this.destroyRef.destroyed && current.request === operation) {
        const version = current.version;
        const readVersion = this.chatInfo.snapshot();
        const subscriptionVersion = this.chatInfo.subscriptionSnapshot();
        try {
          const read = async (cursor?: string) => {
            const page = await this.response(
              this.threadsApi.getThreads({
                limit: 20,
                archived: current.archived,
                ...(cursor ? { before: cursor } : {}),
              }),
              operation.cancel,
            );
            return { items: page.threads, cursor: page.nextCursor };
          };
          const result = before
            ? await read(before)
            : await readPages(read, current.ids().length, () => version === current.version);
          const page = { threads: result.items, nextCursor: result.cursor };
          if (this.destroyRef.destroyed || current.request !== operation) return;
          if (version === current.version) {
            this.chatInfo.acceptThreads(page.threads, readVersion, subscriptionVersion);
            current.ids.update((ids) => [
              ...new Set([...(before ? ids : []), ...page.threads.map((thread) => thread.threadRootMessage.id)]),
            ]);
            current.cursor.set(page.nextCursor);
            current.loadedThrough.set(page.nextCursor ? Date.parse(page.nextCursor) : -Infinity);
            current.dirty = false;
            return;
          }
        } catch {
          if (this.destroyRef.destroyed || current.request !== operation) return;
          if (version === current.version) {
            current.error.set(true);
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

  private refreshChatUnread() {
    void this.viewUnread.refresh();
    void this.unread.refresh();
  }

  private refreshArchivedUnread() {
    this.refreshChatUnread();
    void this.threadUnread.refresh();
  }
}
