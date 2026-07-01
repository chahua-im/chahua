import { combineReducers, configureStore, createListenerMiddleware } from '@reduxjs/toolkit';
import connectionReducer from './connectionSlice';
import { getMessages } from '@/api/messages';
import messagesReducer, { updateThreadReplyCount, refreshLatest } from './messages/slice';
import settingsReducer, { type SettingsState } from './settingsSlice';
import stickerPreferencesReducer, {
  hydrateStickerPreferencesFromKv,
  removeStickerPackOrderItem,
  replaceStickerPackOrderFromWs,
  setAutoSortEnabled,
  setAutoSortFavoritesEnabled,
  syncStickerPackOrder,
  upsertStickerPackOrderItem,
  upsertFavoriteStickerOrderItem,
  type StickerPreferencesState,
} from './stickerPreferencesSlice';
import threadsReducer, {
  incrementThreadUnread,
  updateThreadCachedLastReply,
  patchThreadCachedLastReply,
  patchThreadRootMessage,
  updateThreadFromWs,
} from './threadsSlice';
import chatsReducer, {
  projectChatMessageAdded,
  projectChatMessageConfirmed,
  projectChatMessagePatched,
} from './chatsSlice';
import pinsReducer from './pinsSlice';
import userReducer, { fetchCurrentUser } from './userSlice';
import { toMessagePreview, type MessagePreview, type MessageResponse } from '@/api/messages';
import { messageAdded, messageConfirmed, messagePatched, messagesBulkDeleted } from './messageEvents';
import { findLatestEligibleRootMessage, isOptimisticMessageId } from './messageProjection';
import { selectActiveTimelineMessages, selectHasLoadedTimeline } from './messages/selectors';
import { collectTimelineSnapshot, logTimelineDiagnostic } from './messages/timelineDiagnostics';
import { kvSet } from '@/utils/db';
import { isAnyOf } from '@reduxjs/toolkit';

const listenerMiddleware = createListenerMiddleware();

function deletedThreadRootPreviewPatch(): Partial<MessagePreview> {
  return {
    isDeleted: true,
    message: null,
    sticker: null,
    attachments: [],
    mentions: [],
  };
}

listenerMiddleware.startListening({
  actionCreator: messageAdded,
  effect: async (action, api) => {
    const state = api.getState() as RootState;
    if (action.payload.origin === 'ws') {
      const { storeChatId, message } = action.payload;
      const activeMessages = selectActiveTimelineMessages(state, storeChatId);
      const pendingLiveMessageIds = state.messages.views[storeChatId]?.pendingLiveMessageIds ?? [];
      const isVisible = activeMessages.some((current) => current.id === message.id);
      const isPendingLive = pendingLiveMessageIds.includes(message.id);
      logTimelineDiagnostic('ws-message-routing', {
        chatId: action.payload.chatId,
        storeChatId,
        scope: action.payload.scope,
        messageId: message.id,
        replyRootId: message.replyRootId,
        isVisible,
        isPendingLive,
        route: isVisible ? 'visible' : isPendingLive ? 'pending-live' : 'not-visible-not-pending',
        snapshot: collectTimelineSnapshot(state, storeChatId),
      });
    }
    api.dispatch(
      projectChatMessageAdded({
        chatId: action.payload.chatId,
        message: action.payload.message,
        incrementUnread:
          action.payload.scope === 'main' &&
          !action.payload.message.isDeleted &&
          !isOptimisticMessageId(action.payload.message.id) &&
          action.payload.message.sender.uid !== (state.user.uid ?? 0),
      }),
    );

    if (
      action.payload.scope === 'thread' &&
      action.payload.origin === 'ws' &&
      action.payload.message.replyRootId != null
    ) {
      const { message } = action.payload;
      const threadRootId = message.replyRootId!;
      const isSubscribed = state.threads.items.some((t) => t.threadRootMessage.id === threadRootId);
      if (isSubscribed) {
        if (!message.isDeleted) {
          // Only update the cached preview if the thread timeline isn't loaded
          // (when loaded, the UI derives the preview from the message timeline store)
          const storeKey = `${message.chatId}_thread_${threadRootId}`;
          const hasTimeline = selectHasLoadedTimeline(state, storeKey);
          if (!hasTimeline) {
            api.dispatch(
              updateThreadCachedLastReply({
                threadRootId,
                cachedLastReply: toMessagePreview(message),
              }),
            );
          }
        }
        if (!message.isDeleted && message.sender.uid !== (state.user.uid ?? 0)) {
          api.dispatch(incrementThreadUnread({ threadRootId }));
        }
      }
    }
  },
});

listenerMiddleware.startListening({
  actionCreator: messageConfirmed,
  effect: async (action, api) => {
    api.dispatch(
      projectChatMessageConfirmed({
        chatId: action.payload.chatId,
        clientGeneratedId: action.payload.clientGeneratedId,
        message: action.payload.message,
      }),
    );

    // Update thread list preview when the current user's own message is confirmed
    if (action.payload.scope === 'thread' && action.payload.message.replyRootId != null) {
      const { message } = action.payload;
      const threadRootId = message.replyRootId!;
      const state = api.getState() as RootState;
      const isSubscribed = state.threads.items.some((t) => t.threadRootMessage.id === threadRootId);
      if (isSubscribed && !message.isDeleted) {
        const storeKey = `${message.chatId}_thread_${threadRootId}`;
        const hasTimeline = selectHasLoadedTimeline(state, storeKey);
        if (!hasTimeline) {
          api.dispatch(
            updateThreadCachedLastReply({
              threadRootId,
              cachedLastReply: toMessagePreview(message),
            }),
          );
        }
      }
    }
  },
});

listenerMiddleware.startListening({
  actionCreator: messagePatched,
  effect: async (action, api) => {
    const state = api.getState() as RootState;
    api.dispatch(
      projectChatMessagePatched({
        chatId: action.payload.chatId,
        messageId: action.payload.messageId,
        message: action.payload.message,
        fallbackMessage: action.payload.message.isDeleted
          ? findLatestEligibleRootMessage(
              state.messages.chats[action.payload.chatId]?.segments,
              action.payload.messageId,
            )
          : null,
      }),
    );

    // Handle thread root deletion — keep the thread reachable with a redacted root preview.
    if (action.payload.message.isDeleted && !action.payload.message.replyRootId) {
      const thread = state.threads.items.find((t) => t.threadRootMessage.id === action.payload.messageId);
      if (thread) {
        api.dispatch(
          patchThreadRootMessage({
            threadRootId: action.payload.messageId,
            message: deletedThreadRootPreviewPatch(),
          }),
        );
      }
    }

    // Handle thread root edit (not delete) — update the root message preview
    if (!action.payload.message.isDeleted && !action.payload.message.replyRootId) {
      const thread = state.threads.items.find((t) => t.threadRootMessage.id === action.payload.messageId);
      if (thread) {
        api.dispatch(
          patchThreadRootMessage({
            threadRootId: action.payload.messageId,
            message: {
              message: action.payload.message.message,
              isDeleted: action.payload.message.isDeleted,
            },
          }),
        );
      }
    }

    // Handle thread reply edit/delete — update cache only if window not loaded
    if (action.payload.message.replyRootId) {
      const threadRootId = action.payload.message.replyRootId;
      const storeKey = `${action.payload.chatId}_thread_${threadRootId}`;
      const hasTimeline = selectHasLoadedTimeline(state, storeKey);
      if (!hasTimeline) {
        const thread = state.threads.items.find((t) => t.threadRootMessage.id === threadRootId);
        if (thread?.cachedLastReply) {
          api.dispatch(
            patchThreadCachedLastReply({
              threadRootId,
              patch: {
                message: action.payload.message.message,
                isDeleted: action.payload.message.isDeleted,
              },
            }),
          );
        }
      }
    }
  },
});

listenerMiddleware.startListening({
  actionCreator: updateThreadFromWs,
  effect: async (action, api) => {
    const { threadRootId, chatId, replyCount } = action.payload;
    api.dispatch(updateThreadReplyCount({ chatId, threadRootId, replyCount }));

    // When all replies are deleted and the thread is removed from the list,
    // refresh the parent chat timeline so the root message's threadInfo is cleared.
    if (replyCount === 0) {
      try {
        const res = await getMessages(chatId);
        const list = res.data.messages ?? [];
        api.dispatch(
          refreshLatest({
            chatId,
            messages: list,
            nextCursor: res.data.nextCursor ?? null,
            prevCursor: null,
          }),
        );
      } catch {
        // silent — timeline will refresh on next visit
      }
    }
  },
});

listenerMiddleware.startListening({
  actionCreator: messagesBulkDeleted,
  effect: async (action, api) => {
    const state = api.getState() as RootState;
    const { chatId, messageIds } = action.payload;
    const idSet = new Set(messageIds);

    // Update chat list preview — find the new latest eligible message
    const fallbackMessage = findLatestEligibleRootMessage(state.messages.chats[chatId]?.segments);
    if (fallbackMessage) {
      api.dispatch(
        projectChatMessagePatched({
          chatId,
          messageId: messageIds[0],
          message: { isDeleted: true } as MessageResponse,
          fallbackMessage,
        }),
      );
    }

    // Mark deleted thread roots without clearing their subscription/list entries.
    for (const thread of state.threads.items) {
      if (idSet.has(thread.threadRootMessage.id)) {
        api.dispatch(
          patchThreadRootMessage({
            threadRootId: thread.threadRootMessage.id,
            message: deletedThreadRootPreviewPatch(),
          }),
        );
      }
    }
  },
});

listenerMiddleware.startListening({
  matcher: isAnyOf(
    fetchCurrentUser.fulfilled,
    hydrateStickerPreferencesFromKv,
    removeStickerPackOrderItem,
    replaceStickerPackOrderFromWs,
    setAutoSortEnabled,
    setAutoSortFavoritesEnabled,
    upsertStickerPackOrderItem,
    upsertFavoriteStickerOrderItem,
  ),
  effect: async (_action, api) => {
    const state = api.getState() as RootState;
    const { packOrder, autoSortEnabled, favoriteStickerOrder, autoSortFavoritesEnabled } = state.stickerPreferences;
    await Promise.all([
      kvSet('stickerPackOrder', packOrder),
      kvSet('autoSortStickerPacks', autoSortEnabled),
      kvSet('favoriteStickerOrder', favoriteStickerOrder),
      kvSet('autoSortFavoriteStickers', autoSortFavoritesEnabled),
    ]);
  },
});

listenerMiddleware.startListening({
  actionCreator: syncStickerPackOrder.rejected,
  effect: async (action) => {
    console.error('Failed to sync sticker pack order', action.payload ?? action.error.message);
  },
});

const rootReducer = combineReducers({
  connection: connectionReducer,
  messages: messagesReducer,
  settings: settingsReducer,
  stickerPreferences: stickerPreferencesReducer,
  chats: chatsReducer,
  threads: threadsReducer,
  pins: pinsReducer,
  user: userReducer,
});

export function createStore(initialSettings?: SettingsState, initialStickerPreferences?: StickerPreferencesState) {
  const preloadedState =
    initialSettings || initialStickerPreferences
      ? {
          ...(initialSettings ? { settings: initialSettings } : {}),
          ...(initialStickerPreferences ? { stickerPreferences: initialStickerPreferences } : {}),
        }
      : undefined;

  return configureStore({
    reducer: rootReducer,
    ...(preloadedState ? { preloadedState } : {}),
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().prepend(listenerMiddleware.middleware),
  });
}

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];

/**
 * Module-level store reference for non-React code (ws.ts, sync.ts, etc.).
 * Set once during bootstrap via `setStoreInstance()`.
 */
let storeInstance: AppStore | null = null;

export function setStoreInstance(s: AppStore) {
  storeInstance = s;
}

/** Prefer useSelector/useDispatch in React components.
 *  Use for imperative code only. */
const store = new Proxy({} as AppStore, {
  get(_target, prop: keyof AppStore) {
    if (!storeInstance) throw new Error('Store not initialized yet');
    return storeInstance[prop];
  },
});

export default store;
