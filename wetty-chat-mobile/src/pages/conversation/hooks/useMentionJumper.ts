import { useCallback } from 'react';
import { t } from '@lingui/core/macro';
import { useDispatch } from 'react-redux';

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
import { useUnreadIdJumper } from './useUnreadIdJumper';

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
  /** Jump to the next unread mention (oldest-first, single pass). */
  jumpToNextMention: () => Promise<void>;
}

/** Thin mention-specific wiring over the shared unread-id jumper engine. */
export function useMentionJumper({
  chatId,
  threadId,
  jumpToMessage,
  showToast,
  enabled = true,
}: UseMentionJumperArgs): UseMentionJumperResult {
  const dispatch = useDispatch();

  const selectSnapshot = useCallback(
    (state: RootState, chatId: string, threadId?: string) =>
      threadId
        ? {
            unreadCount: selectThreadUnreadMentions(state, threadId),
            ids: selectThreadUnreadMentionIds(state, threadId),
            status: selectThreadUnreadMentionIdsStatus(state, threadId),
          }
        : {
            unreadCount: selectChatUnreadMentions(state, chatId),
            ids: selectChatUnreadMentionIds(state, chatId),
            status: selectChatUnreadMentionIdsStatus(state, chatId),
          },
    [],
  );
  const fetchIds = useCallback((chatId: string, threadId?: string) => getUnreadMentionIds(chatId, { threadId }), []);
  const setIds = useCallback(
    (ids: string[]) => {
      if (threadId) {
        dispatch(setThreadUnreadMentionIds({ threadRootId: threadId, ids }));
      } else {
        dispatch(setChatUnreadMentionIds({ chatId, ids }));
      }
    },
    [dispatch, chatId, threadId],
  );
  const setStatus = useCallback(
    (status: 'idle' | 'loading' | 'ready') => {
      if (threadId) {
        dispatch(setThreadUnreadMentionIdsStatus({ threadRootId: threadId, status }));
      } else {
        dispatch(setChatUnreadMentionIdsStatus({ chatId, status }));
      }
    },
    [dispatch, chatId, threadId],
  );
  const failureToast = useCallback(() => t`Failed to load mentions`, []);

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
    jumpToNextMention: jumpToNext,
  };
}
