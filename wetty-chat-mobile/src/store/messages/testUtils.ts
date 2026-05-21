import type { MessageResponse } from '@/api/messages';
import type { MessagesState } from './types';

export function testMessage(
  id: string,
  clientGeneratedId = `client-${id}`,
  patch: Partial<MessageResponse> = {},
): MessageResponse {
  const numericId = Number(id.replace(/\D/g, '')) || 1;
  return {
    id,
    clientGeneratedId,
    chatId: '1',
    replyRootId: null,
    message: `message ${id}`,
    messageType: 'text',
    sender: { uid: 2, name: 'User', gender: 0 },
    createdAt: new Date(numericId).toISOString(),
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
    ...patch,
  };
}

export function testOptimisticMessage(clientGeneratedId = 'client-optimistic'): MessageResponse {
  return testMessage('cg_1', clientGeneratedId, { createdAt: new Date(999).toISOString() });
}

export function ids(messages: MessageResponse[]): string[] {
  return messages.map((item) => item.id);
}

export function testRootState(messages: MessagesState): { messages: MessagesState } {
  return { messages };
}

export function segmentIds(messages: MessagesState, chatId = '1'): string[][] {
  return messages.chats[chatId]?.segments.map((segment) => ids(segment.messages)) ?? [];
}
