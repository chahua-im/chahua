import type { SavedMessageResponse } from '../../../generated/models';
import type { MessageContent } from '../message/message';

export function savedMessageContent(saved: SavedMessageResponse): MessageContent {
  const sticker = saved.sticker;
  return {
    id: saved.originalMessageId,
    chatId: saved.originalChatId,
    sender: saved.sender,
    createdAt: saved.originalCreatedAt,
    message: saved.message,
    mentions: saved.mentions,
    forwardedBundleId: saved.forwardedBundleId,
    messageType: saved.messageType,
    attachments: saved.attachments,
    sticker: sticker
      ? {
          id: sticker.id,
          emoji: sticker.emoji,
          name: sticker.name,
          media: { url: sticker.mediaUrl, contentType: sticker.mediaContentType },
        }
      : undefined,
  };
}
