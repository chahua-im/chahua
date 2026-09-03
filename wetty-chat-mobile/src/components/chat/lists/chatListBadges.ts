import type { ChatListEntry } from '@/api/chats';

/**
 * Whether the chat is currently muted. Temporary mutes expire; pass a fixed
 * `now` in tests to cover both the muted and the expired window.
 */
export function isChatMuted(chat: Pick<ChatListEntry, 'mutedUntil'>, now: Date = new Date()): boolean {
  if (!chat.mutedUntil) return false;
  return new Date(chat.mutedUntil) > now;
}

/**
 * Whether the chat's unread count should light up its category tab badge
 * (Groups/Friends). Active lists exclude currently muted chats so their rows
 * keep the grey inline badge without counting toward the blue tab badge.
 * Archived lists keep unread prompts even when the chat carries an active
 * mute (archiving mutes indefinitely), so callers pass `includeMuted: true`.
 */
export function hasUnreadTabBadge(
  chat: Pick<ChatListEntry, 'unreadCount' | 'mutedUntil'>,
  options: { includeMuted?: boolean; now?: Date } = {},
): boolean {
  if ((chat.unreadCount ?? 0) <= 0) return false;
  if (options.includeMuted) return true;
  return !isChatMuted(chat, options.now);
}
