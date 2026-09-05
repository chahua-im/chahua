import { getMessages } from '@/api/messages';
import { selectAllChats } from '@/store/chatsSlice';
import { refreshChatList, refreshThreadList } from '@/store/listPagination';
import { insertAfterAnchor } from '@/store/messages/slice';
import { selectLatestServerMessage } from '@/store/messages/selectors';
import store from '@/store/index';
import { syncAppBadgeCount } from '@/utils/badges';
import { APP_SYNC_DEBOUNCE_MS } from '@/constants/chatTiming';

let isSyncing = false;
let syncTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Robustly synchronizes the app state when coming to the foreground or reconnecting.
 * - Fetches the latest chats list (updating previews and unread counts).
 * - Updates the system app badge.
 * - Checks currently loaded latest timelines and fetches any missing messages
 *   (appending them seamlessly so as not to disrupt a user scrolling history).
 */
export async function syncApp() {
  // Debounce multiple concurrent triggers (e.g. visibilitychange + ws.onopen)
  if (syncTimeout) clearTimeout(syncTimeout);

  syncTimeout = setTimeout(async () => {
    // Abort if already syncing, if app is in background, or user is not logged in.
    if (isSyncing) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (!store.getState().user.uid) return;

    isSyncing = true;
    try {
      // 1. Refresh every independent list bucket at its currently loaded depth, then refresh the app badge.
      await Promise.all([
        store.dispatch(refreshChatList(false)),
        store.dispatch(refreshChatList(true)),
        store.dispatch(refreshThreadList(false)),
        store.dispatch(refreshThreadList(true)),
      ]);

      await syncAppBadgeCount();

      // 2. Sync loaded latest message timelines
      const state = store.getState();
      const activeChats = state.messages.chats;
      const chats = selectAllChats(state);

      for (const [storeChatId, chatState] of Object.entries(activeChats)) {
        if (!chatState.hasReachedLatest) continue;

        // Get last real (non-optimistic) message in the latest canonical segment
        const lastMsg = selectLatestServerMessage(store.getState(), storeChatId);
        if (!lastMsg || lastMsg.id.startsWith('cg_')) continue;

        let apiChatId = storeChatId;
        let threadId: string | undefined = undefined;

        if (storeChatId.includes('_thread_')) {
          const parts = storeChatId.split('_thread_');
          apiChatId = parts[0];
          threadId = parts[1];
        } else {
          const chatListItem = chats.find((chat) => chat.id === apiChatId);
          if (chatListItem && chatListItem.lastMessage) {
            const serverId = BigInt(chatListItem.lastMessage.id);
            const localId = BigInt(lastMsg.id);
            if (serverId <= localId) {
              continue; // Local state is up to date for this chat
            }
          }
        }

        // Fetch missing newer messages for this chat/thread
        try {
          const messagesRes = await getMessages(apiChatId, {
            after: lastMsg.id,
            max: 50,
            threadId,
          });

          if (messagesRes.data.messages && messagesRes.data.messages.length > 0) {
            store.dispatch(
              insertAfterAnchor({
                chatId: storeChatId,
                anchorMessageId: lastMsg.id,
                messages: messagesRes.data.messages,
                newerCursor: messagesRes.data.newerCursor ?? null,
              }),
            );
          } else if (messagesRes.data.newerCursor !== undefined) {
            // No new messages, but update the newer cursor just in case
            store.dispatch(
              insertAfterAnchor({
                chatId: storeChatId,
                anchorMessageId: lastMsg.id,
                messages: [],
                newerCursor: messagesRes.data.newerCursor ?? null,
              }),
            );
          }
        } catch (err) {
          console.error(`Failed to sync messages for ${storeChatId}`, err);
        }
      }
    } catch (err) {
      console.error('Failed to sync app state', err);
    } finally {
      isSyncing = false;
    }
  }, APP_SYNC_DEBOUNCE_MS);
}
