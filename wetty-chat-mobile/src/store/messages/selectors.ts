import { createSelector } from '@reduxjs/toolkit';
import type { MessageResponse } from '@/api/messages';
import { compareMessageOrder } from '../messageProjection';
import { activeSegment, allLoadedMessages, DEFAULT_TIMELINE_MODE, latestSegment } from './timelineAlgorithms';
import type { MessagesState, TimelineMode } from './types';

const EMPTY_ARRAY: MessageResponse[] = [];

const selectMessagesChats = (state: { messages: MessagesState }) => state.messages.chats;
const selectMessagesViews = (state: { messages: MessagesState }) => state.messages.views;

export const selectTimelineMode = createSelector(
  [selectMessagesViews, (_state: { messages: MessagesState }, chatId: string) => chatId],
  (views, chatId): TimelineMode => views[chatId]?.mode ?? DEFAULT_TIMELINE_MODE,
);

export const selectActiveTimelineMessages = createSelector(
  [selectMessagesChats, selectMessagesViews, (_state: { messages: MessagesState }, chatId: string) => chatId],
  (chats, views, chatId): MessageResponse[] => {
    const chat = chats[chatId];
    const segment = activeSegment(chat, views[chatId]);
    if (!chat || !segment) return chat?.optimisticMessages ?? EMPTY_ARRAY;
    if ((views[chatId]?.mode ?? DEFAULT_TIMELINE_MODE).type === 'latest') {
      return [...segment.messages, ...chat.optimisticMessages];
    }
    return segment.messages;
  },
);

export function selectCanLoadOlder(state: { messages: MessagesState }, chatId: string): boolean {
  const chat = state.messages.chats[chatId];
  const segment = activeSegment(chat, state.messages.views[chatId]);
  if (!chat || !segment) return false;
  return segment.nextCursor !== null || segment !== chat.segments[0] || !chat.hasReachedOldest;
}

export function selectCanLoadNewer(state: { messages: MessagesState }, chatId: string): boolean {
  const chat = state.messages.chats[chatId];
  const segment = activeSegment(chat, state.messages.views[chatId]);
  if (!chat || !segment) return false;
  return segment.prevCursor !== null || segment !== latestSegment(chat) || !chat.hasReachedLatest;
}

export function selectOlderAnchor(state: { messages: MessagesState }, chatId: string): string | null {
  const chat = state.messages.chats[chatId];
  const segment = activeSegment(chat, state.messages.views[chatId]);
  return segment?.nextCursor ?? segment?.messages[0]?.id ?? null;
}

export function selectNewerAnchor(state: { messages: MessagesState }, chatId: string): string | null {
  const chat = state.messages.chats[chatId];
  const segment = activeSegment(chat, state.messages.views[chatId]);
  return segment?.prevCursor ?? segment?.messages[segment.messages.length - 1]?.id ?? null;
}

export function selectPendingLiveCount(state: { messages: MessagesState }, chatId: string): number {
  return state.messages.views[chatId]?.pendingLiveMessageIds.length ?? 0;
}

export function selectChatGeneration(state: { messages: MessagesState }, chatId: string): number {
  return state.messages.chats[chatId]?.generation ?? 0;
}

export function selectHasLoadedTimeline(state: { messages: MessagesState }, chatId: string): boolean {
  const chat = state.messages.chats[chatId];
  return !!chat && (chat.segments.length > 0 || chat.optimisticMessages.length > 0);
}

export function selectLatestServerMessage(state: { messages: MessagesState }, chatId: string): MessageResponse | null {
  const chat = state.messages.chats[chatId];
  const segment = latestSegment(chat);
  return segment?.messages[segment.messages.length - 1] ?? null;
}

export function selectAllTimelineMessages(state: { messages: MessagesState }, chatId: string): MessageResponse[] {
  const chat = state.messages.chats[chatId];
  if (!chat) return EMPTY_ARRAY;
  return [...allLoadedMessages(chat), ...chat.optimisticMessages];
}

export function selectLatestThreadReplyMessage(
  state: { messages: MessagesState },
  chatId: string,
  threadRootId: string,
): MessageResponse | null {
  const storeKey = `${chatId}_thread_${threadRootId}`;
  const messages = selectAllTimelineMessages(state, storeKey);
  let latest: MessageResponse | null = null;
  for (const message of messages) {
    if (message.isDeleted) continue;
    if (!latest || compareMessageOrder(message, latest) > 0) {
      latest = message;
    }
  }
  return latest;
}
