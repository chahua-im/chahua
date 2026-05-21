import type { MessageResponse } from '@/api/messages';
import { compareMessageOrder } from '../messageProjection';
import type { ChatTimelineState, MessageSegment, MessagesState, TimelineViewState } from './types';

export const DEFAULT_TIMELINE_MODE = { type: 'latest' } as const;

export function isOptimisticMessage(message: Pick<MessageResponse, 'id'>): boolean {
  return message.id.startsWith('cg_');
}

export function isSameLogicalMessage(
  left: Pick<MessageResponse, 'id' | 'clientGeneratedId'>,
  right: Pick<MessageResponse, 'id' | 'clientGeneratedId'>,
  fallbackClientGeneratedId?: string,
): boolean {
  if (left.id === right.id) return true;
  const rightClientGeneratedId = right.clientGeneratedId || fallbackClientGeneratedId;
  return !!left.clientGeneratedId && !!rightClientGeneratedId && left.clientGeneratedId === rightClientGeneratedId;
}

export function sortMessages(messages: MessageResponse[]): MessageResponse[] {
  return [...messages].sort(compareMessageOrder);
}

export function dedupeMessages(messages: MessageResponse[]): MessageResponse[] {
  const result: MessageResponse[] = [];
  for (const message of sortMessages(messages)) {
    const existingIndex = result.findIndex((current) => isSameLogicalMessage(current, message));
    if (existingIndex === -1) {
      result.push(message);
      continue;
    }
    if (!isOptimisticMessage(message)) {
      result[existingIndex] = message;
    }
  }
  return result;
}

export function createEmptyChatTimeline(): ChatTimelineState {
  return {
    segments: [],
    optimisticMessages: [],
    hasReachedOldest: false,
    hasReachedLatest: false,
    generation: 0,
  };
}

export function getChat(state: MessagesState, chatId: string): ChatTimelineState {
  if (!state.chats[chatId]) {
    state.chats[chatId] = createEmptyChatTimeline();
  }
  return state.chats[chatId];
}

export function getView(state: MessagesState, chatId: string): TimelineViewState {
  if (!state.views[chatId]) {
    state.views[chatId] = { mode: DEFAULT_TIMELINE_MODE, pendingLiveMessageIds: [] };
  }
  return state.views[chatId];
}

export function firstMessage(segment: MessageSegment): MessageResponse | undefined {
  return segment.messages[0];
}

export function lastMessage(segment: MessageSegment): MessageResponse | undefined {
  return segment.messages[segment.messages.length - 1];
}

export function latestSegment(chat: ChatTimelineState | undefined): MessageSegment | undefined {
  return chat?.segments[chat.segments.length - 1];
}

export function findSegmentContaining(chat: ChatTimelineState, messageId: string): MessageSegment | undefined {
  return chat.segments.find((segment) => segment.messages.some((message) => message.id === messageId));
}

export function activeSegment(
  chat: ChatTimelineState | undefined,
  view: TimelineViewState | undefined,
): MessageSegment | undefined {
  if (!chat) return undefined;
  const mode = view?.mode ?? DEFAULT_TIMELINE_MODE;
  if (mode.type === 'around') {
    return findSegmentContaining(chat, mode.targetMessageId) ?? latestSegment(chat);
  }
  return latestSegment(chat);
}

export function allLoadedMessages(chat: ChatTimelineState | undefined): MessageResponse[] {
  if (!chat) return [];
  return chat.segments.flatMap((segment) => segment.messages);
}

export function makeServerSegment(
  messages: MessageResponse[],
  nextCursor: string | null,
  prevCursor: string | null,
): MessageSegment | null {
  const serverMessages = dedupeMessages(messages.filter((message) => !isOptimisticMessage(message)));
  if (serverMessages.length === 0) return null;
  return { messages: serverMessages, nextCursor, prevCursor };
}

export function normalizeSegmentMessages(segment: MessageSegment): MessageSegment | null {
  const messages = dedupeMessages(segment.messages);
  if (messages.length === 0) return null;
  return { ...segment, messages };
}

export function sortSegments(segments: MessageSegment[]): MessageSegment[] {
  return segments
    .map(normalizeSegmentMessages)
    .filter((segment): segment is MessageSegment => segment != null)
    .sort((left, right) => compareMessageOrder(firstMessage(left), firstMessage(right)));
}

function messageIdBefore(message: MessageResponse, messageId: string): boolean {
  return compareMessageOrder(message, { id: messageId }) < 0;
}

function messageIdAtOrBefore(message: MessageResponse, messageId: string): boolean {
  return compareMessageOrder(message, { id: messageId }) <= 0;
}

function messageIdAtOrAfter(message: MessageResponse, messageId: string): boolean {
  return compareMessageOrder(message, { id: messageId }) >= 0;
}

function messageIdAfter(message: MessageResponse, messageId: string): boolean {
  return compareMessageOrder(message, { id: messageId }) > 0;
}

export function segmentEndsBefore(segment: MessageSegment, messageId: string): boolean {
  const last = lastMessage(segment);
  return !!last && messageIdBefore(last, messageId);
}

export function segmentStartsAfter(segment: MessageSegment, messageId: string): boolean {
  const first = firstMessage(segment);
  return !!first && messageIdAfter(first, messageId);
}

function segmentFromMessages(
  messages: MessageResponse[],
  nextCursor: string | null,
  prevCursor: string | null,
): MessageSegment | null {
  const deduped = dedupeMessages(messages);
  if (deduped.length === 0) return null;
  return { messages: deduped, nextCursor, prevCursor };
}

function messagesBefore(segment: MessageSegment, messageId: string): MessageSegment | null {
  return segmentFromMessages(
    segment.messages.filter((message) => messageIdBefore(message, messageId)),
    segment.nextCursor,
    messageId,
  );
}

function messagesThrough(segment: MessageSegment, messageId: string): MessageSegment | null {
  return segmentFromMessages(
    segment.messages.filter((message) => messageIdAtOrBefore(message, messageId)),
    segment.nextCursor,
    messageId,
  );
}

function messagesFrom(segment: MessageSegment, messageId: string): MessageSegment | null {
  return segmentFromMessages(
    segment.messages.filter((message) => messageIdAtOrAfter(message, messageId)),
    messageId,
    segment.prevCursor,
  );
}

function messagesAfter(segment: MessageSegment, messageId: string): MessageSegment | null {
  return segmentFromMessages(
    segment.messages.filter((message) => messageIdAfter(message, messageId)),
    messageId,
    segment.prevCursor,
  );
}

function concatenateSegments(left: MessageSegment, right: MessageSegment | null): MessageSegment {
  if (!right) return left;
  return {
    messages: dedupeMessages([...left.messages, ...right.messages]),
    nextCursor: left.nextCursor,
    prevCursor: right.prevCursor,
  };
}

function segmentStartId(segment: MessageSegment): string {
  const first = firstMessage(segment);
  if (!first) throw new Error('Canonical segments must be non-empty');
  return first.id;
}

function segmentEndId(segment: MessageSegment): string {
  const last = lastMessage(segment);
  if (!last) throw new Error('Canonical segments must be non-empty');
  return last.id;
}

export function normalizeLatestSegments(
  existingSegments: MessageSegment[],
  incoming: MessageSegment,
): MessageSegment[] {
  const existing = sortSegments(existingSegments);
  const incomingStartId = segmentStartId(incoming);
  const result: MessageSegment[] = [];
  let insertedIncoming = false;

  for (const segment of existing) {
    if (insertedIncoming) {
      continue;
    }
    if (segmentEndsBefore(segment, incomingStartId)) {
      result.push(segment);
      continue;
    }

    const prefix = messagesBefore(segment, incomingStartId);
    if (prefix) result.push(prefix);
    result.push(incoming);
    insertedIncoming = true;
  }

  if (!insertedIncoming) {
    result.push(incoming);
  }

  return sortSegments(result);
}

export function normalizeAroundSegments(
  existingSegments: MessageSegment[],
  incoming: MessageSegment,
  options: { hasReachedLatest: boolean },
): MessageSegment[] {
  if (options.hasReachedLatest) {
    return normalizeLatestSegments(existingSegments, incoming);
  }

  const existing = sortSegments(existingSegments);
  const incomingStartId = segmentStartId(incoming);
  const incomingEndId = segmentEndId(incoming);
  const result: MessageSegment[] = [];
  let emittedIncoming = false;

  for (const segment of existing) {
    if (segmentEndsBefore(segment, incomingStartId)) {
      result.push(segment);
      continue;
    }

    if (segmentStartsAfter(segment, incomingEndId)) {
      if (!emittedIncoming) {
        result.push(incoming);
        emittedIncoming = true;
      }
      result.push(segment);
      continue;
    }

    const prefix = messagesBefore(segment, incomingStartId);
    if (prefix) result.push(prefix);
    if (!emittedIncoming) {
      result.push(incoming);
      emittedIncoming = true;
    }
    const suffix = messagesAfter(segment, incomingEndId);
    if (suffix) result.push(suffix);
  }

  if (!emittedIncoming) {
    result.push(incoming);
  }

  return sortSegments(result);
}

export function normalizeBeforeAnchorSegments(
  existingSegments: MessageSegment[],
  incoming: MessageSegment,
  anchorMessageId: string,
): MessageSegment[] {
  const existing = sortSegments(existingSegments);
  const incomingStartId = segmentStartId(incoming);
  const result: MessageSegment[] = [];
  let emittedIncoming = false;

  for (const segment of existing) {
    if (emittedIncoming) {
      result.push(segment);
      continue;
    }

    if (segmentEndsBefore(segment, incomingStartId)) {
      result.push(segment);
      continue;
    }

    if (segmentEndsBefore(segment, anchorMessageId)) {
      const prefix = messagesBefore(segment, incomingStartId);
      if (prefix) result.push(prefix);
      continue;
    }

    const prefix = messagesBefore(segment, incomingStartId);
    if (prefix) result.push(prefix);
    const suffix = messagesFrom(segment, anchorMessageId);
    result.push(concatenateSegments(incoming, suffix));
    emittedIncoming = true;
  }

  if (!emittedIncoming) {
    result.push(incoming);
  }

  return sortSegments(result);
}

export function normalizeAfterAnchorSegments(
  existingSegments: MessageSegment[],
  incoming: MessageSegment,
  anchorMessageId: string,
  options: { hasReachedLatest: boolean },
): MessageSegment[] {
  const existing = sortSegments(existingSegments);
  const incomingEndId = segmentEndId(incoming);
  const result: MessageSegment[] = [];
  let emittedIncoming = false;
  let pendingIncoming = incoming;

  for (const segment of existing) {
    if (emittedIncoming) {
      result.push(segment);
      continue;
    }

    if (segmentEndsBefore(segment, anchorMessageId)) {
      result.push(segment);
      continue;
    }

    if (segmentStartsAfter(segment, incomingEndId)) {
      result.push(pendingIncoming);
      emittedIncoming = true;
      result.push(segment);
      continue;
    }

    const prefix = messagesThrough(segment, anchorMessageId);
    if (prefix) {
      pendingIncoming = concatenateSegments(prefix, incoming);
    }
    const suffix = messagesAfter(segment, incomingEndId);
    if (suffix) {
      result.push(pendingIncoming);
      emittedIncoming = true;
      result.push(suffix);
    }
  }

  if (!emittedIncoming) {
    result.push(pendingIncoming);
  }

  const normalized = sortSegments(result);
  if (!options.hasReachedLatest) return normalized;
  return normalized.filter((segment) => !segmentStartsAfter(segment, incomingEndId));
}

export function removeLogicalMessage(
  chat: ChatTimelineState,
  message: Pick<MessageResponse, 'id' | 'clientGeneratedId'>,
): void {
  chat.optimisticMessages = chat.optimisticMessages.filter((current) => !isSameLogicalMessage(current, message));
  chat.segments = chat.segments
    .map((segment) => ({
      ...segment,
      messages: segment.messages.filter((current) => !isSameLogicalMessage(current, message)),
    }))
    .filter((segment) => segment.messages.length > 0);
}

export function upsertOptimisticMessage(chat: ChatTimelineState, message: MessageResponse): void {
  const next = chat.optimisticMessages.filter((current) => !isSameLogicalMessage(current, message));
  next.push(message);
  chat.optimisticMessages = next;
}

export function insertServerMessageIntoLatest(chat: ChatTimelineState, message: MessageResponse): void {
  if (isOptimisticMessage(message)) {
    upsertOptimisticMessage(chat, message);
    return;
  }
  removeLogicalMessage(chat, message);
  const latest = latestSegment(chat);
  if (!latest) {
    chat.segments = [{ messages: [message], nextCursor: null, prevCursor: null }];
    return;
  }
  latest.messages = dedupeMessages([...latest.messages, message]);
  chat.segments = sortSegments(chat.segments);
}

export function updateLoadedServerMessage(chat: ChatTimelineState, message: MessageResponse): boolean {
  let didUpdate = false;
  chat.optimisticMessages = chat.optimisticMessages.filter((current) => !isSameLogicalMessage(current, message));
  for (const segment of chat.segments) {
    const nextMessages = segment.messages.map((current) => {
      if (!isSameLogicalMessage(current, message)) return current;
      didUpdate = true;
      return message;
    });
    if (didUpdate) {
      segment.messages = dedupeMessages(nextMessages);
    }
  }
  return didUpdate;
}

export function clearPendingLiveForLoadedMessages(view: TimelineViewState, chat: ChatTimelineState): void {
  const loadedIds = new Set(chat.segments.flatMap((segment) => segment.messages.map((message) => message.id)));
  view.pendingLiveMessageIds = view.pendingLiveMessageIds.filter((messageId) => !loadedIds.has(messageId));
}
