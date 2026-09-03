/**
 * Shared vocabulary for the unread id caches kept by the chat and thread slices
 * (chat state in `liveProjection`, thread state in per-thread maps). Serves
 * both the mention/reply and the reaction badge pipelines.
 */

export type MentionIdCacheStatus = 'idle' | 'loading' | 'ready';

/** Prepend a newly arrived unread id, deduped, keeping the list newest-first. */
export function prependMentionId(existing: string[] | undefined, messageId: string): string[] {
  return [messageId, ...(existing ?? []).filter((id) => id !== messageId)];
}

/** Cache fields an incoming unread badge increment is applied to. */
export interface UnreadIdCacheMeta {
  ids?: string[] | undefined;
  status?: MentionIdCacheStatus | undefined;
}

/**
 * Cache discipline for one incoming unread badge increment: prepend the new id
 * when the cache is loaded (deduped, newest-first) so it is jumpable without a
 * refetch; invalidate a mid-flight fetch — its response predates the increment
 * and must not be cached as fresh. `alreadyPresent` reports whether the id was
 * already in the loaded cache (undefined when not ready) — used by reaction
 * badges, which aggregate one message's many reactions into a single unit.
 */
export function applyIncomingId(
  meta: UnreadIdCacheMeta,
  messageId: string | undefined,
): { ids: string[]; status?: MentionIdCacheStatus; alreadyPresent?: boolean } {
  const ids = messageId && meta.status === 'ready' ? prependMentionId(meta.ids, messageId) : (meta.ids ?? []);
  const status = meta.status === 'loading' ? 'idle' : meta.status;
  const alreadyPresent = meta.status === 'ready' && messageId !== undefined && meta.ids?.includes(messageId);
  return { ids, status, alreadyPresent };
}

/**
 * Pick the next unread id to jump to. `ids` are newest-first (descending), so
 * the oldest id is the last element.
 *
 * Rule: visit ids in chronological order (oldest -> newest) in a single pass —
 * returns `null` once the newest has been visited instead of wrapping (the FAB
 * disappears at the end of the pass). When `lastJumpedId` is no longer in the
 * list (e.g. after mark-read shrank it), the pass restarts from the oldest
 * remaining id. Returns `null` when there are no ids.
 */
export function pickNextUnreadId(ids: string[], lastJumpedId: string | null): string | null {
  if (ids.length === 0) return null;
  // ids are newest-first, so the oldest is the last element - start there.
  const oldest = ids[ids.length - 1];
  if (lastJumpedId === null) return oldest;
  const idx = ids.indexOf(lastJumpedId);
  if (idx === -1) return oldest;
  // idx - 1 moves toward the newer end (front of the array); past the newest the pass is over.
  return ids[idx - 1] ?? null;
}
