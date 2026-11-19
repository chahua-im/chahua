import type { ForwardedMessagesResponse } from '../../../generated/models';
import type { MessageContent } from '../message/message';

type ForwardedRecordContent = MessageContent & { redacted: boolean; internalReply: boolean };

export function forwardedRecordContents(records: ForwardedMessagesResponse): ForwardedRecordContent[] {
  return records.messages.map((message) => {
    const reply = message.reply;
    const quote = reply?.kind === 'internal' ? reply.preview : undefined;
    return {
      ...message,
      id: message.originalMessageId,
      chatId: message.originalChatId,
      createdAt: message.originalCreatedAt,
      redacted: reply?.kind === 'redacted' && !reply.externalPreview,
      internalReply: reply?.kind === 'internal',
      replyToMessage: quote
        ? {
            ...quote,
            id: quote.originalMessageId,
            createdAt: quote.originalCreatedAt,
            isDeleted: false,
            mentions: quote.mentions ?? [],
          }
        : reply?.kind === 'redacted'
          ? reply.externalPreview
          : undefined,
    };
  });
}
