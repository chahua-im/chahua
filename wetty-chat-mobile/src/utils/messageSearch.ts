import type { MessageResponse } from '@/api/messages';

export interface MessageSearchTarget {
  pathname: string;
  hash: string;
}

export function isMessageSearchQueryReady(query: string): boolean {
  return query.trim().length >= 2;
}

export function buildMessageSearchTarget(
  chatId: string | number,
  message: Pick<MessageResponse, 'id' | 'replyRootId'>,
): MessageSearchTarget {
  const encodedChatId = encodeURIComponent(String(chatId));
  const encodedMessageId = encodeURIComponent(String(message.id));

  if (message.replyRootId != null) {
    return {
      pathname: `/chats/chat/${encodedChatId}/thread/${encodeURIComponent(String(message.replyRootId))}`,
      hash: `#msg=${encodedMessageId}`,
    };
  }

  return {
    pathname: `/chats/chat/${encodedChatId}`,
    hash: `#msg=${encodedMessageId}`,
  };
}
