import type { MutableRefObject, ReactNode } from 'react';
import type { MessageResponse } from '@/api/messages';

// ── Row model ──

export type ChatRow =
  | { type: 'date'; key: string; dateLabel: string }
  | {
      type: 'group';
      key: string;
      messages: MessageResponse[];
      firstMessageId: string;
      lastMessageId: string;
      isSystem: boolean;
      showName: boolean;
      useStickyAvatar: boolean;
      /**
       * When set, an "unread messages" divider is rendered inside this group,
       * immediately before the bubble whose id matches this value. Marks the
       * read/unread boundary (mirrors telegram-tt's memoUnreadDividerBeforeId).
       * Only set on the group that contains the first unread message.
       */
      unreadDividerBeforeMessageId?: string;
    };

// ── Public API ──

export interface ScrollToBottomOptions {
  behavior?: ScrollBehavior;
  ifAlreadyMountedKey?: string;
  fallbackBehavior?: ScrollBehavior;
  source?: string;
}

export interface VirtualScrollHandle {
  scrollToBottom: (options?: ScrollToBottomOptions) => void;
  scrollToItem: (key: string, behavior?: ScrollBehavior) => void;
  scrollToMessageId: (
    messageId: string,
    behavior?: ScrollBehavior,
    align?: 'top' | 'bottom' | 'custom',
    offsetRatio?: number,
  ) => boolean;
}

export type VirtualScrollAnchor =
  | { type: 'bottom'; token: number }
  | { type: 'message'; messageId: string; token: number; align?: 'top' | 'bottom' | 'custom'; offsetRatio?: number }
  | { type: 'top'; token: number };

export interface LoadController {
  hasMore: boolean;
  loading?: boolean;
  onLoad: () => void;
}

export interface ChatVirtualScrollProps {
  rows: ChatRow[];
  renderRow: (row: ChatRow) => ReactNode;
  initialAnchor: VirtualScrollAnchor;
  scrollApiRef?: MutableRefObject<VirtualScrollHandle | null>;
  loadOlder: LoadController;
  loadNewer?: LoadController;
  header?: ReactNode;
  topOverlay?: ReactNode;
  isInitialLoading?: boolean;
  bottomPadding?: number;
  onAtBottomChange?: (atBottom: boolean) => void;
  onLastFullyVisibleMessageChange?: (messageId: string | null) => void;
  onFirstVisibleMessageChange?: (messageId: string | null) => void;
  onScrollActivityChange?: (scrolling: boolean) => void;
  onTopDateCollidingChange?: (colliding: boolean) => void;
}

// ── Constants ──

export const AT_BOTTOM_THRESHOLD_PX = 48;
export const DEFAULT_OFFSET_RATIO = 0.5;
