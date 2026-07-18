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

// Range primitive shared by useCoreManager / useMountedWindow for mounted-window math.
export interface CoreRange {
  start: number;
  end: number;
}

export interface MountedWindow {
  start: number; // index into ChatRow[]
  end: number; // inclusive
}

// ── State machine ──

export type Phase = 'WAITING_VIEWPORT' | 'BOOTSTRAP' | 'READY' | 'RECENTERING';

// ── Mutations ──

export type MutationType = 'none' | 'prepend' | 'append' | 'delete' | 'reset';
export type BatchDirection = 'backward' | 'forward';
export type BatchReason = 'bootstrap' | 'preload' | 'recenter' | 'jump';

export interface PendingBatch {
  direction: BatchDirection;
  reason?: BatchReason;
  keys: string[];
}

// ── Layout intents ──

export interface LayoutIntent {
  preserveHeightDelta?: number;
  scrollToBottom?: { behavior: ScrollBehavior };
  scrollToMessageId?: {
    messageId: string;
    behavior: ScrollBehavior;
    align?: 'top' | 'bottom' | 'custom';
    offsetRatio?: number;
  };
  scrollToKey?: { key: string; behavior: ScrollBehavior };
}

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
  bottomPadding?: number;
  onAtBottomChange?: (atBottom: boolean) => void;
  onLastFullyVisibleMessageChange?: (messageId: string | null) => void;
  onFirstVisibleMessageChange?: (messageId: string | null) => void;
  onScrollActivityChange?: (scrolling: boolean) => void;
  onTopDateCollidingChange?: (colliding: boolean) => void;
}

// ── Constants ──

export const BOOTSTRAP_HEIGHT_MULTIPLIER = 1.5;
export const BOOTSTRAP_BOTTOM_SEED = 16;
export const BOOTSTRAP_ITEM_RADIUS = 8;
export const STAGING_BATCH_SIZE = 12;
export const WINDOW_OVERSCAN = 6;
export const WINDOW_CAP = 96;
export const RECENTER_ROW_THRESHOLD = 12;
export const MOUNT_OVERSCAN = WINDOW_OVERSCAN;
export const MOUNT_CAP = WINDOW_CAP;
export const CORE_CAP = 200;
export const SCROLL_IDLE_MS = 200;
export const AT_BOTTOM_THRESHOLD_PX = 30;
export const EDGE_EPSILON_PX = 2;
export const EDGE_REARM_PX = 24;

export const DEFAULT_OFFSET_RATIO = 0.5;
