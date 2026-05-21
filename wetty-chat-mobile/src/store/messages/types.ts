import type { MessageResponse } from '@/api/messages';

export interface MessageSegment {
  messages: MessageResponse[];
  nextCursor: string | null;
  prevCursor: string | null;
}

export interface ChatTimelineState {
  segments: MessageSegment[];
  optimisticMessages: MessageResponse[];
  hasReachedOldest: boolean;
  hasReachedLatest: boolean;
  generation: number;
}

export type TimelineMode = { type: 'latest' } | { type: 'around'; targetMessageId: string };

export interface TimelineViewState {
  mode: TimelineMode;
  pendingLiveMessageIds: string[];
}

export interface MessagesState {
  chats: Record<string, ChatTimelineState>;
  views: Record<string, TimelineViewState>;
}
