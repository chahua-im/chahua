// The display cap (UNREAD_COUNT_DISPLAY_MAX) is intentionally 1 below the
// backend's MAX_UNREAD_COUNT (1000). The backend always returns values in the
// range [0, 1000]; any value >= 1000 is shown as "999+".
// If the backend MAX_UNREAD_COUNT is changed, update this constant accordingly.
export const UNREAD_COUNT_DISPLAY_MAX = 999;

export function formatUnreadCount(count: number): string {
  return count > UNREAD_COUNT_DISPLAY_MAX ? `${UNREAD_COUNT_DISPLAY_MAX}+` : String(count);
}
