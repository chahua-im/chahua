import { useCallback, useEffect, useRef } from 'react';
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
  /** True when there is at least one unread id to jump to. */
  canJump: boolean;
  /** Unread count, shown as the FAB badge. */
  unreadCount: number;
  /** Jump to the next unread id (oldest-first, cycling). */
  jumpToNext: () => Promise<void>;
}

/**
 * Shared engine behind the jump-to-mention and jump-to-reaction FABs. Lazily
 * fetches the unread-id list for the current chat (or thread) and cycles
 * through it oldest-first (chronological) on each tap, reusing the existing
 * `jumpToMessage` primitive. The id cache lives in chatsSlice/threadsSlice and
 * is kept fresh by WS notifications (which prepend) and invalidated on
 * read-state changes. A message with several new reactions appears in the
 * cycle only once — the server aggregates per message.
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

  const lastJumpedIdRef = useRef<string | null>(null);
  const fetchInFlightRef = useRef<Promise<string[]> | null>(null);
  const eagerTriedRef = useRef(false);

  // Reset the cycle pointer + fetch guards when the conversation changes.
  useEffect(() => {
    lastJumpedIdRef.current = null;
    fetchInFlightRef.current = null;
    eagerTriedRef.current = false;
  }, [chatId, threadId]);

  const loadIds = useCallback((): Promise<string[]> => {
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
        return [] as string[];
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

  const jumpToNext = useCallback(async () => {
    if (!enabled || unreadCount <= 0) return;
    const currentIds = await loadIds();
    const target = pickNextUnreadId(currentIds, lastJumpedIdRef.current);
    if (!target) return;
    const jumped = await jumpToMessage(target);
    // Commit the cycle pointer only when the jump landed; a failed jump (e.g. the
    // message was hard-deleted) would otherwise be skipped until the next wrap.
    if (jumped !== false) {
      lastJumpedIdRef.current = target;
    }
  }, [enabled, unreadCount, loadIds, jumpToMessage]);

  return {
    canJump: enabled && unreadCount > 0,
    unreadCount,
    jumpToNext,
  };
}
