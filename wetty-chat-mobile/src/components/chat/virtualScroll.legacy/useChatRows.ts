import { useMemo } from 'react';
import type { MessageResponse } from '@/api/messages';
import { isSystemMessage } from '../messages/messageTypePredicates';
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

export function useChatRows(
  messages: MessageResponse[],
  formatDateSeparator: (iso: string) => string,
  showAllAvatars: boolean,
): ChatRow[] {
  return useMemo(() => {
    const rows: ChatRow[] = [];
    let i = 0;
    let prevSenderUid: number | string | null = null;
    let hasDateSeparator = true;

    while (i < messages.length) {
      const msg = messages[i];
      const prevMsg = i > 0 ? messages[i - 1] : undefined;

      // Date separator: always shown on the first message and on date boundaries.
      // The key must stay stable when older messages are prepended, otherwise
      // staging batches can get stranded waiting on a row that changed identity.
      const isDateBoundary = prevMsg ? !isSameDate(msg.createdAt, prevMsg.createdAt) : false;
      if (i === 0 || isDateBoundary) {
        rows.push({
          type: 'date',
          key: `date:${formatDateKey(msg.createdAt)}`,
          dateLabel: formatDateSeparator(msg.createdAt),
        });
        prevSenderUid = null;
        hasDateSeparator = true;
      } else {
        hasDateSeparator = false;
      }

      const isSystem = isSystemMessage(msg);

      if (isSystem) {
        // System messages form their own single-message group with no avatar.
        rows.push({
          type: 'group',
          key: `grp:${msg.clientGeneratedId || msg.id}`,
          messages: [msg],
          firstMessageId: msg.id,
          lastMessageId: msg.id,
          isSystem: true,
          showName: false,
          useStickyAvatar: false,
        });
        prevSenderUid = null;
        i += 1;
        continue;
      }

      // Gather a consecutive run of same-sender non-system messages within the
      // same date into one group row. The avatar lives in a sticky container
      // spanning the whole group, so the group is the atomic virtual-scroll unit.
      const groupMessages: MessageResponse[] = [msg];
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        if (isSystemMessage(next)) break;
        if (next.sender.uid !== msg.sender.uid) break;
        if (!isSameDate(msg.createdAt, next.createdAt)) break;
        groupMessages.push(next);
        j += 1;
      }

      const showName = msg.sender.uid !== prevSenderUid || hasDateSeparator;
      // When showAllAvatars is on, every message renders its own inline avatar
      // (current behavior), so the group-level sticky avatar is not used.
      const useStickyAvatar = !showAllAvatars;

      rows.push({
        type: 'group',
        key: `grp:${msg.clientGeneratedId || msg.id}`,
        messages: groupMessages,
        firstMessageId: msg.id,
        lastMessageId: groupMessages[groupMessages.length - 1].id,
        isSystem: false,
        showName,
        useStickyAvatar,
      });

      prevSenderUid = msg.sender.uid;
      i = j;
    }

    return rows;
  }, [messages, formatDateSeparator, showAllAvatars]);
}
