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

@Service()
export class ConversationNavigation {
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly drafts = inject(DraftStore);

  async prepareForward(chatId: SnowflakeID, threadId: SnowflakeID | undefined, sources: readonly ForwardSource[]) {
    const previous = this.drafts.forward(chatId, threadId);
    const selection = sources.map(forwardSourceMessage);
    if (!selection.every((message) => message != null)) return false;
    this.drafts.setForward(chatId, threadId, selection);
    let opened = false;
    try {
      opened = await this.open(chatId, threadId);
      return opened;
    } finally {
      if (!opened && this.drafts.forward(chatId, threadId) === selection)
        this.drafts.setForward(chatId, threadId, previous);
    }
  }

  async open(chatId: SnowflakeID, threadId?: SnowflakeID, messageId?: SnowflakeID) {
    await dismissChatOverlays(this.modals);
    const commands = ['/chats/chat', decodeId(chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])];
    const extras = messageId ? { fragment: `msg=${decodeId(messageId)}` } : {};
    const url = this.router.serializeUrl(this.router.createUrlTree(commands, extras));
    if (this.router.url === url) {
      // Angular ignores identical URLs; an already-open message still needs repositioning.
      if (messageId) this.goTo(chatId, { type: ConversationTargetKind.Message, messageId }, threadId);
      return true;
    }
    return messageId ? this.router.navigate(commands, extras) : this.router.navigate(commands);
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
