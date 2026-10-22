import { computed, DestroyRef, effect, inject, Service, signal } from '@angular/core';
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
  GroupKind,
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
import { SessionStore } from '../session/session-store';
import { conversationStates } from './conversation-states';
import type { ConversationRef, ConversationState } from '../../generated/models';
import { activeQuery } from '../api/query';
import type { SnowflakeID } from '../api/snowflake-id';
import { isMessageChange, type MessageChange } from '../messages/message-change';
import { ChatPins } from './chat-pins';

export type ChatInfo = Pick<ChatListItem, 'kind' | 'name' | 'avatar' | 'peer'> &
  Partial<Pick<GroupInfoResponse, 'myRole' | 'description' | 'visibility' | 'mutedUntil'>>;
type ChatSummary = Pick<ChatListItem, 'lastMessage' | 'lastMessageAt' | 'archived' | 'mutedUntil'>;
type ChatState = Partial<Pick<ChatListItem, 'archived' | 'mutedUntil'>>;
const PERMANENT_MUTE = '9999-12-31T23:59:59Z';
type ThreadSummary = Omit<
  ThreadListItem,
  'unreadCount' | 'unreadMentions' | 'unreadReactions' | 'lastReadMessageId' | 'archived'
>;
interface ChatReadOperation {
  version: number;
  refresh?: Promise<MarkChatReadStateResponse>;
  read?: { messageId: SnowflakeID; promise: Promise<void>; sent: boolean };
  rewind?: Promise<void>;
}
type Subscription = { chatId: SnowflakeID; status?: ThreadSubscriptionStatusResponse; version: number; dirty: boolean };
export enum ChatChangeKind {
  Read,
  Membership,
  Attention,
  Removed,
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
  private readonly session = inject(SessionStore);
  private readonly mentionAccount = computed(() => this.session.user()?.uid);
  private readonly knownMentions = new Map<SnowflakeID, { mentioned: boolean; version: number }>();
  private readonly scheduledReads = new Map<SnowflakeID, Promise<MarkChatReadStateResponse>>();
  private readonly threadReadRefreshes = new Map<SnowflakeID, Promise<MarkThreadReadResponse>>();
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
  private readonly stateWatch = conversationStates(this.realtime, this.session, this.destroyRef, (states) =>
    this.acceptReadStates(states),
  );
  watchReadStates(scopes: readonly ConversationRef[]) {
    return this.stateWatch.watch(scopes);
  }
  private acceptReadStates(states: ConversationState[]) {
    for (const state of states) {
      const { chatId, threadId, accessible } = state;
      // HTTP mutations establish their own cursor. Replace the watch after their
      // response, so a snapshot started before the mutation cannot undo it.
      if (
        threadId
          ? this.readRequests.has(threadId)
          : this.readOperations.get(chatId)?.read || this.readOperations.get(chatId)?.rewind
      )
        continue;
      if (threadId)
        this.threadReads.update((reads) =>
          new Map(reads).set(threadId, { state, version: ++this.version, dirty: false }),
        );
      else {
        const operation = this.readOperations.get(chatId);
        if (operation) operation.version++;
        this.applyReadState(chatId, state);
      }
      if (!accessible) this.changed(ChatChangeKind.Removed, chatId, threadId);
    }
  }

  private readonly receiptPrivacyChanges = new Subject<number | undefined>();
  readonly receiptPrivacyChanges$ = this.receiptPrivacyChanges.asObservable();

  invalidateReadReceiptPrivacy(peerUid?: number) {
    this.receiptPrivacyChanges.next(peerUid);
  }

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
    effect(() => {
      this.mentionAccount();
      this.knownMentions.clear();
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
      if (event.type === ServerWsMessageType.messageUpdated) {
        const message = event.payload;
        const previous = this.knownMentions.get(message.id)?.mentioned;
        const next = message.mentions?.some((mention) => mention.uid === this.session.user()?.uid) ?? false;
        this.rememberMentions([message]);
        if (
          (previous == null
            ? next || this.cachedUnreadMentions(message.chatId, message.replyRootId) !== 0
            : previous !== next) &&
          this.get(message.chatId)?.kind !== GroupKind.dm
        ) {
          if (message.replyRootId) this.invalidateThreadReads([message.replyRootId]);
          else this.invalidateReads(new Set([message.chatId]));
          this.changed(ChatChangeKind.Attention, message.chatId, message.replyRootId);
        }
      }
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
          this.rememberMentions([event.payload]);
          if (event.payload.replyRootId) {
            this.receiveThreadMessage(event.payload, event.payload.replyRootId);
          } else this.receiveMessage(event.payload);
          break;
        case ServerWsMessageType.threadUpdate: {
          const { threadRootId, replyCount, lastReplyAt } = event.payload;
          const current = this.threadSummaries().get(threadRootId);
          if (current)
            this.threadSummaries.update((entries) =>
              new Map(entries).set(threadRootId, {
                value: { ...current.value, replyCount, lastReplyAt },
                version: ++this.version,
              }),
            );
          break;
        }
        case ServerWsMessageType.threadMembershipChanged:
          if (event.payload.status)
            this.setSubscription(event.payload.chatId, event.payload.threadRootId, event.payload.status);
          else this.invalidateSubscriptions(event.payload.threadRootId);
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
    this.rememberMentions(
      chats.flatMap((chat) => (chat.lastMessage ? [chat.lastMessage] : [])),
      version,
    );
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
          state: {
            lastReadMessageId: chat.lastReadMessageId,
            unreadCount: chat.unreadCount,
            unreadMentions: chat.unreadMentions ?? 0,
            unreadReactions: chat.unreadReactions ?? 0,
          },
          version,
          dirty: false,
        });
    }
    this.summaries.set(summaries);
    this.readStates.set(reads);
  }

  private receiveMessage(message: MessageResponse) {
    const previous = this.summaries().get(message.chatId)?.value.lastMessage;
    if (previous?.id === message.id) {
      const lastRead = this.readStates().get(message.chatId)?.state.lastReadMessageId;
      if (
        !previous.isDeleted &&
        message.sender.uid === this.session.user()?.uid &&
        (!lastRead || lastRead < message.id)
      )
        this.invalidateReads(new Set([message.chatId]));
      return;
    }
    this.invalidateReads(new Set([message.chatId]));
    if (previous && previous.id > message.id) return;
    const preview = messagePreview(message);
    this.updatePreview(message.chatId, preview);
  }

  private receiveThreadMessage(message: MessageResponse, rootId: SnowflakeID) {
    const current = this.threadSummaries().get(rootId);
    // Membership and unknown threads still come from the list query.
    if (!current || (current.value.lastReply && current.value.lastReply.id >= message.id)) return;
    this.threadSummaries.update((summaries) =>
      new Map(summaries).set(rootId, {
        value: {
          ...current.value,
          lastReply: messagePreview(message),
          lastReplyAt: message.createdAt,
          replyCount: Math.max(1, current.value.replyCount),
        },
        version: ++this.version,
      }),
    );
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

  /** A loaded, contiguous latest range can resolve a recall without another list read. */
  restoreChatPreview(chatId: SnowflakeID, deletedIds: ReadonlySet<SnowflakeID>, previous?: MessageResponse) {
    const current = this.summaries().get(chatId);
    if (!current?.value.lastMessage || !deletedIds.has(current.value.lastMessage.id)) return;
    this.summaries.update((summaries) =>
      new Map(summaries).set(chatId, {
        ...current,
        value: {
          ...current.value,
          lastMessage: previous && messagePreview(previous),
          lastMessageAt: previous?.createdAt,
        },
        previewVersion: ++this.version,
      }),
    );
  }

  restoreThreadPreview(
    chatId: SnowflakeID,
    rootId: SnowflakeID,
    deletedIds: ReadonlySet<SnowflakeID>,
    previous?: MessageResponse,
  ) {
    const current = this.threadSummaries().get(rootId);
    if (current?.value.chatId !== chatId || !current.value.lastReply || !deletedIds.has(current.value.lastReply.id))
      return;
    this.threadSummaries.update((summaries) =>
      new Map(summaries).set(rootId, {
        value: {
          ...current.value,
          lastReply: previous && messagePreview(previous),
          lastReplyAt: previous?.createdAt ?? current.value.subscribedAt,
          // Only a complete range can prove there are no remaining replies.
          replyCount: previous ? current.value.replyCount : 0,
        },
        version: ++this.version,
      }),
    );
    return true;
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

  rememberMentions(messages: readonly Pick<MessageResponse, 'id' | 'mentions'>[], version = ++this.version) {
    for (const message of messages) {
      if ((this.knownMentions.get(message.id)?.version ?? 0) > version) continue;
      this.knownMentions.delete(message.id);
      this.knownMentions.set(message.id, {
        mentioned: message.mentions?.some((mention) => mention.uid === this.session.user()?.uid) ?? false,
        version,
      });
      if (this.knownMentions.size > 256) this.knownMentions.delete(this.knownMentions.keys().next().value!);
    }
  }

  scheduleReadState(chatId: SnowflakeID): Promise<MarkChatReadStateResponse> {
    const cached = this.readStates().get(chatId);
    if (cached && this.stateWatch.ready({ chatId })) return Promise.resolve(cached.state);
    const pending = this.scheduledReads.get(chatId);
    if (pending) return pending;
    const request = this.response(timer(100))
      .then(() => this.getReadState(chatId))
      .finally(() => this.scheduledReads.delete(chatId));
    this.scheduledReads.set(chatId, request);
    return request;
  }

  cachedReadState(chatId: SnowflakeID) {
    const read = this.readStates().get(chatId);
    return read && !read.dirty ? read.state : undefined;
  }

  unreadCount(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const read = threadId ? this.threadReads().get(threadId) : this.readStates().get(chatId);
    return read?.state.unreadCount ?? 0;
  }

  unreadReactions(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const read = threadId ? this.threadReads().get(threadId) : this.readStates().get(chatId);
    return read?.state.unreadReactions ?? 0;
  }

  cachedUnreadReactions(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const read = threadId ? this.threadReads().get(threadId) : this.readStates().get(chatId);
    return read && !read.dirty ? read.state.unreadReactions : undefined;
  }

  cachedUnreadMentions(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const read = threadId ? this.threadReads().get(threadId) : this.readStates().get(chatId);
    return read && !read.dirty ? read.state.unreadMentions : undefined;
  }

  unreadMentions(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const read = threadId ? this.threadReads().get(threadId) : this.readStates().get(chatId);
    return read?.state.unreadMentions ?? 0;
  }

  /** Apply a chat-level reaction acknowledge response (count for the scope). */
  applyReactionRead(chatId: SnowflakeID, threadId: SnowflakeID | undefined, unreadReactions: number) {
    if (this.stateWatch.selected({ chatId, threadId })) this.stateWatch.refresh();
    const version = ++this.version;
    if (threadId) {
      const current = this.threadReads().get(threadId);
      if (!current) return;
      this.threadReads.update((reads) =>
        new Map(reads).set(threadId, {
          ...current,
          state: { ...current.state, unreadReactions },
          version,
        }),
      );
      return;
    }
    // Invalidate any in-flight read response so it cannot restore the old count.
    const operation = this.readOperation(chatId);
    operation.version++;
    this.releaseReadOperation(chatId, operation);
    const current = this.readStates().get(chatId);
    if (!current) return;
    this.readStates.update((states) =>
      new Map(states).set(chatId, {
        ...current,
        state: { ...current.state, unreadReactions },
        version,
      }),
    );
  }

  /**
   * Last read message before the current unread messages; undefined when nothing is unread.
   * Shares its source and dirty tolerance with unreadCount so navigation can use it mid-refresh.
   */
  unreadBoundary(chatId: SnowflakeID, threadId?: SnowflakeID) {
    const read = threadId ? this.threadReads().get(threadId) : this.readStates().get(chatId);
    return read?.state.unreadCount ? read.state.lastReadMessageId : undefined;
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

  private applyChatState(chatId: SnowflakeID, state: ChatState) {
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
    const current = this.readOperations.get(chatId)?.refresh;
    if (current) return current;
    const cached = this.cachedReadState(chatId);
    return cached ? Promise.resolve(cached) : this.refreshUnread(chatId);
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
        if (version !== operation.version) {
          const live = this.readStates().get(chatId);
          if (live && this.stateWatch.ready({ chatId })) return live.state;
          continue;
        }
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
        if (this.stateWatch.selected({ chatId })) this.stateWatch.refresh();
        else if (refreshing || version !== operation.version) state = await this.refreshUnread(chatId);
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
      if (this.stateWatch.selected({ chatId })) this.stateWatch.refresh();
      else if (refreshing || version !== operation.version) await this.refreshUnread(chatId);
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
  setArchived(chatId: SnowflakeID, archived: boolean) {
    return this.changeChatState(
      chatId,
      { archived, mutedUntil: archived ? PERMANENT_MUTE : undefined },
      archived ? this.api.archiveChat(chatId) : this.api.unarchiveChat(chatId),
    );
  }
  setMuted(chatId: SnowflakeID, muted: boolean, durationSeconds?: number) {
    const state = muted
      ? { mutedUntil: durationSeconds ? new Date(Date.now() + durationSeconds * 1000).toISOString() : PERMANENT_MUTE }
      : { mutedUntil: undefined, archived: false };
    return this.changeChatState(
      chatId,
      state,
      muted
        ? this.groupsApi.putMute(chatId, durationSeconds ? { durationSeconds } : {})
        : this.groupsApi.deleteMute(chatId),
    );
  }
  private async changeChatState(chatId: SnowflakeID, state: ChatState, request: Observable<ChatState | void>) {
    const previous = this.chatState(chatId) ?? { archived: false, mutedUntil: this.mutedUntil(chatId) };
    this.applyChatState(chatId, state);
    const version = this.summaries().get(chatId)!.stateVersion;
    try {
      const confirmed = await this.response(request);
      if (this.destroyRef.destroyed) return;
      if (confirmed && this.summaries().get(chatId)?.stateVersion === version)
        this.applyChatState(chatId, { ...state, ...confirmed });
      this.changed(ChatChangeKind.Read, chatId);
      this.changed(ChatChangeKind.Membership, chatId);
    } catch (error) {
      // A failed older request must not undo a newer choice or server update.
      if (!this.destroyRef.destroyed && this.summaries().get(chatId)?.stateVersion === version)
        this.applyChatState(chatId, previous);
      throw error;
    }
  }

  thread(rootId: SnowflakeID): ThreadListItem | undefined {
    const summary = this.threadSummaries().get(rootId)?.value;
    if (!summary || summary.replyCount === 0) return undefined;
    const status = this.subscriptions().get(rootId)?.status;
    if (status && !status.subscribed) return undefined;
    return { ...summary, archived: status?.archived ?? false, ...this.threadReads().get(rootId)!.state };
  }

  acceptThreads(threads: readonly ThreadListItem[], version: number, subscriptionVersion: number) {
    this.rememberMentions(
      threads.flatMap((thread) => [thread.threadRootMessage, ...(thread.lastReply ? [thread.lastReply] : [])]),
      version,
    );
    const summaries = new Map(this.threadSummaries());
    const reads = new Map(this.threadReads());
    for (const thread of threads) {
      const { archived, unreadCount, unreadMentions, unreadReactions, lastReadMessageId, ...summary } = thread;
      const rootId = summary.threadRootMessage.id;
      if ((summaries.get(rootId)?.version ?? 0) <= version) summaries.set(rootId, { value: summary, version });
      if ((reads.get(rootId)?.version ?? 0) <= version)
        reads.set(rootId, {
          state: {
            lastReadMessageId,
            unreadCount,
            unreadMentions: unreadMentions ?? 0,
            unreadReactions: unreadReactions ?? 0,
          },
          version,
          dirty: false,
        });
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

  getThreadReadState(chatId: SnowflakeID, rootId: SnowflakeID): Promise<MarkThreadReadResponse> {
    const pending = this.threadReadRefreshes.get(rootId);
    if (pending) return pending;
    const cached = this.threadReads().get(rootId);
    if (cached && (!cached.dirty || this.stateWatch.ready({ chatId, threadId: rootId })))
      return Promise.resolve(cached.state);
    const request = (async () => {
      while (true) {
        await this.response(timer(100));
        const version = this.version;
        const state = await this.response(this.threadsApi.getThreadReadStateInChat(chatId, rootId));
        const current = this.threadReads().get(rootId);
        if (current && current.version > version) {
          if (!current.dirty) return current.state;
          continue;
        }
        this.threadReads.update((states) =>
          new Map(states).set(rootId, { state, version: ++this.version, dirty: false }),
        );
        return state;
      }
    })().finally(() => this.threadReadRefreshes.delete(rootId));
    this.threadReadRefreshes.set(rootId, request);
    return request;
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
  subscription(chatId: SnowflakeID, rootId: SnowflakeID) {
    const entry = this.subscriptions().get(rootId);
    return entry?.chatId === chatId && !entry.dirty ? entry.status : undefined;
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
    this.subscriptions.update((entries) =>
      new Map(entries).set(rootId, {
        chatId,
        status: status ?? entries.get(rootId)?.status,
        dirty: !status,
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
    request: Observable<void>,
  ) {
    const previous = this.cachedSubscription(chatId, rootId);
    if (previous) this.setSubscription(chatId, rootId, { ...previous, ...change });
    const version = this.subscriptions().get(rootId)?.version;
    try {
      await this.response(request);
      if (this.destroyRef.destroyed) return;
      this.changed(ChatChangeKind.Membership, chatId, rootId);
      if (!previous) {
        this.setSubscription(chatId, rootId, undefined);
        await this.loadSubscription(chatId, rootId);
      }
    } catch (error) {
      if (!this.destroyRef.destroyed && previous && this.subscriptions().get(rootId)?.version === version)
        this.setSubscription(chatId, rootId, previous);
      throw error;
    }
  }
  setThreadArchived(chatId: SnowflakeID, rootId: SnowflakeID, archived: boolean) {
    return this.updateSubscription(
      chatId,
      rootId,
      { archived },
      archived ? this.threadsApi.archiveThread(chatId, rootId) : this.threadsApi.unarchiveThread(chatId, rootId),
    );
  }
  subscribeThread(chatId: SnowflakeID, rootId: SnowflakeID) {
    return this.updateSubscription(
      chatId,
      rootId,
      { subscribed: true },
      this.threadsApi.subscribeThread(chatId, rootId),
    );
  }
  unsubscribeThread(chatId: SnowflakeID, rootId: SnowflakeID) {
    return this.updateSubscription(
      chatId,
      rootId,
      { subscribed: false },
      this.threadsApi.unsubscribeThread(chatId, rootId),
    );
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
        if (!this.stateWatch.selected({ chatId, threadId: rootId }) && current && current.version > version) {
          state =
            !current.dirty && (current.state.lastReadMessageId ?? rootId) >= (state.lastReadMessageId ?? rootId)
              ? current.state
              : await this.getThreadReadState(chatId, rootId);
        }
        if (this.destroyRef.destroyed) return;
        this.changed(ChatChangeKind.Read, chatId, rootId, state.lastReadMessageId ?? target);
        this.threadReads.update((states) =>
          new Map(states).set(rootId, { state, version: ++this.version, dirty: false }),
        );
        if (this.stateWatch.selected({ chatId, threadId: rootId })) this.stateWatch.refresh();
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

function messagePreview(message: MessageResponse): MessagePreview {
  return {
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
}
