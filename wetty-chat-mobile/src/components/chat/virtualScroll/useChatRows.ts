import { useMemo } from 'react';
import type { MessageResponse } from '@/api/messages';
import type { ChatRow } from './types';

function formatDateKey(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 10);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isSameDate(a: string, b: string): boolean {
  return formatDateKey(a) === formatDateKey(b);
}

function isSystemMessage(message: MessageResponse): boolean {
  return message.messageType === 'system';
}

export function useChatRows(
  messages: MessageResponse[],
  formatDateSeparator: (iso: string) => string,
  showAllAvatars: boolean,
): ChatRow[] {
  return useMemo(() => {
    const rows: ChatRow[] = [];
    let prevSenderUid: number | string | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const prevMsg = messages[i - 1];
      const nextMsg = messages[i + 1];

      // Date separator: always shown on the first message and on date boundaries.
      // The key must stay stable when older messages are prepended, otherwise
      // staging batches can get stranded waiting on a row that changed identity.
      const isDateBoundary = prevMsg && !isSameDate(msg.createdAt, prevMsg.createdAt);
      const isFirstMessage = i === 0;
      if (isFirstMessage || isDateBoundary) {
        rows.push({
          type: 'date',
          key: `date:${formatDateKey(msg.createdAt)}`,
          dateLabel: formatDateSeparator(msg.createdAt),
        });
        prevSenderUid = null;
      }

      const isSystem = isSystemMessage(msg);
      const nextIsSystem = nextMsg ? isSystemMessage(nextMsg) : false;

      // Grouping
      const hasDateSeparator = isFirstMessage || isDateBoundary;
      const showName = !isSystem && (msg.sender.uid !== prevSenderUid || hasDateSeparator);
      const isLastInGroup =
        isSystem ||
        !nextMsg ||
        nextIsSystem ||
        nextMsg.sender.uid !== msg.sender.uid ||
        !isSameDate(msg.createdAt, nextMsg.createdAt);

      rows.push({
        type: 'message',
        key: `msg:${msg.clientGeneratedId || msg.id}`,
        messageId: msg.id,
        clientGeneratedId: msg.clientGeneratedId ?? null,
        message: msg,
        showName,
        showAvatar: showAllAvatars || isLastInGroup,
      });

      prevSenderUid = isSystem ? null : msg.sender.uid;
    }

    return rows;
  }, [messages, formatDateSeparator, showAllAvatars]);
}
