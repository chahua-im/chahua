import { useCallback, useEffect, useRef, useState } from 'react';
import { shallowEqual, useSelector } from 'react-redux';

import type { RootState } from '@/store/index';
import type { MentionIdCacheStatus } from '@/store/mentionIdCache';
import { pickNextUnreadId } from '@/store/mentionIdCache';

export interface UnreadJumperSnapshot {
  unreadCount: number;
  ids: string[];
  status: MentionIdCacheStatus;
}

export interface UseUnreadIdJumperArgs {
  chatId: string;
  threadId?: string;
  /** Existing jump primitive (from useConversationTimeline) - fetches `around`, scrolls, highlights. */
  jumpToMessage: (messageId: string) => Promise<boolean> | void;
  showToast?: (message: string) => void;
  /** When false (feature gated off), the hook no-ops: no eager fetch, no jumps. */
  enabled?: boolean;
  /** Live badge state for the current chat/thread (mention or reaction counters). */
  selectSnapshot: (state: RootState, chatId: string, threadId?: string) => UnreadJumperSnapshot;
  /** Fetch the unread id list for the scope; resolves `{ messageIds }` newest-first. */
  fetchIds: (chatId: string, threadId?: string) => Promise<{ data: { messageIds: string[] } }>;
  setIds: (ids: string[]) => void;
  setStatus: (status: MentionIdCacheStatus) => void;
  /** Lazily-evaluated failure copy — only called when the fetch fails. */
  failureToast: () => string;
}

export interface UseUnreadIdJumperResult {
  /** True while there is at least one unread id left in the current pass. */
  canJump: boolean;
  /** Unread count, shown as the FAB badge. */
  unreadCount: number;
  /** Jump to the next unread id (oldest-first, single pass). */
  jumpToNext: () => Promise<void>;
}

/**
 * Shared engine behind the jump-to-mention and jump-to-reaction FABs. Lazily
 * fetches the unread-id list for the current chat (or thread) and walks it
 * oldest-first (chronological) on each tap, reusing the existing
 * `jumpToMessage` primitive. The pass is single-shot: once the newest id has
 * been visited the FAB hides instead of wrapping; it reappears when a fresh id
 * list arrives (a WS notification prepending to a ready cache, or an
 * invalidation + refetch). The id cache lives in chatsSlice/threadsSlice and is
 * kept fresh by WS notifications and invalidated on read-state changes. A
 * message with several new reactions appears in the pass only once — the server
 * aggregates per message.
 */
export function useUnreadIdJumper({
  chatId,
  threadId,
  jumpToMessage,
  showToast,
  enabled = true,
  selectSnapshot,
  fetchIds,
  setIds,
  setStatus,
  failureToast,
}: UseUnreadIdJumperArgs): UseUnreadIdJumperResult {
  const { unreadCount, ids, status } = useSelector(
    (state: RootState) => selectSnapshot(state, chatId, threadId),
    shallowEqual,
  );

  // Pass pointer, keyed by conversation so a chat/thread switch starts a fresh
  // pass without an effect: a stale key simply reads as `null`.
  const scopeKey = `${chatId}:${threadId ?? ''}`;
  const [passState, setPassState] = useState({ key: scopeKey, lastJumpedId: null as string | null });
  const lastJumpedId = passState.key === scopeKey ? passState.lastJumpedId : null;
  const fetchInFlightRef = useRef<Promise<string[] | null> | null>(null);
  const eagerTriedRef = useRef(false);

  // Reset the fetch guards when the conversation changes.
  useEffect(() => {
    fetchInFlightRef.current = null;
    eagerTriedRef.current = false;
  }, [chatId, threadId]);

  /** Resolves the id list, or `null` when the fetch failed (caller must not treat that as an empty pass). */
  const loadIds = useCallback((): Promise<string[] | null> => {
    if (status === 'ready') {
      return Promise.resolve(ids);
    }
    if (fetchInFlightRef.current) {
      return fetchInFlightRef.current;
    }
    setStatus('loading');
    const promise = fetchIds(chatId, threadId)
      .then(({ data }) => {
        setIds(data.messageIds);
        return data.messageIds;
      })
      .catch(() => {
        // Leave the cache invalid so the next tap retries.
        setStatus('idle');
        showToast?.(failureToast());
        return null;
      })
      .finally(() => {
        fetchInFlightRef.current = null;
      });
    fetchInFlightRef.current = promise;
    return promise;
  }, [status, ids, chatId, threadId, setIds, setStatus, showToast, fetchIds, failureToast]);

  // Eagerly load the ids when the badge appears so the first tap is instant.
  // `eagerTriedRef` prevents a refetch loop if the load fails (status resets to 'idle').
  useEffect(() => {
    if (enabled && unreadCount > 0 && status === 'idle' && !eagerTriedRef.current) {
      eagerTriedRef.current = true;
      void loadIds();
    }
  }, [enabled, unreadCount, status, loadIds]);

  // The pass is exhausted once the newest id has been visited. Derived from the
  // cache so it self-heals: a WS notification prepending a fresh id (or an
  // invalidation + refetch) flips it back to false and the FAB reappears.
  const passExhausted = ids.length > 0 && ids[0] === lastJumpedId;

  const jumpToNext = useCallback(async () => {
    if (!enabled || unreadCount <= 0) return;
    const currentIds = await loadIds();
    // A failed fetch leaves the pass untouched so the next tap can retry.
    if (!currentIds) return;
    const target = pickNextUnreadId(currentIds, lastJumpedId);
    if (!target) return;
    const jumped = await jumpToMessage(target);
    // Commit the pass pointer only when the jump landed; a failed jump (e.g. the
    // message was hard-deleted) would otherwise be skipped until the next refetch.
    if (jumped !== false) {
      setPassState({ key: scopeKey, lastJumpedId: target });
    }
  }, [enabled, unreadCount, loadIds, jumpToMessage, lastJumpedId, scopeKey]);

  return {
    canJump: enabled && unreadCount > 0 && !passExhausted,
    unreadCount,
    jumpToNext,
  };
}
