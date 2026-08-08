import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import {
  areAttachmentIdsEqual,
  areMessageListsEquivalent,
  buildOptimisticUploadedAttachments,
  formatDateSeparator,
  generateClientId,
  hasLoadedThreadChatMeta,
  isAudioMessage,
  isMessageAtOrAfter,
  parseComparableMessageId,
} from './conversationUtils';

function message(id: string, messageType: MessageResponse['messageType'] = 'text'): MessageResponse {
  return {
    id,
    clientGeneratedId: `client-${id}`,
    chatId: '1',
    replyRootId: null,
    message: `message ${id}`,
    messageType,
    sender: { uid: 2, name: 'User', gender: 0 },
    createdAt: new Date(Number(id) || 0).toISOString(),
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
  };
}

describe('conversation utility helpers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates client ids that are not comparable backend ids', () => {
    const clientId = generateClientId();

    expect(clientId).toMatch(/^cg_1234_/);
    expect(parseComparableMessageId(clientId)).toBeNull();
    expect(isMessageAtOrAfter(clientId, '10')).toBe(false);
  });

  it('compares numeric message ids only', () => {
    expect(parseComparableMessageId('42')).toBe(42n);
    expect(parseComparableMessageId('0042')).toBe(42n);
    expect(parseComparableMessageId('42a')).toBeNull();
    expect(parseComparableMessageId('')).toBeNull();

    expect(isMessageAtOrAfter('11', '10')).toBe(true);
    expect(isMessageAtOrAfter('10', '10')).toBe(true);
    expect(isMessageAtOrAfter('9', '10')).toBe(false);
    expect(isMessageAtOrAfter(null, '10')).toBe(false);
    expect(isMessageAtOrAfter('11', 'cg_local')).toBe(false);
  });

  it('compares attachment ids by length and order', () => {
    expect(areAttachmentIdsEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(areAttachmentIdsEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(areAttachmentIdsEqual(['a'], ['a', 'b'])).toBe(false);
  });

  it('compares message lists by ids in order', () => {
    expect(areMessageListsEquivalent([message('1'), message('2')], [message('1'), message('2')])).toBe(true);
    expect(areMessageListsEquivalent([message('1'), message('2')], [message('2'), message('1')])).toBe(false);
    expect(areMessageListsEquivalent([message('1')], [message('1'), message('2')])).toBe(false);
  });

  it('detects audio messages', () => {
    expect(isAudioMessage(message('1', 'audio'))).toBe(true);
    expect(isAudioMessage(message('2', 'text'))).toBe(false);
  });

  it('creates optimistic attachments and revokes generated preview urls', () => {
    const createObjectUrl = vi.fn((file: Blob) => `blob:${(file as File).name}`);
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });

    const file = { name: 'voice.m4a' } as File;
    const result = buildOptimisticUploadedAttachments([
      {
        attachmentId: 'att-1',
        file,
        mimeType: 'audio/mp4',
        size: 99,
      },
    ]);

    expect(result.attachments).toEqual([
      {
        id: 'att-1',
        url: 'blob:voice.m4a',
        kind: 'audio/mp4',
        size: 99,
        fileName: 'voice.m4a',
        width: null,
        height: null,
      },
    ]);

    result.revoke();

    expect(createObjectUrl).toHaveBeenCalledWith(file);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:voice.m4a');
  });

  it('formats date separators for today, yesterday, and older dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00'));

    const labels = { today: 'Today', yesterday: 'Yesterday' };

    expect(formatDateSeparator('', 'en-US', labels)).toBe('');
    expect(formatDateSeparator('2026-06-10T08:00:00', 'en-US', labels)).toBe('Today');
    expect(formatDateSeparator('2026-06-09T08:00:00', 'en-US', labels)).toBe('Yesterday');
    expect(formatDateSeparator('2026-06-01T08:00:00', 'en-US', labels)).toBe('Jun 1');
    expect(formatDateSeparator('2025-01-15T08:00:00', 'en-US', labels)).toBe('Jan 15, 2025');

    vi.useRealTimers();
  });

  it('formats date separators for zh-CN locale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00'));

    const labels = { today: '今天', yesterday: '昨天' };

    expect(formatDateSeparator('2026-06-10T08:00:00', 'zh-CN', labels)).toBe('今天');
    expect(formatDateSeparator('2026-06-09T08:00:00', 'zh-CN', labels)).toBe('昨天');
    expect(formatDateSeparator('2026-06-01T08:00:00', 'zh-CN', labels)).toBe('6月1日');
    expect(formatDateSeparator('2025-01-15T08:00:00', 'zh-CN', labels)).toBe('2025年1月15日');

    vi.useRealTimers();
  });

  it('treats loaded thread metadata as name plus defined role', () => {
    expect(hasLoadedThreadChatMeta({ name: 'General', myRole: null })).toBe(true);
    expect(hasLoadedThreadChatMeta({ name: 'General' })).toBe(false);
    expect(hasLoadedThreadChatMeta({ name: null, myRole: 'member' })).toBe(false);
    expect(hasLoadedThreadChatMeta()).toBe(false);
  });
});
