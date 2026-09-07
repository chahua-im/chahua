/**
 * Shared vocabulary for the unread-mention id cache kept by the chat and thread
 * slices (chat state in `liveProjection`, thread state in per-thread maps).
 */

export type MentionIdCacheStatus = 'idle' | 'loading' | 'ready';

/** Prepend a newly arrived mention id, deduped, keeping the list newest-first. */
export function prependMentionId(existing: string[] | undefined, messageId: string): string[] {
  return [messageId, ...(existing ?? []).filter((id) => id !== messageId)];
}
