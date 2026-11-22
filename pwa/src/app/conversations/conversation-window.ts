import type { ListMessagesResponse, MessageResponse } from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';

export type ConversationContext = Readonly<{ chatId: SnowflakeID; threadId?: SnowflakeID }>;
export type MessageRange = Pick<
  ListMessagesResponse,
  'messages' | 'olderCursor' | 'newerCursor' | 'chatSettings' | 'membershipMessagePolicy'
>;

export function acceptsConversationMessage(scope: ConversationContext | undefined, message: MessageResponse) {
  return (
    message.chatId === scope?.chatId &&
    (scope.threadId ? message.replyRootId === scope.threadId || message.id === scope.threadId : !message.replyRootId)
  );
}
