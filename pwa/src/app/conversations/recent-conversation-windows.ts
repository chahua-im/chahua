import { effect, inject, Service } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { GroupKind, ServerWsMessageType, type MessagePreview, type MessageResponse } from '../../generated/models';
import { Connection, ResyncReason } from '../api/connection';
import type { SnowflakeID } from '../api/snowflake-id';
import { ChatChangeKind, ChatStore } from '../chats/chat-store';
import type { MessageChange } from '../messages/message-change';
import { mergeMessageArrivals } from '../messages/message-merge';
import { MessageSync, requiresMessagePurge } from '../messages/message-sync';
import { preserveReactionOwnership } from '../messages/reaction-state';
import { isMembershipMessage } from '../messages/system-message';
import { SessionStore } from '../session/session-store';
import {
  acceptsConversationMessage,
  redactDeletedMessage,
  redactMessageCitations,
  replaceEditedMessage,
  replaceMessageCitation,
  toMessagePreview,
  type ConversationContext,
  type MessageRange,
} from './conversation-window';

const MAX_WINDOWS = 8;
const MAX_MESSAGES = 50;

export interface RecentConversationWindow {
  range: MessageRange;
  anchor?: SnowflakeID;
  atBottom: boolean;
  hideMembershipMessages: boolean;
  /** An earlier generation can still be restored by continuous replay. */
  alignedGeneration?: number;
}

interface Entry {
  readonly scope: ConversationContext;
  window: RecentConversationWindow;
}

function scopeKey({ chatId, threadId }: ConversationContext) {
  return `${chatId}:${threadId ?? ''}`;
}

function trim(window: RecentConversationWindow): RecentConversationWindow {
  const { range, anchor, atBottom } = window;
  const { messages } = range;
  const excess = messages.length - MAX_MESSAGES;
  if (excess <= 0) return window;
  let start = excess;
  if (!atBottom) {
    const index = anchor != null ? messages.findIndex(({ id }) => id >= anchor) : Math.floor(messages.length / 2);
    if (index >= 0) start = Math.max(0, Math.min(excess, index - MAX_MESSAGES / 2));
  }
  const end = start + MAX_MESSAGES;
  return {
    ...window,
    range: {
      ...range,
      messages: messages.slice(start, end),
      olderCursor: start > 0 ? messages[start].id : range.olderCursor,
      newerCursor: end < messages.length ? messages[end - 1].id : range.newerCursor,
    },
  };
}

/** Owns only inactive ranges, not their views or network requests. */
@Service()
export class RecentConversationWindows {
  private readonly realtime = inject(Connection);
  private readonly chats = inject(ChatStore);
  private readonly sync = inject(MessageSync);
  private readonly session = inject(SessionStore);
  private readonly entries = new Map<string, Entry>();
  private uid?: number;

  constructor() {
    this.realtime.messages$.pipe(takeUntilDestroyed()).subscribe((message) => this.receive(message));
    this.realtime.changes$.pipe(takeUntilDestroyed()).subscribe((event) => this.applyChange(event));
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type !== ServerWsMessageType.threadUpdate || this.sync.active()) return;
      const { chatId, threadRootId, replyCount } = event.payload;
      this.patch(chatId, (message) =>
        message.id === threadRootId ? { ...message, threadInfo: replyCount > 0 ? { replyCount } : undefined } : message,
      );
    });
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe((reason) => {
      if (reason === ResyncReason.Connected && !this.sync.active()) {
        // A spell in legacy mode leaves a gap even if the next sync resume is continuous.
        for (const entry of this.entries.values()) entry.window.alignedGeneration = undefined;
      }
    });
    this.chats.changes$.pipe(takeUntilDestroyed()).subscribe(({ kind, chatId, threadId }) => {
      switch (kind) {
        case ChatChangeKind.Removed:
        case ChatChangeKind.MessagePurge:
          for (const [key, { scope }] of this.entries) {
            if (scope.chatId === chatId && (threadId == null || scope.threadId === threadId)) this.entries.delete(key);
          }
          break;
        case ChatChangeKind.MembershipMessagePolicy: {
          const key = scopeKey({ chatId });
          const entry = this.entries.get(key);
          if (entry && !this.matchesFilter(entry.scope, entry.window)) this.entries.delete(key);
          break;
        }
      }
    });
    this.sync.resets$.pipe(takeUntilDestroyed()).subscribe(({ chatId, reason }) => {
      for (const [key, entry] of this.entries) {
        if (entry.scope.chatId !== chatId) continue;
        if (requiresMessagePurge(reason)) this.entries.delete(key);
        else entry.window.alignedGeneration = undefined;
      }
    });
    this.sync.accountResets$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.entries.clear();
      this.uid = undefined;
    });
    effect(() => {
      if (!this.hasAccount()) return;
      // Account preferences are also updated by confirmed writes and response snapshots.
      for (const [key, { scope, window }] of this.entries) {
        if (!this.matchesFilter(scope, window)) this.entries.delete(key);
      }
    });
  }

  keep(scope: ConversationContext, window: RecentConversationWindow): void {
    if (!this.hasAccount()) return;
    const key = scopeKey(scope);
    this.entries.delete(key);
    if (!this.chats.isAccessible(scope.chatId, scope.threadId) || !this.matchesFilter(scope, window)) return;
    this.entries.set(key, { scope, window: trim(window) });
    if (this.entries.size > MAX_WINDOWS) this.entries.delete(this.entries.keys().next().value!);
  }

  take(scope: ConversationContext, hideMembershipMessages: boolean): RecentConversationWindow | undefined {
    if (!this.hasAccount()) return;
    const key = scopeKey(scope);
    const window = this.entries.get(key)?.window;
    this.entries.delete(key);
    if (
      !window ||
      window.hideMembershipMessages !== hideMembershipMessages ||
      !this.matchesFilter(scope, window) ||
      !this.chats.isAccessible(scope.chatId, scope.threadId)
    ) {
      return;
    }
    if (
      window.alignedGeneration != null &&
      this.realtime.connected() &&
      this.sync.active() &&
      this.sync.isCovered(scope.chatId)
    ) {
      window.alignedGeneration = this.sync.connectionGeneration;
    }
    return window;
  }

  private hasAccount() {
    const uid = this.session.user()?.uid;
    if (uid !== this.uid) {
      this.entries.clear();
      this.uid = uid;
    }
    return uid != null;
  }

  private matchesFilter(scope: ConversationContext, window: RecentConversationWindow) {
    const hidden =
      scope.threadId == null &&
      this.chats.get(scope.chatId)?.kind !== GroupKind.dm &&
      (this.session.user()?.showMembershipMessages === false ||
        this.chats.membershipPolicy(scope.chatId)?.canView === false);
    return hidden === window.hideMembershipMessages;
  }

  private receive(message: MessageResponse) {
    for (const entry of this.entries.values()) {
      const { scope, window } = entry;
      if (!acceptsConversationMessage(scope, message)) continue;
      if (isMembershipMessage(message) && (window.hideMembershipMessages || !this.matchesFilter(scope, window)))
        continue;
      const { range } = window;
      // The generation may be old while a verified cursor chain is replayed before Ready.
      // A reset severs that chain; a bare Ready never aligns a legacy or reset window.
      const atLatest = range.newerCursor == null && window.alignedGeneration != null && this.sync.active();
      const messages = mergeMessageArrivals(range.messages, [message], atLatest);
      if (messages !== range.messages) entry.window = trim({ ...window, range: { ...range, messages } });
    }
  }

  private applyChange(event: MessageChange) {
    if (!this.entries.size) return;
    switch (event.type) {
      case ServerWsMessageType.messageUpdated:
      case ServerWsMessageType.messageDeleted: {
        const next = event.payload;
        const deleted = event.type === ServerWsMessageType.messageDeleted || next.isDeleted;
        const deletedIds = deleted ? new Set([next.id]) : undefined;
        let replacement: MessageResponse | undefined;
        let preview: MessagePreview | undefined;
        this.patch(next.chatId, (message) => {
          if (message.id === next.id) {
            replacement ??= deleted ? redactDeletedMessage(next) : next;
            return replaceEditedMessage(message, replacement);
          }
          if (deletedIds) return redactMessageCitations(message, deletedIds);
          if (message.replyToMessage?.id !== next.id) return message;
          return replaceMessageCitation(message, next.id, (preview ??= toMessagePreview(next)));
        });
        break;
      }
      case ServerWsMessageType.messagesBulkDeleted: {
        const { chatId, messageIds } = event.payload;
        const ids = new Set(messageIds);
        this.patch(chatId, (message) => {
          if (ids.has(message.id)) return redactDeletedMessage(message);
          return redactMessageCitations(message, ids);
        });
        break;
      }
      case ServerWsMessageType.reactionUpdated: {
        const { chatId, messageId, reactions } = event.payload;
        this.patch(chatId, (message) =>
          message.id === messageId
            ? { ...message, reactions: preserveReactionOwnership(message.reactions, reactions) }
            : message,
        );
        break;
      }
    }
  }

  private patch(chatId: SnowflakeID, update: (message: MessageResponse) => MessageResponse) {
    for (const { scope, window } of this.entries.values()) {
      if (scope.chatId !== chatId) continue;
      const current = window.range.messages;
      let messages: MessageResponse[] | undefined;
      for (let i = 0; i < current.length; i++) {
        const updated = update(current[i]);
        if (updated !== current[i]) (messages ??= current.slice())[i] = updated;
      }
      if (messages) window.range = { ...window.range, messages };
    }
  }
}
