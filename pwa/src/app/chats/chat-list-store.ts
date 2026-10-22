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
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { FriendsService } from '../../generated/endpoints/friends/friends.service';
import { SessionStore } from '../session/session-store';
import { conversationUnread } from './conversation-unread';
import { ListTab, type ListSelection } from './list-tabs';
import { ThreadsService } from '../../generated/endpoints/threads/threads.service';
import {
  FriendRequestStatus,
  GroupKind,
  NotificationType,
  ServerWsMessageType,
  type ChatListItem,
  type ConversationUnreadSummary,
  type ConversationView,
  type FriendRequestHistoryEntry,
  type MessageResponse,
  type ThreadListItem,
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
    headOnly: false,
    headBoundary: -Infinity,
    pendingReads: new Set<SnowflakeID>(),
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
  private threadRefreshPending?: Promise<void>;
  private readonly threadMessages = new Set<SnowflakeID>();
  private readonly friendsApi = inject(FriendsService);
  private readonly threadsApi = inject(ThreadsService);
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

  constructor() {
    for (const archived of [false, true]) this.queries.set(archived, this.createQuery(archived));
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      void this.invalidateRequests();
      void this.invalidateThreads();
    });
    const visible = () => {
      if (document.hidden) return;
      for (const { state } of this.queries.values()) {
        if (!state.consumers.size) continue;
        if (state.dirty()) void this.fetchQuery(state, ListFetch.Load);
        else this.reconcile(state);
      }
      for (const { state } of [this.activeThreads, this.archivedThreads]) {
        if (!state.consumers) continue;
        if (state.dirty) void this.loadThreads(state);
        this.flushThreadReads(state);
      }
    };
    document.addEventListener('visibilitychange', visible);
    this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', visible));
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
      if (kind === ChatChangeKind.Attention) {
        if (threadId) this.refreshThreadRead(threadId);
        else this.queueUnread(chatId);
        return;
      }
      if (threadId) {
        if (kind === ChatChangeKind.Membership) void this.invalidateThreads();
      } else {
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
          void this.invalidateRequests();
          if (
            event.type === ServerWsMessageType.friendRequestResolved &&
            event.payload.status === FriendRequestStatus.accepted
          )
            this.refreshChats();
          break;
        case ServerWsMessageType.threadUpdate:
          this.chatInfo.invalidateThreadReads([event.payload.threadRootId]);
          this.refreshThreadRead(event.payload.threadRootId);
          break;
        case ServerWsMessageType.threadMembershipChanged:
          void this.invalidateThreads();
          break;
        case ServerWsMessageType.chatArchiveStateChanged: {
          this.refreshChats();
          break;
        }
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
    if (active.length) this.queueUnread(message.chatId);
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

  private async syncHiddenUnread(query: QueryState, chatId: SnowflakeID) {
    try {
      await this.chatInfo.scheduleReadState(chatId);
      query.pendingUnread.delete(chatId);
    } catch {
      // Keep it pending: activation retries and only a visible list reports the failure.
      if (query.consumers.size && !this.destroyRef.destroyed) query.error.set(ChatListError.Unread);
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
      void this.chatInfo
        .getThreadReadState(thread.chatId, id)
        .then(() => state.pendingReads.delete(id))
        .catch(() => state.error.set(true));
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
    // Edits patch shared previews; attention changes have their own scoped read refresh.
    if (change.type === ServerWsMessageType.reactionUpdated || change.type === ServerWsMessageType.messageUpdated)
      return;
    void this.invalidateThreads();
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
    else this.flushThreadReads(current);
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
    current.error.set(false);
    operation.promise = (async () => {
      await Promise.resolve();
      while (!this.destroyRef.destroyed && current.request === operation) {
        const version = current.version;
        const headOnly = current.headOnly && !before;
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
            current.ids.update((ids) => [
              ...new Set([
                ...(before || headOnly ? ids : []),
                ...page.threads.map((thread) => thread.threadRootMessage.id),
              ]),
            ]);
            current.cursor.set(page.nextCursor);
            if (!before && page.threads.length) current.headBoundary = Date.parse(page.threads[0].lastReplyAt);
            if (!headOnly) current.loadedThrough.set(page.nextCursor ? Date.parse(page.nextCursor) : -Infinity);
            current.dirty = false;
            current.headOnly = false;
            this.flushThreadReads(current);
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
}
