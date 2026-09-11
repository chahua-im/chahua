import { DestroyRef, effect, inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, Subject, takeUntil, timer, type Observable } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { FriendsService } from '../../generated/endpoints/friends/friends.service';
import { GroupsService } from '../../generated/endpoints/groups/groups.service';
import { PinsService } from '../../generated/endpoints/pins/pins.service';
import { ThreadsService } from '../../generated/endpoints/threads/threads.service';
import type { FriendRelationshipResponse } from '../../generated/models';
import {
  ServerWsMessageType,
  type ChatListItem,
  type GroupInfoResponse,
  type MarkChatReadStateResponse,
  type MarkThreadReadResponse,
  type MessagePreview,
  type MessageResponse,
  type ThreadListItem,
  type ThreadSubscriptionStatusResponse,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { activeQuery } from '../api/query';
import type { SnowflakeID } from '../api/snowflake-id';
import { isMessageChange, type MessageChange } from '../messages/message-change';
import { ChatPins } from './chat-pins';

export type ChatInfo = Pick<ChatListItem, 'kind' | 'name' | 'avatar' | 'peer'> &
  Partial<Pick<GroupInfoResponse, 'myRole' | 'description' | 'visibility' | 'mutedUntil'>>;
type ChatSummary = Pick<ChatListItem, 'lastMessage' | 'lastMessageAt' | 'archived' | 'mutedUntil'>;
type ThreadSummary = Omit<ThreadListItem, 'unreadCount' | 'lastReadMessageId' | 'archived'>;
interface ChatReadOperation {
  version: number;
  refresh?: Promise<MarkChatReadStateResponse>;
  read?: { messageId: SnowflakeID; promise: Promise<void>; sent: boolean };
  rewind?: Promise<void>;
}
type Subscription = { chatId: SnowflakeID; status?: ThreadSubscriptionStatusResponse; version: number };
export enum ChatChangeKind {
  Read,
  Membership,
}

@Service()
export class ChatStore {
  private readonly friends = inject(FriendsService);
  private readonly relationships = new Map<
    number,
    ReturnType<typeof activeQuery<FriendRelationshipResponse | undefined>>
  >();
  relationship(uid: number) {
    let query = this.relationships.get(uid);
    if (!query) {
      query = activeQuery<FriendRelationshipResponse | undefined>(
        this.destroyRef,
        (cancel) => firstValueFrom(this.friends.getFriendRelationship(uid).pipe(takeUntil(cancel))),
        undefined,
      );
      this.relationships.set(uid, query);
    }
    return query;
  }

  private readonly api = inject(ChatsService);
  private readonly groupsApi = inject(GroupsService);
  private readonly threadsApi = inject(ThreadsService);
  private readonly pinsApi = inject(PinsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly realtime = inject(Connection);
  private readonly entries = signal(new Map<SnowflakeID, ChatInfo>());
  private readonly fresh = new Set<SnowflakeID>();
  private readonly detailsFresh = new Set<SnowflakeID>();
  private readonly requests = new Map<SnowflakeID, Promise<void>>();
  private revision = 0;
  private version = 0;
  private readonly summaries = signal(
    new Map<SnowflakeID, { value: Partial<ChatSummary>; previewVersion: number; stateVersion: number }>(),
  );
  private readonly readStates = signal(
    new Map<SnowflakeID, { state: MarkChatReadStateResponse; version: number; dirty: boolean }>(),
  );
  private readonly readOperations = new Map<SnowflakeID, ChatReadOperation>();
  private readonly threadSummaries = signal(new Map<SnowflakeID, { value: ThreadSummary; version: number }>());
  private readonly threadReads = signal(
    new Map<SnowflakeID, { state: MarkThreadReadResponse; version: number; dirty: boolean }>(),
  );
  private readonly subscriptions = signal(new Map<SnowflakeID, Subscription>());
  private subscriptionVersion = 0;
  private readonly subscriptionRequests = new Map<SnowflakeID, Promise<void>>();
  private readonly readRequests = new Map<SnowflakeID, { messageId: SnowflakeID; promise: Promise<void> }>();
  private readonly pinScopes = new Map<SnowflakeID, ChatPins>();
  private readonly changes = new Subject<{
    kind: ChatChangeKind;
    chatId: SnowflakeID;
    threadId?: SnowflakeID;
    readThrough?: SnowflakeID;
  }>();
  readonly changes$ = this.changes.asObservable();

  private readonly muteTime = signal(Date.now());

  mutedUntil(chatId: SnowflakeID) {
    return (this.chatState(chatId) ?? this.get(chatId))?.mutedUntil;
  }

  isMuted(chatId: SnowflakeID) {
    this.muteTime();
    return Date.parse(this.mutedUntil(chatId) ?? '') > Date.now();
  }

  constructor() {
    effect((onCleanup) => {
      this.muteTime();
      const now = Date.now();
      const ids = new Set([...this.entries().keys(), ...this.summaries().keys()]);
      const expirations = [...ids]
        .map((id) => ({ id, until: Date.parse(this.mutedUntil(id) ?? '') }))
        .filter(({ until }) => until > now && until - now <= 7 * 86400_000);
      if (!expirations.length) return;
      const timer = setTimeout(
        () => {
          const current = Date.now();
          this.muteTime.set(current);
          for (const { id, until } of expirations) if (until <= current) this.changed(ChatChangeKind.Read, id);
        },
        Math.max(0, Math.min(...expirations.map(({ until }) => until)) - Date.now()),
      );
      onCleanup(() => clearTimeout(timer));
    });
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.muteTime.set(Date.now());
      for (const query of this.relationships.values()) void query.refresh();
      this.invalidate();
      this.invalidateReads();
      this.invalidateThreadReads();
      this.invalidateSubscriptions();
      for (const pins of this.pinScopes.values()) pins.invalidate();
    });
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (isMessageChange(event)) {
        this.receiveChange(event);
        for (const pins of this.pinScopes.values()) pins.receiveChange(event);
      }
      switch (event.type) {
        case ServerWsMessageType.friendshipRemoved:
          void this.relationships.get(event.payload.actorUid)?.refresh();
          break;
        case ServerWsMessageType.friendRequestResolved:
          void this.relationships.get(event.payload.byUid)?.refresh();
          break;
        case ServerWsMessageType.message:
          if (event.payload.replyRootId) this.invalidateSubscriptions(event.payload.replyRootId);
          else this.receiveMessage(event.payload);
          break;
        case ServerWsMessageType.threadMembershipChanged:
          this.invalidateSubscriptions(event.payload.threadRootId);
          break;
        case ServerWsMessageType.chatArchiveStateChanged:
          this.applyChatState(event.payload.chatId, event.payload);
          break;
        case ServerWsMessageType.pinAdded:
        case ServerWsMessageType.pinRemoved:
        case ServerWsMessageType.threadPinAdded:
        case ServerWsMessageType.threadPinRemoved: {
          const { chatId, threadRootId, pinId, pin } = event.payload;
          const pins = this.pinScopes.get(threadRootId ?? chatId);
          if (pins?.chatId === chatId) pins.apply(pinId, pin);
          break;
        }
      }
    });
  }

  snapshot() {
    return ++this.version;
  }

  pins(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const key = threadId ?? chatId;
    let pins = this.pinScopes.get(key);
    if (!pins) {
      pins = new ChatPins(chatId, threadId, this.pinsApi, this.realtime, this.destroyRef);
      this.pinScopes.set(key, pins);
    }
    return pins;
  }
  get(id: SnowflakeID): ChatInfo | undefined {
    return this.entries().get(id);
  }
  remember(chats: readonly (ChatInfo & { id: SnowflakeID })[]) {
    if (!chats.length) return;
    this.entries.update((entries) => {
      const next = new Map(entries);
      for (const { id, kind, name, avatar, peer } of chats) {
        next.set(id, { ...entries.get(id), kind, name, avatar, peer });
        this.fresh.add(id);
      }
      return next;
    });
  }
  invalidate() {
    this.revision++;
    this.fresh.clear();
    this.detailsFresh.clear();
  }
  ensure(id: SnowflakeID): Promise<void> {
    if (this.fresh.has(id)) return Promise.resolve();
    return this.ensureDetails(id);
  }
  ensureDetails(id: SnowflakeID): Promise<void> {
    if (this.detailsFresh.has(id)) return Promise.resolve();
    const pending = this.requests.get(id);
    if (pending) return pending;
    const request = (async () => {
      while (!this.destroyRef.destroyed && !this.detailsFresh.has(id)) {
        const revision = this.revision;
        const cached = this.entries().get(id);
        const chat = await firstValueFrom(this.groupsApi.getGroup(id).pipe(takeUntilDestroyed(this.destroyRef)));
        if (revision !== this.revision) continue;
        if (this.entries().get(id) === cached) this.remember([chat]);
        const { myRole, description, visibility, mutedUntil } = chat;
        this.entries.update((entries) =>
          new Map(entries).set(id, { ...entries.get(id)!, myRole, description, visibility, mutedUntil }),
        );
        this.detailsFresh.add(id);
      }
    })().finally(() => this.requests.delete(id));
    this.requests.set(id, request);
    return request;
  }

  chatState(id: SnowflakeID) {
    const summary = this.summaries().get(id);
    return summary?.stateVersion ? summary.value : undefined;
  }

  chat(id: SnowflakeID): ChatListItem {
    // Query membership only contains IDs accepted from a complete list response.
    return {
      id,
      ...this.entries().get(id)!,
      ...this.summaries().get(id)!.value,
      ...this.readStates().get(id)!.state,
    } as ChatListItem;
  }

  acceptChats(chats: readonly ChatListItem[], version: number) {
    this.remember(chats);
    const summaries = new Map(this.summaries());
    const reads = new Map(this.readStates());
    for (const chat of chats) {
      const current = summaries.get(chat.id);
      summaries.set(chat.id, {
        value: {
          ...(current?.value ?? {}),
          ...(!current || current.previewVersion <= version
            ? { lastMessage: chat.lastMessage, lastMessageAt: chat.lastMessageAt }
            : {}),
          ...(!current || current.stateVersion <= version
            ? { archived: chat.archived, mutedUntil: chat.mutedUntil }
            : {}),
        },
        previewVersion: Math.max(current?.previewVersion ?? 0, version),
        stateVersion: Math.max(current?.stateVersion ?? 0, version),
      });
      if ((reads.get(chat.id)?.version ?? 0) <= version)
        reads.set(chat.id, {
          state: { lastReadMessageId: chat.lastReadMessageId, unreadCount: chat.unreadCount },
          version,
          dirty: false,
        });
    }
    this.summaries.set(summaries);
    this.readStates.set(reads);
  }

  private receiveMessage(message: MessageResponse) {
    const previous = this.summaries().get(message.chatId)?.value.lastMessage;
    if (previous?.id === message.id) return;
    this.invalidateReads(new Set([message.chatId]));
    if (previous && previous.id > message.id) return;
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
    this.updatePreview(message.chatId, preview);
  }

  private updatePreview(chatId: SnowflakeID, preview: MessagePreview) {
    const current = this.summaries().get(chatId);
    this.summaries.update((items) =>
      new Map(items).set(chatId, {
        value: { ...current?.value, lastMessage: preview, lastMessageAt: preview.createdAt },
        previewVersion: ++this.version,
        stateVersion: current?.stateVersion ?? 0,
      }),
    );
  }

  private receiveChange(change: MessageChange) {
    if (change.type === ServerWsMessageType.reactionUpdated) return;
    const update = (message: MessageResponse | MessagePreview) =>
      change.type === ServerWsMessageType.messagesBulkDeleted
        ? change.payload.messageIds.includes(message.id)
          ? { ...message, isDeleted: true, message: undefined, attachments: [], mentions: [], sticker: undefined }
          : message
        : message.id === change.payload.id
          ? { ...change.payload, mentions: change.payload.mentions ?? [] }
          : message;
    const latest = this.summaries().get(change.payload.chatId)?.value.lastMessage;
    if (latest && (change.type === ServerWsMessageType.messagesBulkDeleted || !change.payload.replyRootId)) {
      const next = update(latest);
      if (next !== latest) this.updatePreview(change.payload.chatId, { ...next, mentions: next.mentions ?? [] });
    }
    this.threadSummaries.update(
      (entries) =>
        new Map(
          [...entries].map(([id, entry]) => {
            if (entry.value.chatId !== change.payload.chatId) return [id, entry];
            const root = update(entry.value.threadRootMessage) as MessagePreview;
            const last = entry.value.lastReply && (update(entry.value.lastReply) as MessagePreview);
            return root === entry.value.threadRootMessage && last === entry.value.lastReply
              ? [id, entry]
              : [id, { value: { ...entry.value, threadRootMessage: root, lastReply: last }, version: ++this.version }];
          }),
        ),
    );
  }

  cachedReadState(chatId: SnowflakeID) {
    const read = this.readStates().get(chatId);
    return read && !read.dirty ? read.state : undefined;
  }

  unreadCount(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const read = threadId ? this.threadReads().get(threadId) : this.readStates().get(chatId);
    return read?.state.unreadCount ?? 0;
  }

  invalidateReads(ids?: ReadonlySet<SnowflakeID>) {
    const version = ++this.version;
    this.readStates.update(
      (states) =>
        new Map(
          [...states].map(([id, read]) => (!ids || ids.has(id) ? [id, { ...read, dirty: true, version }] : [id, read])),
        ),
    );
    for (const [id, operation] of this.readOperations) if (!ids || ids.has(id)) operation.version++;
  }

  private applyReadState(chatId: SnowflakeID, state: MarkChatReadStateResponse) {
    this.readStates.update((states) => new Map(states).set(chatId, { state, version: ++this.version, dirty: false }));
  }

  private applyChatState(chatId: SnowflakeID, state: Partial<Pick<ChatListItem, 'archived' | 'mutedUntil'>>) {
    const current = this.summaries().get(chatId);
    this.summaries.update((items) =>
      new Map(items).set(chatId, {
        value: { ...current?.value, archived: state.archived ?? current?.value.archived, mutedUntil: state.mutedUntil },
        previewVersion: current?.previewVersion ?? 0,
        stateVersion: ++this.version,
      }),
    );
  }

  private changed(kind: ChatChangeKind, chatId: SnowflakeID, threadId?: SnowflakeID, readThrough?: SnowflakeID) {
    this.changes.next({ kind, chatId, threadId, readThrough });
  }
  getReadState(chatId: SnowflakeID): Promise<MarkChatReadStateResponse> {
    return this.readOperation(chatId).refresh ?? this.refreshUnread(chatId);
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
    const lastRead = this.readStates().get(chatId)?.state.lastReadMessageId;
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
        this.changed(ChatChangeKind.Read, chatId, undefined, state.lastReadMessageId ?? target);
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
      this.changed(ChatChangeKind.Read, chatId);
      if (refreshing || version !== operation.version) await this.refreshUnread(chatId);
    })().finally(() => {
      operation.rewind = undefined;
      this.releaseReadOperation(chatId, operation);
    });
    operation.rewind = action;
    return action;
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
  }
  async setArchived(chatId: SnowflakeID, archived: boolean) {
    await firstValueFrom(
      (archived ? this.api.archiveChat(chatId) : this.api.unarchiveChat(chatId)).pipe(
        takeUntilDestroyed(this.destroyRef),
      ),
    );
    if (this.destroyRef.destroyed) return;
    this.changed(ChatChangeKind.Read, chatId);
    this.applyChatState(chatId, { archived, mutedUntil: archived ? '9999-12-31T23:59:59Z' : undefined });
    this.changed(ChatChangeKind.Membership, chatId);
  }
  async setMuted(chatId: SnowflakeID, muted: boolean, durationSeconds?: number) {
    const state = muted
      ? await firstValueFrom(
          this.groupsApi
            .putMute(chatId, durationSeconds ? { durationSeconds } : {})
            .pipe(takeUntilDestroyed(this.destroyRef)),
        )
      : await firstValueFrom(this.groupsApi.deleteMute(chatId).pipe(takeUntilDestroyed(this.destroyRef))).then(() => ({
          mutedUntil: undefined,
          archived: false,
        }));
    if (this.destroyRef.destroyed) return;
    this.applyChatState(chatId, state);
    this.changed(ChatChangeKind.Read, chatId);
    this.changed(ChatChangeKind.Membership, chatId);
  }

  thread(rootId: SnowflakeID): ThreadListItem | undefined {
    const summary = this.threadSummaries().get(rootId)?.value;
    if (!summary) return undefined;
    const status = this.subscriptions().get(rootId)?.status;
    if (status && !status.subscribed) return undefined;
    return { ...summary, archived: status?.archived ?? false, ...this.threadReads().get(rootId)!.state };
  }

  acceptThreads(threads: readonly ThreadListItem[], version: number, subscriptionVersion: number) {
    const summaries = new Map(this.threadSummaries());
    const reads = new Map(this.threadReads());
    for (const thread of threads) {
      const { archived, unreadCount, lastReadMessageId, ...summary } = thread;
      const rootId = summary.threadRootMessage.id;
      if ((summaries.get(rootId)?.version ?? 0) <= version) summaries.set(rootId, { value: summary, version });
      if ((reads.get(rootId)?.version ?? 0) <= version)
        reads.set(rootId, { state: { lastReadMessageId, unreadCount }, version, dirty: false });
      if ((this.subscriptions().get(rootId)?.version ?? 0) <= subscriptionVersion)
        this.setSubscription(thread.chatId, rootId, { subscribed: true, archived }, subscriptionVersion);
    }
    this.threadSummaries.set(summaries);
    this.threadReads.set(reads);
  }

  invalidateThreadReads(rootIds?: readonly SnowflakeID[]) {
    const version = ++this.version;
    this.threadReads.update(
      (reads) =>
        new Map(
          [...reads].map(([id, read]) =>
            !rootIds || rootIds.includes(id) ? [id, { ...read, dirty: true, version }] : [id, read],
          ),
        ),
    );
  }

  threadReadState(chatId: SnowflakeID, rootId: SnowflakeID) {
    const read = this.threadReads().get(rootId);
    return this.threadSummaries().get(rootId)?.value.chatId === chatId && read && !read.dirty
      ? { lastReadMessageId: read.state.lastReadMessageId }
      : undefined;
  }

  subscriptionSnapshot() {
    return ++this.subscriptionVersion;
  }
  private readonly staleSubscriptions = new Set<SnowflakeID>();
  subscription(chatId: SnowflakeID, rootId: SnowflakeID) {
    const status = this.cachedSubscription(chatId, rootId);
    return this.staleSubscriptions.has(rootId) ? undefined : status;
  }
  cachedSubscription(chatId: SnowflakeID, rootId: SnowflakeID) {
    const entry = this.subscriptions().get(rootId);
    return entry?.chatId === chatId ? entry.status : undefined;
  }
  private setSubscription(
    chatId: SnowflakeID,
    rootId: SnowflakeID,
    status: ThreadSubscriptionStatusResponse | undefined,
    version = ++this.subscriptionVersion,
  ) {
    if (status) this.staleSubscriptions.delete(rootId);
    else this.staleSubscriptions.add(rootId);
    this.subscriptions.update((entries) =>
      new Map(entries).set(rootId, {
        chatId,
        status: status ?? entries.get(rootId)?.status,
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
    this.changed(ChatChangeKind.Membership, chatId, rootId);
    await updated;
  }
  async subscribeThread(chatId: SnowflakeID, rootId: SnowflakeID) {
    await this.response(this.threadsApi.subscribeThread(chatId, rootId));
    if (this.destroyRef.destroyed) return;
    const updated = this.updateSubscription(chatId, rootId, { subscribed: true });
    this.changed(ChatChangeKind.Membership, chatId, rootId);
    await updated;
  }
  async unsubscribeThread(chatId: SnowflakeID, rootId: SnowflakeID) {
    await this.response(this.threadsApi.unsubscribeThread(chatId, rootId));
    if (this.destroyRef.destroyed) return;
    await this.updateSubscription(chatId, rootId, { subscribed: false });
    this.changed(ChatChangeKind.Membership, chatId, rootId);
  }
  markThreadRead(chatId: SnowflakeID, rootId: SnowflakeID, messageId: SnowflakeID): Promise<void> {
    if (this.destroyRef.destroyed) return Promise.resolve();
    const current = this.readRequests.get(rootId);
    if (current) {
      if (messageId > current.messageId) current.messageId = messageId;
      return current.promise;
    }
    const previous = this.threadReads().get(rootId)?.state.lastReadMessageId;
    if (previous && messageId <= previous) return Promise.resolve();
    const request = { messageId, promise: Promise.resolve() };
    request.promise = (async () => {
      while (!this.destroyRef.destroyed) {
        await this.response(timer(1000));
        if (this.destroyRef.destroyed) return;
        const target = request.messageId;
        const version = this.snapshot();
        let state = await this.response(this.threadsApi.markThreadReadInChat(chatId, rootId, { messageId: target }));
        const current = this.threadReads().get(rootId);
        if (current && current.version > version) {
          state =
            !current.dirty && (current.state.lastReadMessageId ?? rootId) >= (state.lastReadMessageId ?? rootId)
              ? current.state
              : await this.response(this.threadsApi.getThreadReadStateInChat(chatId, rootId));
        }
        if (this.destroyRef.destroyed) return;
        this.changed(ChatChangeKind.Read, chatId, rootId, state.lastReadMessageId ?? target);
        this.threadReads.update((states) =>
          new Map(states).set(rootId, { state, version: ++this.version, dirty: false }),
        );
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
  private response<T>(source: Observable<T>) {
    return firstValueFrom(source.pipe(takeUntilDestroyed(this.destroyRef)));
  }
}
