import { inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { decodeId, type SnowflakeID } from '../api/snowflake-id';
import { dismissChatOverlays } from '../chats/dismiss-chat-overlays';
import { forwardSourceMessage, type ForwardSource } from '../messages/forwarding';
import { DraftStore } from './draft-store';

export enum ConversationTargetKind {
  Resume,
  Latest,
  Message,
}

export type ConversationTarget =
  | { type: ConversationTargetKind.Resume }
  | { type: ConversationTargetKind.Latest }
  | { type: ConversationTargetKind.Message; messageId: SnowflakeID };

export interface ForwardDraftLocation {
  chatId: SnowflakeID;
  threadId?: SnowflakeID;
}

@Service()
export class ConversationNavigation {
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly drafts = inject(DraftStore);

  async prepareForward(
    chatId: SnowflakeID,
    threadId: SnowflakeID | undefined,
    sources: readonly ForwardSource[],
    moveFrom?: ForwardDraftLocation,
  ) {
    if (moveFrom && this.drafts.forward(moveFrom.chatId, moveFrom.threadId) !== sources) return false;
    const previous = this.drafts.forward(chatId, threadId);
    const selection = sources.map(forwardSourceMessage);
    if (!selection.every((message) => message != null)) return false;
    this.drafts.setForward(chatId, threadId, selection);
    let opened = false;
    try {
      // Keep the picker and its search/scroll state available if routing fails.
      opened = await this.navigate(chatId, threadId);
      if (opened) {
        if (moveFrom && this.drafts.forward(moveFrom.chatId, moveFrom.threadId) === sources)
          this.drafts.setForward(moveFrom.chatId, moveFrom.threadId);
        await dismissChatOverlays(this.modals);
      }
      return opened;
    } finally {
      if (!opened && this.drafts.forward(chatId, threadId) === selection)
        this.drafts.setForward(chatId, threadId, previous);
    }
  }

  async open(chatId: SnowflakeID, threadId?: SnowflakeID, messageId?: SnowflakeID) {
    const opened = await this.navigate(chatId, threadId, messageId);
    if (opened) await dismissChatOverlays(this.modals);
    return opened;
  }

  private async navigate(chatId: SnowflakeID, threadId?: SnowflakeID, messageId?: SnowflakeID) {
    const commands = ['/chats/chat', decodeId(chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])];
    const extras = messageId ? { fragment: `msg=${decodeId(messageId)}` } : {};
    const url = this.router.serializeUrl(this.router.createUrlTree(commands, extras));
    if (this.router.url === url) {
      // Angular ignores identical URLs; an already-open message still needs repositioning.
      if (messageId) this.goTo(chatId, { type: ConversationTargetKind.Message, messageId }, threadId);
      return true;
    }
    const sameMessage =
      !!messageId &&
      this.router.isActive(url, {
        paths: 'exact',
        queryParams: 'ignored',
        fragment: 'exact',
        matrixParams: 'exact',
      });
    const opened = await (messageId ? this.router.navigate(commands, extras) : this.router.navigate(commands));
    // Removing a panel preserves the component and its unchanged message input.
    if (opened && sameMessage && messageId)
      this.goTo(chatId, { type: ConversationTargetKind.Message, messageId }, threadId);
    return opened;
  }

  private readonly requests = new Subject<{
    chatId: SnowflakeID;
    target: ConversationTarget;
    threadId?: SnowflakeID;
  }>();
  readonly requests$ = this.requests.asObservable();

  goTo(chatId: SnowflakeID, target: ConversationTarget, threadId?: SnowflakeID) {
    this.requests.next({ chatId, target, threadId });
  }
}
