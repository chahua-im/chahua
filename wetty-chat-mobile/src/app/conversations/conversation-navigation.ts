import type { SnowflakeID } from '../api/snowflake-id';
import { Service } from '@angular/core';
import { Subject } from 'rxjs';

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
