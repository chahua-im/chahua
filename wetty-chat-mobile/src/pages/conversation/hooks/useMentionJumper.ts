import { useCallback, useEffect, useRef } from 'react';
import { t } from '@lingui/core/macro';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';

import { getUnreadMentionIds } from '@/api/chats';
import {
  selectChatUnreadMentionIds,
  selectChatUnreadMentionIdsStatus,
  selectChatUnreadMentions,
  setChatUnreadMentionIds,
  setChatUnreadMentionIdsStatus,
} from '@/store/chatsSlice';
import {
  selectThreadUnreadMentionIds,
  selectThreadUnreadMentionIdsStatus,
  selectThreadUnreadMentions,
  setThreadUnreadMentionIds,
  setThreadUnreadMentionIdsStatus,
} from '@/store/threadsSlice';
import type { RootState } from '@/store/index';
import type { MentionIdCacheStatus } from '@/store/mentionIdCache';

export interface UseMentionJumperArgs {
  chatId: string;
  threadId?: string;
  /** Existing jump primitive (from useConversationTimeline) - fetches `around`, scrolls, highlights. */
  jumpToMessage: (messageId: string) => Promise<boolean> | void;
  showToast?: (message: string) => void;
  /** When false (feature gated off), the hook no-ops: no eager fetch, no jumps. */
  enabled?: boolean;
}

export interface UseMentionJumperResult {
  /** True when there is at least one unread mention to jump to. */
  canJump: boolean;
  /** Unread-mention count, shown as the FAB badge. */
  unreadCount: number;
  /** Jump to the next unread mention (oldest-first, cycling). */
  jumpToNextMention: () => Promise<void>;
}

interface MentionJumperSnapshot {
  unreadCount: number;
  ids: string[];
  status: MentionIdCacheStatus;
}

function selectChatMentionSnapshot(state: RootState, chatId: string): MentionJumperSnapshot {
  return {
    unreadCount: selectChatUnreadMentions(state, chatId),
    ids: selectChatUnreadMentionIds(state, chatId),
    status: selectChatUnreadMentionIdsStatus(state, chatId),
  };
}

function selectThreadMentionSnapshot(state: RootState, threadRootId: string): MentionJumperSnapshot {
  return {
    unreadCount: selectThreadUnreadMentions(state, threadRootId),
    ids: selectThreadUnreadMentionIds(state, threadRootId),
    status: selectThreadUnreadMentionIdsStatus(state, threadRootId),
  };
}

/**
 * Pick the next unread mention to jump to. `ids` are newest-first (descending), so the oldest
 * mention is the last element.
 *
 * Rule: visit mentions in chronological order (oldest -> newest), wrapping to the oldest when
 * the newest is reached, or when `lastJumpedId` is no longer in the list (e.g. after mark-read
 * shrank it). Returns `null` when there are no ids.
 */
export function pickNextMention(ids: string[], lastJumpedId: string | null): string | null {
  if (ids.length === 0) return null;
  // ids are newest-first, so the oldest is the last element - start there.
  const oldest = ids[ids.length - 1];
  if (lastJumpedId === null) return oldest;
  const idx = ids.indexOf(lastJumpedId);
  if (idx === -1) return oldest;
  // idx - 1 moves toward the newer end (front of the array); wrap to oldest past the newest.
  return ids[idx - 1] ?? oldest;
}

/**
 * Drives the "jump to mention" FAB. Lazily fetches the list of unread-mention message ids for the
 * current chat (or thread) and cycles through them oldest-first (chronological) on each tap, reusing the existing
 * `jumpToMessage` primitive. The id cache lives in chatsSlice/threadsSlice and is kept fresh by WS
 * mention notifications (which prepend) and invalidated on read-state changes.
 */
export function useMentionJumper({
  chatId,
  threadId,
  jumpToMessage,
  showToast,
  enabled = true,
}: UseMentionJumperArgs): UseMentionJumperResult {
  const dispatch = useDispatch();
  const { unreadCount, ids, status } = useSelector(
    (state: RootState) =>
      threadId ? selectThreadMentionSnapshot(state, threadId) : selectChatMentionSnapshot(state, chatId),
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

  const setIds = useCallback(
    (nextIds: string[]) => {
      if (threadId) {
        dispatch(setThreadUnreadMentionIds({ threadRootId: threadId, ids: nextIds }));
      } else {
        dispatch(setChatUnreadMentionIds({ chatId, ids: nextIds }));
      }
    },
    [dispatch, chatId, threadId],
  );

  const setStatus = useCallback(
    (nextStatus: MentionIdCacheStatus) => {
      if (threadId) {
        dispatch(setThreadUnreadMentionIdsStatus({ threadRootId: threadId, status: nextStatus }));
      } else {
        dispatch(setChatUnreadMentionIdsStatus({ chatId, status: nextStatus }));
      }
    },
    [dispatch, chatId, threadId],
  );

  const loadMentionIds = useCallback((): Promise<string[]> => {
    if (status === 'ready') {
      return Promise.resolve(ids);
    }
    if (fetchInFlightRef.current) {
      return fetchInFlightRef.current;
    }
    setStatus('loading');
    const promise = getUnreadMentionIds(chatId, { threadId })
      .then(({ data }) => {
        setIds(data.messageIds);
        return data.messageIds;
      })
      .catch(() => {
        // Leave the cache invalid so the next tap retries.
        setStatus('idle');
        showToast?.(t`Failed to load mentions`);
        return [] as string[];
      })
      .finally(() => {
        fetchInFlightRef.current = null;
      });
    fetchInFlightRef.current = promise;
    return promise;
  }, [status, ids, chatId, threadId, setIds, setStatus, showToast]);

  // Eagerly load the mention ids when the badge appears so the first tap is instant.
  // `eagerTriedRef` prevents a refetch loop if the load fails (status resets to 'idle').
  useEffect(() => {
    if (enabled && unreadCount > 0 && status === 'idle' && !eagerTriedRef.current) {
      eagerTriedRef.current = true;
      void loadMentionIds();
    }
  }, [enabled, unreadCount, status, loadMentionIds]);

  const jumpToNextMention = useCallback(async () => {
    if (!enabled || unreadCount <= 0) return;
    const currentIds = await loadMentionIds();
    const target = pickNextMention(currentIds, lastJumpedIdRef.current);
    if (!target) return;
    const jumped = await jumpToMessage(target);
    // Commit the cycle pointer only when the jump landed; a failed jump (e.g. the
    // message was hard-deleted) would otherwise be skipped until the next wrap.
    if (jumped !== false) {
      lastJumpedIdRef.current = target;
    }
  }, [enabled, unreadCount, loadMentionIds, jumpToMessage]);

  return {
    canJump: enabled && unreadCount > 0,
    unreadCount,
    jumpToNextMention,
  };
}
