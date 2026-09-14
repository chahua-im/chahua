import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import {
  selectChatUnreadCount,
  selectChatsWithUnreadCount,
  selectHasChatsWithUnreadMentions,
} from '@/store/chatsSlice';
import {
  selectThreadUnreadCount,
  selectThreadsWithUnreadCount,
  selectHasThreadsWithUnreadMentions,
} from '@/store/threadsSlice';
import { isFeatureEnabled } from '@/features';
import type { RootState } from '@/store';
import { isPageHidden } from '@/utils/dom';

const BASE_TITLE = '茶话';
const TITLE_COUNT_PREFIX = /^\((?:\d+|@)\)\s*/;

/** Everything updateTitle() reads, kept in one ref so visibility listeners always see the latest values. */
interface TitleInputs {
  activeChatId: string | undefined;
  activeThreadId: string | undefined;
  chatUnreadCount: number;
  threadUnreadCount: number;
  chatsWithUnread: number;
  threadsWithUnread: number;
  hasUnreadMentions: boolean;
}

export function useDocumentTitle(activeChatId: string | undefined, activeThreadId?: string): void {
  const chatUnreadCount = useSelector((state: RootState) =>
    activeChatId ? selectChatUnreadCount(state, activeChatId) : 0,
  );
  const threadUnreadCount = useSelector((state: RootState) =>
    activeThreadId ? selectThreadUnreadCount(state, activeThreadId) : 0,
  );
  const chatsWithUnread = useSelector(selectChatsWithUnreadCount);
  const threadsWithUnread = useSelector(selectThreadsWithUnreadCount);
  const chatsHaveMentions = useSelector(selectHasChatsWithUnreadMentions);
  const threadsHaveMentions = useSelector(selectHasThreadsWithUnreadMentions);
  const hasUnreadMentions = isFeatureEnabled('mentionNotifications') && (chatsHaveMentions || threadsHaveMentions);

  const baseTitleRef = useRef((document.title || '').replace(TITLE_COUNT_PREFIX, '') || BASE_TITLE);
  const inputsRef = useRef<TitleInputs>({
    activeChatId,
    activeThreadId,
    chatUnreadCount,
    threadUnreadCount,
    chatsWithUnread,
    threadsWithUnread,
    hasUnreadMentions,
  });

  function updateTitle() {
    const inputs = inputsRef.current;
    if (isPageHidden()) {
      const count = inputs.activeThreadId
        ? inputs.threadUnreadCount
        : inputs.activeChatId
          ? inputs.chatUnreadCount
          : inputs.chatsWithUnread + inputs.threadsWithUnread;
      if (inputs.hasUnreadMentions) {
        document.title = `(@) ${baseTitleRef.current}`;
      } else {
        document.title = count > 0 ? `(${count}) ${baseTitleRef.current}` : baseTitleRef.current;
      }
    } else {
      document.title = baseTitleRef.current;
    }
  }

  // Register visibility listeners once; handlers read latest counts from refs.
  useEffect(() => {
    updateTitle();

    document.addEventListener('visibilitychange', updateTitle);
    window.addEventListener('focus', updateTitle);
    window.addEventListener('blur', updateTitle);

    return () => {
      document.removeEventListener('visibilitychange', updateTitle);
      window.removeEventListener('focus', updateTitle);
      window.removeEventListener('blur', updateTitle);
    };
  }, []);

  // Keep the inputs ref in sync and update title when the active chat changes
  // (handles navigation while the page is hidden).
  useEffect(() => {
    inputsRef.current = {
      activeChatId,
      activeThreadId,
      chatUnreadCount,
      threadUnreadCount,
      chatsWithUnread,
      threadsWithUnread,
      hasUnreadMentions,
    };
    updateTitle();
  }, [
    activeChatId,
    activeThreadId,
    chatUnreadCount,
    threadUnreadCount,
    chatsWithUnread,
    threadsWithUnread,
    hasUnreadMentions,
  ]);
}
