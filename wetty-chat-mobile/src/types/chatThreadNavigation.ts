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
 *
 * The only gate is lastReadMessageId — if the user has ever read this thread
 * (indicated by a non-null lastReadMessageId), they should resume there.
 * Threads without a lastReadMessageId are first visits and should open at top.
 */
export function buildResumeHash(params: { lastReadMessageId: string | null | undefined }): string {
  if (params.lastReadMessageId == null) return '';
  return `#msg=${params.lastReadMessageId}`;
}
