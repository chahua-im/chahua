export const UNREAD_BADGE_DISPLAY_MAX = 999;
export const UNREAD_BADGE_COUNT_CAP = UNREAD_BADGE_DISPLAY_MAX + 1;

/**
 * Server-side hard cap on unread-mention/reaction id lists (`MAX_UNREAD_COUNT`
 * in the backend). Matching it lets the jump window cover the full capped set.
 */
export const UNREAD_ID_FETCH_MAX = 1000;

export function formatUnreadBadge(count: number): string {
  return count > UNREAD_BADGE_DISPLAY_MAX ? `${UNREAD_BADGE_DISPLAY_MAX}+` : String(count);
}
