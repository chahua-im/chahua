import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { selectChatUnreadCount, selectChatsWithUnreadCount } from '@/store/chatsSlice';
import { selectThreadUnreadCount, selectThreadsWithUnreadCount } from '@/store/threadsSlice';
import type { RootState } from '@/store';
import { isPageHidden } from '@/utils/dom';

const BASE_TITLE = '茶话';

export function useDocumentTitle(activeChatId: string | undefined, activeThreadId?: string): void {
  const chatUnreadCount = useSelector((state: RootState) =>
    activeChatId ? selectChatUnreadCount(state, activeChatId) : 0,
  );
  const threadUnreadCount = useSelector((state: RootState) =>
    activeThreadId ? selectThreadUnreadCount(state, activeThreadId) : 0,
  );
  const chatsWithUnread = useSelector(selectChatsWithUnreadCount);
  const threadsWithUnread = useSelector(selectThreadsWithUnreadCount);

  const activeChatIdRef = useRef(activeChatId);
  const activeThreadIdRef = useRef(activeThreadId);
  const chatUnreadCountRef = useRef(chatUnreadCount);
  const threadUnreadCountRef = useRef(threadUnreadCount);
  const chatsWithUnreadRef = useRef(chatsWithUnread);
  const threadsWithUnreadRef = useRef(threadsWithUnread);
  const baseTitleRef = useRef(document.title || BASE_TITLE);

  function updateTitle() {
    if (isPageHidden()) {
      const count = activeThreadIdRef.current
        ? threadUnreadCountRef.current
        : activeChatIdRef.current
          ? chatUnreadCountRef.current
          : chatsWithUnreadRef.current + threadsWithUnreadRef.current;
      document.title = count > 0 ? `(${count}) ${baseTitleRef.current}` : baseTitleRef.current;
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

  // Keep refs in sync and update title when the active chat changes
  // (handles navigation while the page is hidden).
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
    activeThreadIdRef.current = activeThreadId;
    chatUnreadCountRef.current = chatUnreadCount;
    threadUnreadCountRef.current = threadUnreadCount;
    chatsWithUnreadRef.current = chatsWithUnread;
    threadsWithUnreadRef.current = threadsWithUnread;
    updateTitle();
  }, [activeChatId, activeThreadId, chatUnreadCount, threadUnreadCount, chatsWithUnread, threadsWithUnread]);
}
