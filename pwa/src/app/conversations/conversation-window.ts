import type { ListMessagesResponse, MessagePreview, MessageResponse } from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';
import { preserveReactionOwnership } from '../messages/reaction-state';

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

export function replaceEditedMessage(current: MessageResponse, next: MessageResponse) {
  return { ...next, reactions: preserveReactionOwnership(current.reactions, next.reactions) };
}

export function redactDeletedMessage(message: MessageResponse): MessageResponse {
  return {
    ...message,
    isDeleted: true,
    forwardedFrom: undefined,
    forwardedPreview: undefined,
    forwardedBundleId: undefined,
    message: undefined,
    metadata: undefined,
    attachments: [],
    mentions: [],
    sticker: undefined,
  };
}

export function replaceMessageCitation(
  message: MessageResponse,
  id: SnowflakeID,
  preview: MessagePreview | null,
): MessageResponse {
  const quote = message.replyToMessage;
  if (quote?.id !== id) return message;
  return {
    ...message,
    replyToMessage: preview ?? {
      ...quote,
      isDeleted: true,
      message: undefined,
      attachments: [],
      mentions: [],
      sticker: undefined,
    },
  };
}

/** Mirrors the server's MessagePreview shape embedded as replyToMessage. */
export function toMessagePreview(message: MessageResponse): MessagePreview {
  return {
    metadata: message.metadata,
    id: message.id,
    clientGeneratedId: message.clientGeneratedId,
    forwardedFromName: message.forwardedFrom?.sender.name,
    createdAt: message.createdAt,
    sender: message.sender,
    message: message.message,
    messageType: message.messageType,
    systemKind: message.systemKind,
    systemLinks: message.systemLinks,
    sticker: message.sticker ? { emoji: message.sticker.emoji } : undefined,
    attachments: message.attachments.map(({ kind }) => ({ kind })),
    isDeleted: message.isDeleted,
    mentions: message.mentions ?? [],
  };
}
