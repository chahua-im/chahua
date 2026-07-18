import { describe, expect, it } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import type { ChatRow } from './types';
import { estimateRowHeight } from './rowHeightEstimator';

type GroupChatRow = Extract<ChatRow, { type: 'group' }>;

function baseMessage(): MessageResponse {
  return {
    clientGeneratedId: 'client-1',
    id: '1',
    chatId: 'chat-1',
    replyRootId: null,
    message: 'hello',
    messageType: 'text',
    sender: { uid: 1, name: 'User', gender: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
    attachments: [],
  };
}

function groupRow(messages: MessageResponse[]): GroupChatRow {
  return {
    type: 'group',
    key: `grp:${messages[0].clientGeneratedId || messages[0].id}`,
    messages,
    firstMessageId: messages[0].id,
    lastMessageId: messages[messages.length - 1].id,
    isSystem: false,
    showName: true,
    useStickyAvatar: true,
  };
}

describe('estimateRowHeight', () => {
  it('uses a fixed estimate for date rows', () => {
    expect(estimateRowHeight({ type: 'date', key: 'date:1', dateLabel: 'Today' }, '14px')).toBe(32);
  });

  it('estimates a single-message group with a deleted message', () => {
    expect(estimateRowHeight(groupRow([{ ...baseMessage(), isDeleted: true }]), '14px')).toBe(48);
  });

  it('adds reply affordance height to media-heavy estimates', () => {
    const base = estimateRowHeight(
      groupRow([
        {
          ...baseMessage(),
          attachments: [{ id: 'a1', url: 'u', kind: 'image/png', size: 1, fileName: 'a.png' }],
        },
      ]),
      '14px',
    );
    const withReply = estimateRowHeight(
      groupRow([
        {
          ...baseMessage(),
          attachments: [{ id: 'a1', url: 'u', kind: 'image/png', size: 1, fileName: 'a.png' }],
          replyToMessage: baseMessage(),
        },
      ]),
      '14px',
    );

    expect(base).toBe(220);
    expect(withReply).toBe(246);
  });

  it('sums the heights of all messages in a multi-message group', () => {
    // Two deleted messages → 48 + 48 = 96.
    const row = groupRow([
      { ...baseMessage(), id: '1', isDeleted: true },
      { ...baseMessage(), id: '2', isDeleted: true },
    ]);
    expect(estimateRowHeight(row, '14px')).toBe(96);
  });
});
