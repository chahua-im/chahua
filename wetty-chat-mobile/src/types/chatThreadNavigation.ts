export interface ChatThreadRouteState {
  backgroundPath?: string;
}

/**
 * Parse a `#msg=<messageId>` hash fragment into the message ID, or return null.
 */
export function parseResumeHash(hash: string): string | null {
  if (!hash.startsWith('#msg=')) return null;
  const messageId = hash.slice(5);
  if (!messageId) return null;
  try {
    return decodeURIComponent(messageId);
  } catch {
    return messageId;
  }
}

/**
 * Build a `#msg=<messageId>` hash fragment for jumping to a specific message
 * when opening a chat.  Returns an empty string when there is nothing to resume.
 */
export function buildResumeHash(params: { unreadCount: number; lastReadMessageId: string | null | undefined }): string {
  if (params.unreadCount <= 0 || params.lastReadMessageId == null) return '';
  return `#msg=${params.lastReadMessageId}`;
}
