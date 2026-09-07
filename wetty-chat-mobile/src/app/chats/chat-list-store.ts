import { readPages, activeQuery } from '../api/query';
import { type SnowflakeID } from '../api/snowflake-id';
import { computed, DestroyRef, inject, Service, signal, type Signal, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ServerWsMessageType,
  type ChatListItem,
  type MarkChatReadStateResponse,
  type MessagePreview,
  type MessageResponse,
  type FriendRequestHistoryEntry,
  type MarkThreadReadResponse,
  type ThreadListItem,
  type ThreadSubscriptionStatusResponse,
  FriendRequestStatus,
} from '../../generated/models';
import { firstValueFrom, Subject, takeUntil, timer, type Observable } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { GroupsService } from '../../generated/endpoints/groups/groups.service';
import { ChatStore } from './chat-store';
import { type MessageChange, isMessageChange } from '../messages/message-change';
import { Connection } from '../api/connection';
import { FriendsService } from '../../generated/endpoints/friends/friends.service';
import { ThreadsService } from '../../generated/endpoints/threads/threads.service';

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
  items: WritableSignal<ChatListItem[]>;
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
interface ChatReadOperation {
  version: number;
  refresh?: Promise<MarkChatReadStateResponse>;
  read?: { messageId: SnowflakeID; promise: Promise<void>; sent: boolean };
  rewind?: Promise<void>;
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
    items: signal<ThreadListItem[]>([]),
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
type Subscription = {
  chatId: SnowflakeID;
  status: ThreadSubscriptionStatusResponse | undefined;
  version: number;
};
@Service()
export class ChatListStore {
  private readonly api = inject(ChatsService);
  private readonly groupsApi = inject(GroupsService);
  private readonly chatInfo = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly realtime = inject(Connection);
  private readonly queries = new Map<boolean, { state: QueryState; handle: ChatQuery }>();
  private readonly previews = signal(
    new Map<SnowflakeID, { message: MessagePreview; version: number; changed?: boolean }>(),
  );
  private readonly readStates = signal(
    new Map<SnowflakeID, { state: MarkChatReadStateResponse; version: number; dirty: boolean }>(),
  );
  private readonly readOperations = new Map<SnowflakeID, ChatReadOperation>();
  private readonly readConsumers = new Map<symbol, SnowflakeID>();
  private updateVersion = 0;
  private changeRefreshPending = false;
  private readonly listRequests = new Set<{ version: number }>();
  private readonly friendsApi = inject(FriendsService);
  private readonly threadsApi = inject(ThreadsService);
  private readonly threadReadOverrides = signal(
    new Map<SnowflakeID, { state: MarkThreadReadResponse; version: number }>(),
  );
  private readonly subscriptions = signal(new Map<SnowflakeID, Subscription>());
  private subscriptionVersion = 0;
  private readonly subscriptionRequests = new Map<SnowflakeID, Promise<void>>();
  private readVersion = 0;
  private readonly threadListReads = new Set<{ version: number }>();
  private readonly readRequests = new Map<SnowflakeID, { messageId: SnowflakeID; promise: Promise<void> }>();
  private readonly activeRequests = this.requestCache(false);
  private readonly historicalRequests = this.requestCache(true);
  private readonly activeThreads = this.threadCache(false);
  private readonly archivedThreads = this.threadCache(true);
  private readonly archivedChatUnread = activeQuery(
    this.destroyRef,
    async (cancel) => {
      const counts = await this.response(this.api.getUnreadCount(), cancel);
      return counts.archivedUnreadCount;
    },
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
    chats: this.archivedChatUnread,
    threads: this.archivedThreadUnread,
    refresh: () => this.refreshArchivedUnread(),
    refreshChats: () => this.refreshArchivedChats(),
  };

  constructor() {
    for (const archived of [false, true]) this.queries.set(archived, this.createQuery(archived));
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.refreshChats();
      this.invalidateSubscriptions();
      void this.invalidateRequests();
      void this.invalidateThreads();
      this.refreshArchivedUnread();
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
            this.invalidateSubscriptions(event.payload.replyRootId);
            void this.invalidateThreads();
            void this.archivedUnread.threads.refresh();
          } else this.refreshArchivedChats();
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
          if (event.type === ServerWsMessageType.threadMembershipChanged)
            this.invalidateSubscriptions(event.payload.threadRootId);
          void this.invalidateThreads();
          void this.archivedUnread.threads.refresh();
          break;
        case ServerWsMessageType.chatArchiveStateChanged: {
          const { chatId, archived, mutedUntil } = event.payload;
          this.applyChatState(chatId, { archived, mutedUntil });
          this.refreshChats();
          this.refreshArchivedChats();
          break;
        }
        case ServerWsMessageType.friendshipRemoved:
          this.refreshArchivedChats();
          break;
        case ServerWsMessageType.messageDeleted:
          if (event.payload.replyRootId) void this.archivedUnread.threads.refresh();
          else this.refreshArchivedChats();
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
      items: signal([]),
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
          .items()
          .filter((chat) => chat.archived === archived)
          .map((chat) => {
            const override = this.previews().get(chat.id);
            const preview = override?.message;
            const read = this.readStates().get(chat.id)?.state;
            return {
              ...chat,
              ...(preview &&
              (!chat.lastMessage ||
                preview.id > chat.lastMessage.id ||
                (override.changed && preview.id === chat.lastMessage.id))
                ? { lastMessage: preview, lastMessageAt: preview.createdAt }
                : {}),
              ...read,
            };
          })
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
          this.pruneInactiveOverrides();
        };
      },
      refresh: () => {
        this.invalidateReads(new Set(state.items().map((chat) => chat.id)));
        this.invalidateQuery(state);
        this.syncUnreadStates();
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
          const request = { version: this.updateVersion };
          this.listRequests.add(request);
          try {
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
                ? await readPages(read, query.items().length, () => generation === query.generation)
                : await read(after);
            const page = { chats: result.items, nextCursor: result.cursor };
            if (this.destroyRef.destroyed || generation !== query.generation) return;
            this.acceptChats(page.chats, request.version);
            query.items.update((items) => [
              ...new Map(
                [...(mode === ListFetch.Load ? [] : items), ...page.chats].map((chat) => [chat.id, chat]),
              ).values(),
            ]);
            if (mode !== ListFetch.Recent) {
              query.cursor.set(page.nextCursor);
              // Use the server page boundary, not rows subsequently moved by live messages.
              const time = page.chats.at(-1)?.lastMessageAt;
              query.loadedThrough.set(page.nextCursor && time ? Date.parse(time) : -Infinity);
            }
            if (mode === ListFetch.Load) query.dirty.set(false);
          } finally {
            this.listRequests.delete(request);
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
        this.pruneInactiveOverrides();
      }
    })();
    query.requests.set(mode, promise);
    return promise;
  }

  private receiveMessage(message: MessageResponse) {
    if (message.replyRootId) return;
    const previous = this.previews().get(message.chatId)?.message;
    if (previous?.id === message.id) return;
    this.invalidateReads(new Set([message.chatId]));
    const active = [...this.queries.values()].map(({ state }) => state).filter((query) => query.consumers.size);
    for (const { state } of this.queries.values()) if (!state.consumers.size) state.dirty.set(true);
    if (!active.length && ![...this.readConsumers.values()].includes(message.chatId)) {
      this.pruneInactiveOverrides();
      return;
    }
    if (!previous || previous.id < message.id) {
      const preview: MessagePreview = {
        id: message.id,
        clientGeneratedId: message.clientGeneratedId,
        createdAt: message.createdAt,
        sender: message.sender,
        message: message.message,
        messageType: message.messageType,
        isDeleted: message.isDeleted,
        attachments: message.attachments.map(({ kind }) => ({ kind })),
        mentions: message.mentions ?? [],
        sticker: message.sticker ? { emoji: message.sticker.emoji } : message.sticker,
      };
      this.previews.update((previews) =>
        new Map(previews).set(message.chatId, { message: preview, version: ++this.updateVersion }),
      );
    }
    this.syncUnread(message.chatId);
    for (const query of active) {
      if (!query.items().some((chat) => chat.id === message.chatId && chat.archived === query.archived)) {
        query.recentVersion++;
        if (!query.requests.has(ListFetch.Load)) {
          void this.fetchQuery(query, query.dirty() ? ListFetch.Load : ListFetch.Recent);
        }
      }
    }
  }

  private receiveChange(change: MessageChange) {
    if (change.type === ServerWsMessageType.reactionUpdated) return;
    if (change.type !== ServerWsMessageType.messagesBulkDeleted && change.payload.replyRootId) return;
    const { chatId } = change.payload;
    const latest = [
      this.previews().get(chatId)?.message,
      ...[...this.queries.values()].map(({ state }) => state.items().find((chat) => chat.id === chatId)?.lastMessage),
    ].reduce<MessagePreview | undefined>(
      (latest, message) => (message && (!latest || message.id > latest.id) ? message : latest),
      undefined,
    );
    const updated =
      change.type === ServerWsMessageType.messagesBulkDeleted
        ? latest && change.payload.messageIds.includes(latest.id)
          ? { ...latest, isDeleted: true, message: undefined, attachments: [], mentions: [], sticker: undefined }
          : undefined
        : latest?.id === change.payload.id
          ? { ...change.payload, mentions: change.payload.mentions ?? [] }
          : undefined;
    if (updated) {
      this.updateCachedChats(chatId, { lastMessage: updated, lastMessageAt: updated.createdAt });
      this.previews.update((previews) =>
        new Map(previews).set(chatId, { message: updated, version: ++this.updateVersion, changed: true }),
      );
      this.pruneInactiveOverrides();
    }
    if (change.type === ServerWsMessageType.messageUpdated) {
      for (const { state } of this.queries.values()) if (!state.consumers.size) state.dirty.set(true);
      return;
    }
    if (this.changeRefreshPending) return;
    this.changeRefreshPending = true;
    void Promise.resolve().then(() => {
      this.changeRefreshPending = false;
      this.refreshChats();
    });
  }

  cachedReadState(chatId: SnowflakeID): MarkChatReadStateResponse | undefined {
    const read = this.readStates().get(chatId);
    if (read) return read.dirty ? undefined : read.state;
    for (const { state } of this.queries.values()) {
      if (state.dirty()) continue;
      const chat = state.items().find((chat) => chat.id === chatId && chat.archived === state.archived);
      if (chat) return { lastReadMessageId: chat.lastReadMessageId, unreadCount: chat.unreadCount };
    }
    return undefined;
  }

  getReadState(chatId: SnowflakeID): Promise<MarkChatReadStateResponse> {
    return this.readOperation(chatId).refresh ?? this.refreshUnread(chatId);
  }

  retainReadState(chatId: SnowflakeID): () => void {
    const state = this.cachedReadState(chatId);
    const consumer = Symbol();
    this.readConsumers.set(consumer, chatId);
    if (state && !this.readStates().has(chatId)) this.applyReadState(chatId, state);
    return () => {
      this.readConsumers.delete(consumer);
      this.pruneInactiveOverrides();
    };
  }

  private refreshUnread(chatId: SnowflakeID): Promise<MarkChatReadStateResponse> {
    const operation = this.readOperation(chatId);
    operation.version++;
    const current = operation.refresh;
    if (current) return current;
    const request = (async () => {
      while (true) {
        const version = operation.version;
        const state = await firstValueFrom(
          this.api.getChatUnreadCount(chatId).pipe(takeUntilDestroyed(this.destroyRef)),
        );
        if (this.destroyRef.destroyed) return state;
        // A message or successful read arrived during this request; its count may already be included.
        if (version !== operation.version) continue;
        this.applyReadState(chatId, state);
        return state;
      }
    })().finally(() => {
      operation.refresh = undefined;
      this.releaseReadOperation(chatId, operation);
    });
    operation.refresh = request;
    return request;
  }

  markRead(chatId: SnowflakeID, messageId: SnowflakeID): Promise<void> {
    const operation = this.readOperation(chatId);
    if (operation.rewind) return Promise.resolve();
    const current = operation.read;
    if (current) {
      if (messageId > current.messageId) current.messageId = messageId;
      return current.promise;
    }
    const lastRead =
      this.readStates().get(chatId)?.state.lastReadMessageId ?? this.cachedReadState(chatId)?.lastReadMessageId;
    if (lastRead && messageId <= lastRead) {
      this.releaseReadOperation(chatId, operation);
      return Promise.resolve();
    }
    const request = { messageId, promise: Promise.resolve(), sent: false };
    request.promise = (async () => {
      while (true) {
        await firstValueFrom(timer(1000).pipe(takeUntilDestroyed(this.destroyRef)), { defaultValue: 0 });
        if (this.destroyRef.destroyed || operation.read !== request) return;
        const target = request.messageId;
        const version = operation.version;
        const refreshing = !!operation.refresh;
        request.sent = true;
        let state = await firstValueFrom(
          this.api.markAsRead(chatId, { messageId: target }).pipe(takeUntilDestroyed(this.destroyRef)),
        );
        if (this.destroyRef.destroyed) return;
        this.refreshArchivedChats();
        const lastRead = this.readStates().get(chatId)?.state.lastReadMessageId;
        if (!lastRead || (state.lastReadMessageId && state.lastReadMessageId >= lastRead)) {
          this.applyReadState(chatId, state);
        }
        if (operation.read !== request) return;
        // Concurrent WebSocket/GET snapshots may straddle this read; reconcile without guessing a delta.
        if (refreshing || version !== operation.version) state = await this.refreshUnread(chatId);
        request.sent = false;
        if (operation.read !== request || request.messageId <= (state.lastReadMessageId ?? target)) return;
      }
    })().finally(() => {
      if (operation.read === request) operation.read = undefined;
      this.releaseReadOperation(chatId, operation);
    });
    operation.read = request;
    return request.promise;
  }

  markUnread(chatId: SnowflakeID): Promise<void> {
    const operation = this.readOperation(chatId);
    const current = operation.rewind;
    if (current) return current;
    const reading = operation.read;
    operation.read = undefined;
    const action = (async () => {
      // A sent read must settle first; a target still waiting for its timer can be discarded.
      if (reading?.sent) await reading.promise.catch(() => undefined);
      if (this.destroyRef.destroyed) return;
      const version = operation.version;
      const refreshing = !!operation.refresh;
      const state = await firstValueFrom(this.api.markAsUnread(chatId).pipe(takeUntilDestroyed(this.destroyRef)));
      if (this.destroyRef.destroyed) return;
      this.applyReadState(chatId, state);
      this.refreshArchivedChats();
      if (refreshing || version !== operation.version) await this.refreshUnread(chatId);
    })().finally(() => {
      operation.rewind = undefined;
      this.releaseReadOperation(chatId, operation);
    });
    operation.rewind = action;
    return action;
  }

  private syncUnread(chatId: SnowflakeID) {
    void this.refreshUnread(chatId).catch(() => {
      if (!this.destroyRef.destroyed) {
        for (const { state } of this.queries.values()) if (state.consumers.size) state.error.set(ChatListError.Unread);
      }
    });
  }

  private syncUnreadStates() {
    for (const chatId of new Set([...this.readConsumers.values(), ...this.readOperations.keys()]))
      this.syncUnread(chatId);
  }

  private readOperation(chatId: SnowflakeID) {
    let operation = this.readOperations.get(chatId);
    if (!operation) {
      operation = { version: 0 };
      this.readOperations.set(chatId, operation);
    }
    return operation;
  }

  private releaseReadOperation(chatId: SnowflakeID, operation: ChatReadOperation) {
    if (operation.refresh || operation.read || operation.rewind) return;
    if (this.readOperations.get(chatId) === operation) this.readOperations.delete(chatId);
    this.pruneInactiveOverrides();
  }

  private applyReadState(chatId: SnowflakeID, state: MarkChatReadStateResponse) {
    this.readStates.update((states) =>
      new Map(states).set(chatId, { state, version: ++this.updateVersion, dirty: false }),
    );
    this.updateCachedChats(chatId, state);
  }

  private invalidateReads(ids?: ReadonlySet<SnowflakeID>) {
    const version = ++this.updateVersion;
    this.readStates.update((states) => {
      const next = new Map(states);
      for (const id of ids ?? states.keys()) {
        const previous = states.get(id);
        const chat = [...this.queries.values()].flatMap(({ state }) => state.items()).find((chat) => chat.id === id);
        const state =
          previous?.state ??
          (chat ? { lastReadMessageId: chat.lastReadMessageId, unreadCount: chat.unreadCount } : undefined);
        if (state) next.set(id, { state, version, dirty: true });
      }
      return next;
    });
  }

  private updateCachedChats(chatId: SnowflakeID, values: Partial<ChatListItem>) {
    for (const { state } of this.queries.values()) {
      state.items.update((items) => items.map((chat) => (chat.id === chatId ? { ...chat, ...values } : chat)));
    }
  }

  private acceptChats(chats: ChatListItem[], version: number) {
    this.chatInfo.remember(chats);
    const retained = new Set(this.readConsumers.values());
    const canRetire = (updatedAt: number) =>
      updatedAt <= version && ![...this.listRequests].some((request) => request.version < updatedAt);
    this.readStates.update((states) => {
      const next = new Map(states);
      for (const chat of chats) {
        const read = next.get(chat.id);
        if (read && read.version > version) continue;
        const state = { lastReadMessageId: chat.lastReadMessageId, unreadCount: chat.unreadCount };
        this.updateCachedChats(chat.id, state);
        if (retained.has(chat.id) || (read && !canRetire(read.version)))
          next.set(chat.id, { state, version, dirty: false });
        else next.delete(chat.id);
      }
      return next;
    });
    this.previews.update((previews) => {
      const next = new Map(previews);
      for (const chat of chats) {
        const preview = next.get(chat.id);
        if (preview && chat.lastMessage && chat.lastMessage.id >= preview.message.id && canRetire(preview.version)) {
          this.updateCachedChats(chat.id, { lastMessage: chat.lastMessage, lastMessageAt: chat.lastMessageAt });
          next.delete(chat.id);
        }
      }
      return next;
    });
  }

  private pruneInactiveOverrides() {
    if (this.listRequests.size) return;
    const retained = new Set([...this.readConsumers.values(), ...this.readOperations.keys()]);
    this.readStates.update((states) => {
      const next = new Map(states);
      for (const [id, read] of states) {
        if (retained.has(id)) continue;
        if (
          read.dirty &&
          [...this.queries.values()].some(({ state }) => !state.dirty() && state.items().some((chat) => chat.id === id))
        )
          continue;
        // Every query receives the accepted read before its temporary override is released.
        if (!read.dirty) this.updateCachedChats(id, read.state);
        next.delete(id);
      }
      return next;
    });
    const listed = new Set(
      [...this.queries.values()].flatMap(({ state }) =>
        state.consumers.size ? state.items().map((chat) => chat.id) : [],
      ),
    );
    this.previews.update((previews) => {
      const next = new Map(previews);
      for (const [id, { message }] of previews) {
        if (listed.has(id) || retained.has(id)) continue;
        this.updateCachedChats(id, { lastMessage: message, lastMessageAt: message.createdAt });
        next.delete(id);
      }
      return next;
    });
  }

  async setArchived(chatId: SnowflakeID, archived: boolean) {
    await firstValueFrom(
      (archived ? this.api.archiveChat(chatId) : this.api.unarchiveChat(chatId)).pipe(
        takeUntilDestroyed(this.destroyRef),
      ),
    );
    if (this.destroyRef.destroyed) return;
    this.refreshArchivedChats();
    this.applyChatState(chatId, { archived, mutedUntil: archived ? '9999-12-31T23:59:59Z' : undefined });
    this.refreshChats();
  }

  async setMuted(chatId: SnowflakeID, muted: boolean) {
    const state = muted
      ? await firstValueFrom(this.groupsApi.putMute(chatId, {}).pipe(takeUntilDestroyed(this.destroyRef)))
      : await firstValueFrom(this.groupsApi.deleteMute(chatId).pipe(takeUntilDestroyed(this.destroyRef))).then(() => ({
          mutedUntil: undefined,
          archived: false,
        }));
    if (this.destroyRef.destroyed) return;
    this.applyChatState(chatId, state);
    this.refreshArchivedChats();
    this.refreshChats();
  }

  private applyChatState(chatId: SnowflakeID, state: Partial<Pick<ChatListItem, 'archived' | 'mutedUntil'>>) {
    this.updateCachedChats(chatId, state);
  }

  refreshChats() {
    if (this.destroyRef.destroyed) return;
    this.invalidateReads();
    for (const { state } of this.queries.values()) this.invalidateQuery(state);
    this.syncUnreadStates();
  }

  private receiveThreadChange(change: MessageChange) {
    if (change.type === ServerWsMessageType.reactionUpdated) return;
    if (
      change.type === ServerWsMessageType.messageUpdated &&
      !change.payload.replyRootId &&
      !change.payload.threadInfo &&
      ![this.activeThreads, this.archivedThreads].some(({ state }) =>
        state
          .items()
          .some(
            (thread) => thread.threadRootMessage.id === change.payload.id || thread.lastReply?.id === change.payload.id,
          ),
      )
    )
      return;
    const update = (message: MessagePreview): MessagePreview =>
      change.type === ServerWsMessageType.messagesBulkDeleted
        ? change.payload.messageIds.includes(message.id)
          ? { ...message, isDeleted: true, message: undefined, attachments: [], mentions: [], sticker: undefined }
          : message
        : change.payload.id === message.id
          ? { ...change.payload, mentions: change.payload.mentions ?? [] }
          : message;
    for (const { state } of [this.activeThreads, this.archivedThreads])
      state.items.update((threads) =>
        threads.map((thread) =>
          thread.chatId === change.payload.chatId
            ? {
                ...thread,
                threadRootMessage: update(thread.threadRootMessage),
                lastReply: thread.lastReply && update(thread.lastReply),
              }
            : thread,
        ),
      );
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
          state.items().flatMap((thread) => {
            const rootId = thread.threadRootMessage.id;
            const status = this.subscription(thread.chatId, rootId);
            if (status && (!status.subscribed || status.archived !== archived)) return [];
            const read = this.threadReadOverrides().get(rootId)?.state;
            return [{ ...thread, ...(status && { archived: status.archived }), ...read }];
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
        const readSnapshot = { version: ++this.readVersion };
        this.threadListReads.add(readSnapshot);
        const readVersion = readSnapshot.version;
        const subscriptionVersion = ++this.subscriptionVersion;
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
            : await readPages(read, current.items().length, () => version === current.version);
          const page = { threads: result.items, nextCursor: result.cursor };
          if (this.destroyRef.destroyed || current.request !== operation) return;
          if (version === current.version) {
            current.items.update((items) => [
              ...new Map(
                [...(before ? items : []), ...page.threads].map((thread) => [thread.threadRootMessage.id, thread]),
              ).values(),
            ]);
            this.acceptThreadReads(page.threads, readVersion);
            for (const thread of page.threads) {
              const rootId = thread.threadRootMessage.id;
              if ((this.subscriptions().get(rootId)?.version ?? 0) <= subscriptionVersion)
                this.setSubscription(
                  thread.chatId,
                  rootId,
                  { subscribed: true, archived: thread.archived },
                  subscriptionVersion,
                );
            }
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
        } finally {
          this.threadListReads.delete(readSnapshot);
          this.pruneThreadReads();
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

  private updateCachedThreadRead(rootId: SnowflakeID, read: MarkThreadReadResponse) {
    let listed = false;
    for (const { state } of [this.activeThreads, this.archivedThreads]) {
      if (!state.items().some((thread) => thread.threadRootMessage.id === rootId)) continue;
      listed = true;
      state.items.update((items) =>
        items.map((thread) => (thread.threadRootMessage.id === rootId ? { ...thread, ...read } : thread)),
      );
    }
    return listed;
  }

  private acceptThreadReads(threads: ThreadListItem[], version: number) {
    const next = new Map(this.threadReadOverrides());
    for (const thread of threads) {
      const rootId = thread.threadRootMessage.id;
      const previous = next.get(rootId);
      const read =
        previous && previous.version > version
          ? previous
          : {
              state: { lastReadMessageId: thread.lastReadMessageId, unreadCount: thread.unreadCount },
              version,
            };
      this.updateCachedThreadRead(rootId, read.state);
      // Keep a temporary override only while an older request could undo it.
      if ([...this.threadListReads].some((request) => request.version < read.version)) next.set(rootId, read);
      else next.delete(rootId);
    }
    this.threadReadOverrides.set(next);
  }

  private pruneThreadReads() {
    const next = new Map(this.threadReadOverrides());
    for (const [rootId, read] of next) {
      if ([...this.threadListReads].some((request) => request.version < read.version)) continue;
      if (this.updateCachedThreadRead(rootId, read.state)) next.delete(rootId);
    }
    this.threadReadOverrides.set(next);
  }

  threadReadState(
    chatId: SnowflakeID,
    rootId: SnowflakeID,
  ): Pick<MarkThreadReadResponse, 'lastReadMessageId'> | undefined {
    for (const { state } of [this.activeThreads, this.archivedThreads]) {
      if (state.dirty) continue;
      const thread = state.items().find((item) => item.chatId === chatId && item.threadRootMessage.id === rootId);
      if (thread)
        return {
          lastReadMessageId: (this.threadReadOverrides().get(rootId)?.state ?? thread).lastReadMessageId,
        };
    }
    return undefined;
  }

  subscription(chatId: SnowflakeID, rootId: SnowflakeID) {
    const entry = this.subscriptions().get(rootId);
    return entry?.chatId === chatId ? entry.status : undefined;
  }

  private setSubscription(
    chatId: SnowflakeID,
    rootId: SnowflakeID,
    status: ThreadSubscriptionStatusResponse | undefined,
    version = ++this.subscriptionVersion,
  ) {
    this.subscriptions.update((entries) =>
      new Map(entries).set(rootId, {
        chatId,
        status,
        version,
      }),
    );
  }

  private invalidateSubscriptions(rootId?: SnowflakeID) {
    const entries = this.subscriptions();
    const affected = rootId ? [...entries].filter(([id]) => id === rootId) : [...entries];
    for (const [id, entry] of affected) this.setSubscription(entry.chatId, id, undefined);
  }

  loadSubscription(chatId: SnowflakeID, rootId: SnowflakeID): Promise<void> {
    if (this.subscription(chatId, rootId) || this.destroyRef.destroyed) return Promise.resolve();
    const pending = this.subscriptionRequests.get(rootId);
    if (pending) return pending;
    if (!this.subscriptions().has(rootId)) this.setSubscription(chatId, rootId, undefined);
    const request = (async () => {
      while (!this.destroyRef.destroyed) {
        const version = ++this.subscriptionVersion;
        const status = await this.response(this.threadsApi.getSubscriptionStatus(chatId, rootId));
        if (this.destroyRef.destroyed) return;
        if (this.subscriptions().get(rootId)!.version <= version) {
          this.setSubscription(chatId, rootId, status, version);
          return;
        }
        if (this.subscription(chatId, rootId)) return;
      }
    })()
      .catch((error: unknown) => {
        if (!this.destroyRef.destroyed) throw error;
      })
      .finally(() => this.subscriptionRequests.delete(rootId));
    this.subscriptionRequests.set(rootId, request);
    return request;
  }

  private async updateSubscription(
    chatId: SnowflakeID,
    rootId: SnowflakeID,
    change: Partial<ThreadSubscriptionStatusResponse>,
  ) {
    const status = this.subscription(chatId, rootId);
    this.setSubscription(chatId, rootId, status && { ...status, ...change });
    if (!status) await this.loadSubscription(chatId, rootId);
  }

  async setThreadArchived(chatId: SnowflakeID, rootId: SnowflakeID, archived: boolean) {
    await this.response(
      archived ? this.threadsApi.archiveThread(chatId, rootId) : this.threadsApi.unarchiveThread(chatId, rootId),
    );
    if (this.destroyRef.destroyed) return;
    const updated = this.updateSubscription(chatId, rootId, { archived });
    void this.archivedUnread.threads.refresh();
    void this.invalidateThreads();
    await updated;
  }

  async subscribeThread(chatId: SnowflakeID, rootId: SnowflakeID) {
    await this.response(this.threadsApi.subscribeThread(chatId, rootId));
    if (this.destroyRef.destroyed) return;
    const updated = this.updateSubscription(chatId, rootId, { subscribed: true });
    void this.archivedUnread.threads.refresh();
    void this.invalidateThreads();
    await updated;
  }

  markThreadRead(chatId: SnowflakeID, rootId: SnowflakeID, messageId: SnowflakeID): Promise<void> {
    if (this.destroyRef.destroyed) return Promise.resolve();
    const current = this.readRequests.get(rootId);
    if (current) {
      if (messageId > current.messageId) current.messageId = messageId;
      return current.promise;
    }
    const previous =
      this.threadReadOverrides().get(rootId)?.state.lastReadMessageId ??
      [this.activeThreads, this.archivedThreads]
        .flatMap(({ state }) => state.items())
        .find((thread) => thread.threadRootMessage.id === rootId)?.lastReadMessageId;
    if (previous && messageId <= previous) return Promise.resolve();
    const request = { messageId, promise: Promise.resolve() };
    request.promise = (async () => {
      while (!this.destroyRef.destroyed) {
        await this.response(timer(1000));
        if (this.destroyRef.destroyed) return;
        const target = request.messageId;
        const queries = [this.activeThreads, this.archivedThreads].map(({ state }) => ({
          state,
          version: state.version,
          refreshing: !!state.request,
        }));
        const state = await this.response(this.threadsApi.markThreadReadInChat(chatId, rootId, { messageId: target }));
        if (this.destroyRef.destroyed) return;
        void this.archivedUnread.threads.refresh();
        this.threadReadOverrides.update((states) =>
          new Map(states).set(rootId, { state, version: ++this.readVersion }),
        );
        this.pruneThreadReads();
        if (queries.some((query) => query.refreshing || query.version !== query.state.version))
          await this.invalidateThreads();
        if (request.messageId <= (state.lastReadMessageId ?? target)) return;
      }
    })()
      .catch((error: unknown) => {
        if (!this.destroyRef.destroyed) throw error;
      })
      .finally(() => this.readRequests.delete(rootId));
    this.readRequests.set(rootId, request);
    return request.promise;
  }

  private refreshArchivedChats() {
    void this.archivedChatUnread.refresh();
  }

  private refreshArchivedUnread() {
    this.refreshArchivedChats();
    void this.archivedThreadUnread.refresh();
  }
}
