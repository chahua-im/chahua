import { createSlice } from '@reduxjs/toolkit';
import type { MessageResponse } from '@/api/messages';
import {
  messageAdded,
  messageConfirmed,
  messagePatched,
  messagesBulkDeleted,
  reactionsUpdated,
} from '../messageEvents';
import { compareMessageOrder } from '../messageProjection';
import {
  activeSegment,
  clearPendingLiveForLoadedMessages,
  DEFAULT_TIMELINE_MODE,
  getChat,
  getView,
  insertServerMessageIntoLatest,
  isOptimisticMessage,
  isSameLogicalMessage,
  makeServerSegment,
  normalizeAfterAnchorSegments,
  normalizeAroundSegments,
  normalizeBeforeAnchorSegments,
  normalizeLatestSegments,
  removeLogicalMessage,
  upsertOptimisticMessage,
  updateLoadedServerMessage,
} from './timelineAlgorithms';
import type { ChatTimelineState, MessagesState, TimelineMode, TimelineViewState } from './types';

function isActiveViewAtLatestEdge(chat: ChatTimelineState, view: TimelineViewState): boolean {
  if (!chat.hasReachedLatest) return false;
  if (view.mode.type === 'latest') return true;
  return activeSegment(chat, view)?.prevCursor === null;
}

const initialState: MessagesState = {
  chats: {},
  views: {},
};

const messagesSlice = createSlice({
  name: 'messages',
  initialState,
  reducers: {
    resetChat(
      state,
      action: {
        payload: { chatId: string; messages: MessageResponse[]; nextCursor: string | null; prevCursor: string | null };
      },
    ) {
      const { chatId, messages, nextCursor, prevCursor } = action.payload;
      const prevGen = state.chats[chatId]?.generation ?? 0;
      const segment = makeServerSegment(messages, nextCursor, prevCursor);
      state.chats[chatId] = {
        segments: segment ? [segment] : [],
        optimisticMessages: [],
        hasReachedOldest: nextCursor === null,
        hasReachedLatest: prevCursor === null,
        generation: prevGen + 1,
      };
      state.views[chatId] = { mode: DEFAULT_TIMELINE_MODE, pendingLiveMessageIds: [] };
    },

    setTimelineMode(state, action: { payload: { chatId: string; mode: TimelineMode } }) {
      const view = getView(state, action.payload.chatId);
      view.mode = action.payload.mode;
      if (action.payload.mode.type === 'latest') {
        view.pendingLiveMessageIds = [];
      }
    },

    clearPendingLiveMessages(state, action: { payload: { chatId: string } }) {
      getView(state, action.payload.chatId).pendingLiveMessageIds = [];
    },

    refreshLatest(
      state,
      action: {
        payload: { chatId: string; messages: MessageResponse[]; nextCursor: string | null; prevCursor: string | null };
      },
    ) {
      const { chatId, messages, nextCursor, prevCursor } = action.payload;
      const chat = getChat(state, chatId);
      const segment = makeServerSegment(messages, nextCursor, prevCursor);
      const fetchedClientIds = new Set(messages.map((message) => message.clientGeneratedId).filter(Boolean));
      chat.optimisticMessages = chat.optimisticMessages.filter(
        (message) => !message.clientGeneratedId || !fetchedClientIds.has(message.clientGeneratedId),
      );
      if (segment) {
        chat.segments = normalizeLatestSegments(chat.segments, segment);
      }
      chat.hasReachedLatest = true;
      chat.hasReachedOldest = nextCursor === null || chat.hasReachedOldest;
      chat.generation++;
      const view = getView(state, chatId);
      view.mode = DEFAULT_TIMELINE_MODE;
      clearPendingLiveForLoadedMessages(view, chat);
    },

    insertAround(
      state,
      action: {
        payload: {
          chatId: string;
          targetMessageId: string;
          messages: MessageResponse[];
          nextCursor: string | null;
          prevCursor: string | null;
        };
      },
    ) {
      const { chatId, targetMessageId, messages, nextCursor, prevCursor } = action.payload;
      const segment = makeServerSegment(messages, nextCursor, prevCursor);
      if (!segment) return;
      const chat = getChat(state, chatId);
      const hasReachedLatest = prevCursor === null;
      chat.segments = normalizeAroundSegments(chat.segments, segment, { hasReachedLatest });
      chat.hasReachedOldest = nextCursor === null || chat.hasReachedOldest;
      chat.hasReachedLatest = hasReachedLatest || chat.hasReachedLatest;
      chat.generation++;
      getView(state, chatId).mode = { type: 'around', targetMessageId };
    },

    insertBeforeAnchor(
      state,
      action: {
        payload: { chatId: string; anchorMessageId: string; messages: MessageResponse[]; nextCursor: string | null };
      },
    ) {
      const { chatId, anchorMessageId, messages, nextCursor } = action.payload;
      const segment = makeServerSegment(
        messages.filter((message) => compareMessageOrder(message, { id: anchorMessageId }) < 0),
        nextCursor,
        anchorMessageId,
      );
      const chat = getChat(state, chatId);
      if (segment) {
        chat.segments = normalizeBeforeAnchorSegments(chat.segments, segment, anchorMessageId);
      }
      chat.hasReachedOldest = nextCursor === null || chat.hasReachedOldest;
      chat.generation++;
    },

    insertAfterAnchor(
      state,
      action: {
        payload: { chatId: string; anchorMessageId: string; messages: MessageResponse[]; prevCursor: string | null };
      },
    ) {
      const { chatId, anchorMessageId, messages, prevCursor } = action.payload;
      const segment = makeServerSegment(
        messages.filter((message) => compareMessageOrder(message, { id: anchorMessageId }) > 0),
        anchorMessageId,
        prevCursor,
      );
      const chat = getChat(state, chatId);
      const hasReachedLatest = prevCursor === null;
      if (segment) {
        chat.segments = normalizeAfterAnchorSegments(chat.segments, segment, anchorMessageId, { hasReachedLatest });
      }
      chat.hasReachedLatest = hasReachedLatest || chat.hasReachedLatest;
      chat.generation++;
    },

    applyRealtimeMessage(state, action: { payload: { chatId: string; message: MessageResponse } }) {
      const { chatId, message } = action.payload;
      const chat = getChat(state, chatId);
      const view = getView(state, chatId);
      const matchingOptimistic = chat.optimisticMessages.some((current) => isSameLogicalMessage(current, message));
      if (matchingOptimistic) {
        removeLogicalMessage(chat, message);
        insertServerMessageIntoLatest(chat, message);
        chat.hasReachedLatest = true;
        chat.generation++;
        return;
      }

      if (updateLoadedServerMessage(chat, message)) {
        chat.generation++;
        return;
      }

      if (isActiveViewAtLatestEdge(chat, view)) {
        insertServerMessageIntoLatest(chat, message);
        chat.generation++;
        return;
      }

      if (!view.pendingLiveMessageIds.includes(message.id)) {
        view.pendingLiveMessageIds.push(message.id);
      }
    },

    confirmOptimistic(
      state,
      action: { payload: { chatId: string; clientGeneratedId: string; message: MessageResponse } },
    ) {
      const { chatId, clientGeneratedId, message } = action.payload;
      const chat = getChat(state, chatId);
      const resolvedMessage = { ...message, clientGeneratedId: message.clientGeneratedId || clientGeneratedId };
      removeLogicalMessage(chat, resolvedMessage);
      insertServerMessageIntoLatest(chat, resolvedMessage);
      chat.hasReachedLatest = true;
      chat.generation++;
    },

    markOptimisticFailed(state, action: { payload: { chatId: string; clientGeneratedId: string } }) {
      const chat = getChat(state, action.payload.chatId);
      const failed = chat.optimisticMessages.find(
        (message) =>
          message.clientGeneratedId === action.payload.clientGeneratedId ||
          message.id === action.payload.clientGeneratedId,
      );
      if (!failed) return;
      failed.isDeleted = true;
      chat.generation++;
    },
    updateThreadReplyCount(state, action: { payload: { chatId: string; threadRootId: string; replyCount: number } }) {
      const { chatId, threadRootId, replyCount } = action.payload;
      const chat = state.chats[chatId];
      if (!chat) return;
      for (const segment of chat.segments) {
        for (let i = 0; i < segment.messages.length; i++) {
          if (segment.messages[i].id === threadRootId && segment.messages[i].threadInfo) {
            if (replyCount === 0) {
              // Remove threadInfo so bubble renders as normal message
              delete segment.messages[i].threadInfo;
            } else {
              segment.messages[i] = {
                ...segment.messages[i],
                threadInfo: { ...segment.messages[i].threadInfo, replyCount },
              };
            }
            chat.generation++;
            return;
          }
        }
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(messageAdded, (state, action) => {
        const { storeChatId, message, origin } = action.payload;
        const chat = getChat(state, storeChatId);
        if (origin === 'optimistic' || isOptimisticMessage(message)) {
          upsertOptimisticMessage(chat, message);
          getView(state, storeChatId).mode = DEFAULT_TIMELINE_MODE;
          chat.hasReachedLatest = true;
          chat.generation++;
          return;
        }
        if (origin !== 'ws') {
          insertServerMessageIntoLatest(chat, message);
          chat.hasReachedLatest = true;
          chat.generation++;
          return;
        }
        messagesSlice.caseReducers.applyRealtimeMessage(state, {
          payload: { chatId: storeChatId, message },
        });
      })
      .addCase(messageConfirmed, (state, action) => {
        messagesSlice.caseReducers.confirmOptimistic(state, {
          payload: {
            chatId: action.payload.storeChatId,
            clientGeneratedId: action.payload.clientGeneratedId,
            message: action.payload.message,
          },
        });
      })
      .addCase(messagePatched, (state, action) => {
        const { chatId: baseChatId, messageId, message } = action.payload;
        for (const [storeKey, chat] of Object.entries(state.chats)) {
          if (storeKey !== baseChatId && !storeKey.startsWith(`${baseChatId}_thread_`)) continue;
          if (message.isDeleted) {
            chat.optimisticMessages = chat.optimisticMessages.filter((m) => m.id !== messageId);
          }
          for (const segment of chat.segments) {
            if (message.isDeleted) {
              // Thread root messages stay in timeline with isDeleted flag so the
              // thread remains reachable; plain messages are removed.
              const idx = segment.messages.findIndex((m) => m.id === messageId);
              const existing = idx !== -1 ? segment.messages[idx] : undefined;
              // Use explicit `!== undefined` so `null` from the server (thread_info: None)
              // is respected instead of falling back to the stale local value via `??`.
              const newThreadInfo =
                existing && message.threadInfo !== undefined ? message.threadInfo : existing?.threadInfo;
              if (existing && newThreadInfo) {
                segment.messages[idx] = {
                  ...existing,
                  ...message,
                  threadInfo: newThreadInfo,
                };
              } else {
                segment.messages = segment.messages.filter((m) => m.id !== messageId);
              }
            }
            for (let i = 0; i < segment.messages.length; i++) {
              const current = segment.messages[i];
              if (!message.isDeleted && current.id === messageId) {
                // Capture originals before Object.assign; otherwise the `??` fallbacks
                // below would read the already-overwritten value (`message.X ?? message.X`).
                // threadInfo uses `!== undefined` (not `??`) so an explicit server `null`
                // clears the field instead of falling back to the stale local value.
                const prevReplyTo = current.replyToMessage;
                const prevReactions = current.reactions;
                Object.assign(current, message);
                current.replyToMessage = message.replyToMessage ?? prevReplyTo;
                current.reactions = message.reactions ?? prevReactions;
                if (message.threadInfo !== undefined) current.threadInfo = message.threadInfo;
              } else if (current.replyToMessage?.id === messageId) {
                current.replyToMessage.message = message.message;
                current.replyToMessage.messageType = message.messageType;
                current.replyToMessage.sticker = message.sticker;
                current.replyToMessage.isDeleted = message.isDeleted;
                current.replyToMessage.attachments = message.attachments;
                current.replyToMessage.mentions = message.mentions;
              }
            }
          }
          chat.segments = chat.segments.filter((segment) => segment.messages.length > 0);
          chat.generation++;
        }
      })
      .addCase(messagesBulkDeleted, (state, action) => {
        const { chatId, messageIds } = action.payload;
        const idSet = new Set(messageIds);
        for (const [storeKey, chat] of Object.entries(state.chats)) {
          if (storeKey !== chatId && !storeKey.startsWith(`${chatId}_thread_`)) continue;
          chat.optimisticMessages = chat.optimisticMessages.filter((message) => !idSet.has(message.id));
          for (const segment of chat.segments) {
            segment.messages = segment.messages.filter((message) => !idSet.has(message.id));
            for (const message of segment.messages) {
              if (message.replyToMessage && idSet.has(message.replyToMessage.id)) {
                message.replyToMessage.isDeleted = true;
                message.replyToMessage.message = null;
                message.replyToMessage.attachments = [];
              }
            }
          }
          chat.segments = chat.segments.filter((segment) => segment.messages.length > 0);
          chat.generation++;
        }
      })
      .addCase(reactionsUpdated, (state, action) => {
        const { chatId, messageId, reactions } = action.payload;
        for (const [storeKey, chat] of Object.entries(state.chats)) {
          if (storeKey !== chatId && !storeKey.startsWith(`${chatId}_thread_`)) continue;
          for (const segment of chat.segments) {
            for (let i = 0; i < segment.messages.length; i++) {
              if (segment.messages[i].id === messageId) {
                const existing = segment.messages[i].reactions ?? [];
                const merged = reactions.map((reaction) => {
                  const prev = existing.find((item) => item.emoji === reaction.emoji);
                  return { ...reaction, reactedByMe: reaction.reactedByMe ?? prev?.reactedByMe };
                });
                segment.messages[i] = { ...segment.messages[i], reactions: merged };
              }
            }
          }
        }
      });
  },
});

export const {
  resetChat,
  setTimelineMode,
  clearPendingLiveMessages,
  refreshLatest,
  insertAround,
  insertBeforeAnchor,
  insertAfterAnchor,
  applyRealtimeMessage,
  confirmOptimistic,
  markOptimisticFailed,
  updateThreadReplyCount,
} = messagesSlice.actions;

export default messagesSlice.reducer;
