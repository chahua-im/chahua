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

@Service()
export class ConversationNavigation {
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);

  async open(chatId: SnowflakeID, threadId?: SnowflakeID, messageId?: SnowflakeID) {
    await dismissChatOverlays(this.modals);
    const commands = ['/chats/chat', decodeId(chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])];
    if (!messageId) return this.router.navigate(commands);
    const extras = { queryParams: { message: decodeId(messageId) } };
    const url = this.router.serializeUrl(this.router.createUrlTree(commands, extras));
    if (this.router.url === url) {
      // Angular ignores identical URLs; an already-open message still needs repositioning.
      this.goTo(chatId, { type: ConversationTargetKind.Message, messageId }, threadId);
      return true;
    }
    return this.router.navigate(commands, extras);
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
