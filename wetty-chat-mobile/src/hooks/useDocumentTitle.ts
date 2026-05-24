import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { selectChatUnreadCount, selectChatsWithUnreadCount } from '@/store/chatsSlice';
import type { RootState } from '@/store';
import { isPageHidden } from '@/utils/dom';

const BASE_TITLE = '茶话';

export function useDocumentTitle(activeChatId: string | undefined): void {
  const chatUnreadCount = useSelector((state: RootState) =>
    activeChatId ? selectChatUnreadCount(state, activeChatId) : 0,
  );
  const chatsWithUnread = useSelector(selectChatsWithUnreadCount);

  const activeChatIdRef = useRef(activeChatId);
  const chatUnreadCountRef = useRef(chatUnreadCount);
  const chatsWithUnreadRef = useRef(chatsWithUnread);
  const baseTitleRef = useRef(document.title || BASE_TITLE);

  function updateTitle() {
    if (isPageHidden()) {
      const count = activeChatIdRef.current ? chatUnreadCountRef.current : chatsWithUnreadRef.current;
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
    chatUnreadCountRef.current = chatUnreadCount;
    chatsWithUnreadRef.current = chatsWithUnread;
    updateTitle();
  }, [activeChatId, chatUnreadCount, chatsWithUnread]);
}
