import { useCallback } from 'react';
import { t } from '@lingui/core/macro';
import { useDispatch } from 'react-redux';

import { getUnreadReactionIds } from '@/api/chats';
import {
  selectChatUnreadReactionIds,
  selectChatUnreadReactionIdsStatus,
  selectChatUnreadReactions,
  setChatUnreadReactionIds,
  setChatUnreadReactionIdsStatus,
} from '@/store/chatsSlice';
import {
  selectThreadUnreadReactionIds,
  selectThreadUnreadReactionIdsStatus,
  selectThreadUnreadReactions,
  setThreadUnreadReactionIds,
  setThreadUnreadReactionIdsStatus,
} from '@/store/threadsSlice';
import type { RootState } from '@/store/index';
import { useUnreadIdJumper } from './useUnreadIdJumper';

export interface UseReactionJumperArgs {
  chatId: string;
  threadId?: string;
  /** Existing jump primitive (from useConversationTimeline) - fetches `around`, scrolls, highlights. */
  jumpToMessage: (messageId: string) => Promise<boolean> | void;
  showToast?: (message: string) => void;
  /** When false (feature gated off), the hook no-ops: no eager fetch, no jumps. */
  enabled?: boolean;
}

export interface UseReactionJumperResult {
  /** True when there is at least one message with new reactions to jump to. */
  canJump: boolean;
  /** Unread-reaction message count, shown as the FAB badge. */
  unreadCount: number;
  /** Jump to the next message with new reactions (oldest-first, single pass). */
  jumpToNextReaction: () => Promise<void>;
}

/**
 * Thin reaction-specific wiring over the shared unread-id jumper engine.
 * Unlike mentions, one message can carry several new reactions but appears in
 * the pass only once (the server aggregates per message).
 */
export function useReactionJumper({
  chatId,
  threadId,
  jumpToMessage,
  showToast,
  enabled = true,
}: UseReactionJumperArgs): UseReactionJumperResult {
  const dispatch = useDispatch();

  const selectSnapshot = useCallback(
    (state: RootState, chatId: string, threadId?: string) =>
      threadId
        ? {
            unreadCount: selectThreadUnreadReactions(state, threadId),
            ids: selectThreadUnreadReactionIds(state, threadId),
            status: selectThreadUnreadReactionIdsStatus(state, threadId),
          }
        : {
            unreadCount: selectChatUnreadReactions(state, chatId),
            ids: selectChatUnreadReactionIds(state, chatId),
            status: selectChatUnreadReactionIdsStatus(state, chatId),
          },
    [],
  );
  const fetchIds = useCallback((chatId: string, threadId?: string) => getUnreadReactionIds(chatId, { threadId }), []);
  const setIds = useCallback(
    (ids: string[]) => {
      if (threadId) {
        dispatch(setThreadUnreadReactionIds({ threadRootId: threadId, ids }));
      } else {
        dispatch(setChatUnreadReactionIds({ chatId, ids }));
      }
    },
    [dispatch, chatId, threadId],
  );
  const setStatus = useCallback(
    (status: 'idle' | 'loading' | 'ready') => {
      if (threadId) {
        dispatch(setThreadUnreadReactionIdsStatus({ threadRootId: threadId, status }));
      } else {
        dispatch(setChatUnreadReactionIdsStatus({ chatId, status }));
      }
    },
    [dispatch, chatId, threadId],
  );
  const failureToast = useCallback(() => t`Failed to load reactions`, []);

  const { canJump, unreadCount, jumpToNext } = useUnreadIdJumper({
    chatId,
    threadId,
    jumpToMessage,
    showToast,
    enabled,
    selectSnapshot,
    fetchIds,
    setIds,
    setStatus,
    failureToast,
  });

  return {
    canJump,
    unreadCount,
    jumpToNextReaction: jumpToNext,
  };
}
