import { useEffect } from 'react';
import { useHistory, useLocation, matchPath } from 'react-router-dom';

/**
 * Global ESC key handler for chat-level navigation.
 *
 * - In a thread → navigate to parent chat, positioned at the thread root message.
 * - In a chat   → navigate to the chat list (deselect).
 *
 * Defers when focus is inside a textarea/input or an Ionic overlay
 * (ion-alert, ion-action-sheet, ion-modal, ion-toast),
 * so compose-bar reply/edit ESC and overlay dismiss take priority.
 */
export function useEscNavigation(): void {
  const history = useHistory();
  const location = useLocation();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;

      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
        return;
      }
      // Defer to Ionic overlays (alerts, action sheets, modals, toasts) - they handle ESC internally.
      if (active?.closest('ion-alert, ion-action-sheet, ion-modal, ion-toast')) {
        return;
      }
      if (document.querySelector('ion-alert, ion-action-sheet')) {
        return;
      }
      // Defer to custom fullscreen overlays (e.g. image viewer) - they handle ESC internally.
      if (document.querySelector('[data-image-viewer]')) {
        return;
      }

      // Thread -> parent chat with #msg= scroll target
      const threadMatch = matchPath<{ id: string; threadId: string }>(location.pathname, {
        path: '/chats/chat/:id/thread/:threadId',
        exact: true,
      });
      if (threadMatch) {
        const { id, threadId } = threadMatch.params;
        history.replace({ pathname: `/chats/chat/${id}`, hash: `#msg=${threadId}` });
        return;
      }

      // Chat -> chat list
      const chatMatch = matchPath(location.pathname, { path: '/chats/chat/:id', exact: true });
      if (chatMatch) {
        history.replace('/chats');
        return;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [history, location.pathname]);
}
