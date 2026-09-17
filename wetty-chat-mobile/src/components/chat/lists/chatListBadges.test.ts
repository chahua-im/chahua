import { describe, expect, it } from 'vitest';
import type { ChatListEntry } from '@/api/chats';
import { hasUnreadTabBadge, isChatMuted } from './chatListBadges';

const NOW = new Date('2026-06-01T12:00:00Z');

function makeChat(overrides: Partial<ChatListEntry> = {}): ChatListEntry {
  return {
    id: 'chat-1',
    name: 'Chat',
    avatar: null,
    lastMessageAt: null,
    unreadCount: 0,
    unreadMentions: 0,
    lastReadMessageId: null,
    lastMessage: null,
    mutedUntil: null,
    archived: false,
    kind: 'group',
    ...overrides,
  };
}

describe('isChatMuted', () => {
  it('is false without mutedUntil', () => {
    expect(isChatMuted(makeChat({ mutedUntil: null }), NOW)).toBe(false);
  });

  it('is true while mutedUntil is in the future', () => {
    expect(isChatMuted(makeChat({ mutedUntil: '2026-06-01T12:00:01Z' }), NOW)).toBe(true);
  });

  it('is false once mutedUntil has expired', () => {
    expect(isChatMuted(makeChat({ mutedUntil: '2026-06-01T11:59:59Z' }), NOW)).toBe(false);
  });
});

describe('hasUnreadTabBadge', () => {
  it('counts an unmuted active chat with unread messages', () => {
    expect(hasUnreadTabBadge(makeChat({ unreadCount: 3 }), { now: NOW })).toBe(true);
  });

  it('excludes an active group chat with an active mute', () => {
    expect(hasUnreadTabBadge(makeChat({ unreadCount: 3, mutedUntil: '2026-06-01T13:00:00Z' }), { now: NOW })).toBe(
      false,
    );
  });

  it('excludes an active DM with an active mute', () => {
    expect(
      hasUnreadTabBadge(makeChat({ kind: 'dm', unreadCount: 1, mutedUntil: '2026-07-01T00:00:00Z' }), { now: NOW }),
    ).toBe(false);
  });

  it('counts a chat whose mute has expired', () => {
    expect(hasUnreadTabBadge(makeChat({ unreadCount: 3, mutedUntil: '2026-05-31T00:00:00Z' }), { now: NOW })).toBe(
      true,
    );
  });

  it('excludes chats without unread messages', () => {
    expect(hasUnreadTabBadge(makeChat({ unreadCount: 0 }), { now: NOW })).toBe(false);
  });

  it('counts archived chats even with an active mute', () => {
    expect(
      hasUnreadTabBadge(makeChat({ unreadCount: 2, mutedUntil: '9999-12-31T23:59:59Z' }), {
        includeMuted: true,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('counts only the unmuted chat in a mixed list', () => {
    const chats = [
      makeChat({ id: 'muted', unreadCount: 5, mutedUntil: '2026-06-02T00:00:00Z' }),
      makeChat({ id: 'unmuted', unreadCount: 2 }),
    ];
    expect(chats.filter((c) => hasUnreadTabBadge(c, { now: NOW })).length).toBe(1);
  });
});
