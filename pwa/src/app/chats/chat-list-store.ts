import { computed, DestroyRef, inject, Service, signal, type Signal, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, Subject, takeUntil, type Observable } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { FriendsService } from '../../generated/endpoints/friends/friends.service';
import { ThreadsService } from '../../generated/endpoints/threads/threads.service';
import {
  FriendRequestStatus,
  ServerWsMessageType,
  type ChatListItem,
  type FriendRequestHistoryEntry,
  type MessageResponse,
  type UnreadCountResponse,
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
  readonly unread = activeQuery<UnreadCountResponse | undefined>(
    this.destroyRef,
    (cancel) => this.response(this.api.getUnreadCount({ timeout: 10000 }), cancel),
    undefined,
  );
  private readonly archivedThreadUnread = activeQuery(
    this.destroyRef,
    async (cancel) => {
      const counts = await this.response(this.threadsApi.getUnreadThreadCount(), cancel);
      return counts.archivedUnreadMessageCount;
    },
    undefined,
  );
  readonly archivedUnread = {
    chats: {
      ...this.unread,
      value: computed(() => this.unread.value()?.archivedUnreadCount),
    },
    threads: this.archivedThreadUnread,
    refresh: () => this.refreshArchivedUnread(),
    refreshChats: () => this.refreshChatUnread(),
  };

  constructor() {
    for (const archived of [false, true]) this.queries.set(archived, this.createQuery(archived));
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.refreshChats();
      void this.invalidateRequests();
      void this.invalidateThreads();
      this.refreshArchivedUnread();
    });
    this.chatInfo.changes$.pipe(takeUntilDestroyed()).subscribe(({ kind, threadId }) => {
      if (threadId) {
        void this.archivedThreadUnread.refresh();
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
          void this.invalidateThreads();
          void this.archivedUnread.threads.refresh();
          break;
        case ServerWsMessageType.chatArchiveStateChanged: {
          this.refreshChats();
          this.refreshChatUnread();
          break;
        }
        case ServerWsMessageType.friendshipRemoved:
          this.refreshChatUnread();
          break;
        case ServerWsMessageType.messageDeleted:
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
        return () => {
          state.consumers.delete(consumer);
          if (!state.consumers.size && state.requests.size) {
            state.dirty.set(true);
            this.cancelQuery(state);
          }
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
    query.error.set(undefined);
    if (query.consumers.size && !this.destroyRef.destroyed) void this.fetchQuery(query, ListFetch.Load);
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
          const version = this.chatInfo.snapshot();
          const read = async (cursor?: SnowflakeID) => {
            const page = await firstValueFrom(
              this.api
                .getChats({
                  limit: 50,
                  ...(query.archived ? { archived: true } : {}),
                  ...(cursor ? { after: cursor } : {}),
                })
                .pipe(takeUntil(query.cancel), takeUntilDestroyed(this.destroyRef)),
            );
            return { items: page.chats, cursor: page.nextCursor };
          };
          const result =
            mode === ListFetch.Load
              ? await readPages(read, query.ids().length, () => generation === query.generation)
              : await read(after);
          const page = { chats: result.items, nextCursor: result.cursor };
          if (this.destroyRef.destroyed || generation !== query.generation) return;
          this.chatInfo.acceptChats(page.chats, version);
          query.ids.update((ids) => [
            ...new Set([...(mode === ListFetch.Load ? [] : ids), ...page.chats.map((chat) => chat.id)]),
          ]);
          if (mode !== ListFetch.Recent) {
            query.cursor.set(page.nextCursor);
            // Use the server page boundary, not rows subsequently moved by live messages.
            const time = page.chats.at(-1)?.lastMessageAt;
            query.loadedThrough.set(page.nextCursor && time ? Date.parse(time) : -Infinity);
          }
          if (mode === ListFetch.Load) query.dirty.set(false);
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

  private receiveMessage(message: MessageResponse) {
    if (message.replyRootId) return;
    const active = [...this.queries.values()].map(({ state }) => state).filter((query) => query.consumers.size);
    for (const { state } of this.queries.values()) if (!state.consumers.size) state.dirty.set(true);
    if (active.length) this.syncUnread(message.chatId);
    for (const query of active) {
      if (!query.ids().includes(message.chatId)) {
        query.recentVersion++;
        if (!query.requests.has(ListFetch.Load))
          void this.fetchQuery(query, query.dirty() ? ListFetch.Load : ListFetch.Recent);
      }
    }
  }

  private receiveChange(change: MessageChange) {
    if (change.type === ServerWsMessageType.reactionUpdated) return;
    if (change.type !== ServerWsMessageType.messagesBulkDeleted && change.payload.replyRootId) return;
    if (change.type === ServerWsMessageType.messageUpdated) {
      for (const { state } of this.queries.values()) if (!state.consumers.size) state.dirty.set(true);
    } else if (!this.changeRefreshPending) {
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
    void this.unread.refresh();
  }

  private refreshArchivedUnread() {
    this.refreshChatUnread();
    void this.archivedThreadUnread.refresh();
  }
}
