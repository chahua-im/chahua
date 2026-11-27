import { inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { decodeId, type SnowflakeID } from '../api/snowflake-id';
import { dismissChatOverlays } from '../chats/dismiss-chat-overlays';

export enum ConversationTargetKind {
  Resume,
  Latest,
  Message,
}

export type ConversationTarget =
  | { type: ConversationTargetKind.Resume }
  | { type: ConversationTargetKind.Latest }
  | { type: ConversationTargetKind.Message; messageId: SnowflakeID };

function conversationRoute(chatId: SnowflakeID, threadId?: SnowflakeID) {
  return ['/chats/chat', decodeId(chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])];
}

@Service()
export class ConversationNavigation {
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);

  isOpen(chatId: SnowflakeID, threadId?: SnowflakeID) {
    return this.router.isActive(this.router.createUrlTree(conversationRoute(chatId, threadId)), {
      paths: 'exact',
      queryParams: 'ignored',
      fragment: 'ignored',
      matrixParams: 'ignored',
    });
  }

  async open(chatId: SnowflakeID, threadId?: SnowflakeID, messageId?: SnowflakeID) {
    const opened = await this.navigate(chatId, threadId, messageId);
    if (opened) await dismissChatOverlays(this.modals);
    return opened;
  }

  private async navigate(chatId: SnowflakeID, threadId?: SnowflakeID, messageId?: SnowflakeID) {
    const commands = conversationRoute(chatId, threadId);
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
