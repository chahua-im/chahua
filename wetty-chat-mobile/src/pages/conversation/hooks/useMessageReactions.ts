import { useCallback, useMemo } from 'react';
import { t } from '@lingui/core/macro';
import { useDispatch, useSelector } from 'react-redux';
import { deleteReaction, putReaction, type MessageResponse } from '@/api/messages';
import { apiErrorMessage } from '@/api/errors';
import { MAX_PINNED_REACTIONS, MAX_REACTIONS_PER_USER_PER_MESSAGE } from '@/constants/emojiAndStickers';
import type { RootState } from '@/store';
import { reactionsUpdated } from '@/store/messageEvents';
import { addRecentReaction, selectPinnedReactions, selectRecentReactions } from '@/store/settingsSlice';

interface UseMessageReactionsArgs {
  chatId: string;
  showToast: (text: string, duration?: number) => void;
  /** When true (e.g. dead DM), reaction toggling is a no-op. */
  disabled?: boolean;
}

export function useMessageReactions({ chatId, showToast, disabled = false }: UseMessageReactionsArgs) {
  const dispatch = useDispatch();
  const pinnedReactions = useSelector((state: RootState) => selectPinnedReactions(state));
  const recentReactions = useSelector((state: RootState) => selectRecentReactions(state));

  const quickReactionEmojis = useMemo(() => {
    return [...pinnedReactions, ...recentReactions.filter((reaction) => !pinnedReactions.includes(reaction))].slice(
      0,
      MAX_PINNED_REACTIONS,
    );
  }, [pinnedReactions, recentReactions]);

  const handleReactionToggle = useCallback(
    (message: MessageResponse, emoji: string, currentlyReacted: boolean) => {
      if (disabled) return;
      const existing = message.reactions ?? [];
      let optimistic: typeof existing;

      if (currentlyReacted) {
        optimistic = existing
          .map((reaction) =>
            reaction.emoji === emoji ? { ...reaction, count: reaction.count - 1, reactedByMe: false } : reaction,
          )
          .filter((reaction) => reaction.count > 0);
        deleteReaction(chatId, message.id, emoji).catch((err: unknown) => {
          dispatch(reactionsUpdated({ chatId, messageId: message.id, reactions: existing }));
          showToast(apiErrorMessage(err, t`Failed to remove reaction`), 2000);
        });
      } else {
        const myReactionsCount = existing.filter((reaction) => reaction.reactedByMe).length;
        if (myReactionsCount >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
          showToast(t`You can only add up to ${MAX_REACTIONS_PER_USER_PER_MESSAGE} reactions`, 2000);
          return;
        }

        const found = existing.find((reaction) => reaction.emoji === emoji);
        if (found) {
          optimistic = existing.map((reaction) =>
            reaction.emoji === emoji ? { ...reaction, count: reaction.count + 1, reactedByMe: true } : reaction,
          );
        } else {
          optimistic = [...existing, { emoji, count: 1, reactedByMe: true }];
        }
        dispatch(addRecentReaction(emoji));
        putReaction(chatId, message.id, emoji).catch((err: unknown) => {
          dispatch(reactionsUpdated({ chatId, messageId: message.id, reactions: existing }));
          showToast(apiErrorMessage(err, t`Failed to react to message`), 2000);
        });
      }

      dispatch(reactionsUpdated({ chatId, messageId: message.id, reactions: optimistic }));
    },
    [chatId, dispatch, disabled, showToast],
  );

  return {
    quickReactionEmojis,
    handleReactionToggle,
  };
}
