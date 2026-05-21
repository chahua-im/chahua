import { describe, expect, it } from 'vitest';
import type { MessageResponse } from '@/api/messages';
import { buildMessageSearchTarget, isMessageSearchQueryReady } from './messageSearch';

function message(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: '100',
    message: 'hello',
    messageType: 'text',
    replyRootId: null,
    clientGeneratedId: 'client-100',
    sender: { uid: 1, name: 'Alice', gender: 0 },
    chatId: '10',
    createdAt: '2026-05-19T00:00:00Z',
    isEdited: false,
    isDeleted: false,
    hasAttachments: false,
    attachments: [],
    reactions: [],
    mentions: [],
    ...overrides,
  };
}

describe('message search helpers', () => {
  it('requires at least two trimmed characters before searching', () => {
    expect(isMessageSearchQueryReady('')).toBe(false);
    expect(isMessageSearchQueryReady('  a ')).toBe(false);
    expect(isMessageSearchQueryReady('你')).toBe(false);
    expect(isMessageSearchQueryReady('你好')).toBe(true);
    expect(isMessageSearchQueryReady(' hi ')).toBe(true);
  });

  it('builds direct chat target for top-level search results', () => {
    expect(buildMessageSearchTarget('10', message({ id: '200', replyRootId: null }))).toEqual({
      pathname: '/chats/chat/10',
      hash: '#msg=200',
    });
  });

  it('builds direct thread target for reply search results', () => {
    expect(buildMessageSearchTarget('10', message({ id: '201', replyRootId: '150' }))).toEqual({
      pathname: '/chats/chat/10/thread/150',
      hash: '#msg=201',
    });
  });
});
