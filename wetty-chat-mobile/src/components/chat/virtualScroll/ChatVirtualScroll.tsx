import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import { useSelector } from 'react-redux';
import { selectChatFontSizeStyle } from '@/store/settingsSlice';
import { HeightCache } from './heightCache';
import { MeasuredRow } from './MeasuredRow';
import { FenwickTree } from './fenwick';
import { useStagingBatch } from './useStagingBatch';
import { estimateRowHeight } from './rowHeightEstimator';
import type {
  BatchDirection,
  ChatVirtualScrollProps,
  LayoutIntent,
  MountedWindow,
  MutationType,
  PendingBatch,
  Phase,
  ScrollToBottomOptions,
} from './types';
import {
  AT_BOTTOM_THRESHOLD_PX,
  BOOTSTRAP_BOTTOM_SEED,
  BOOTSTRAP_HEIGHT_MULTIPLIER,
  BOOTSTRAP_ITEM_RADIUS,
  EDGE_EPSILON_PX,
  EDGE_REARM_PX,
  RECENTER_ROW_THRESHOLD,
  SCROLL_IDLE_MS,
  STAGING_BATCH_SIZE,
  WINDOW_CAP,
  WINDOW_OVERSCAN,
  DEFAULT_OFFSET_RATIO,
} from './types';
import styles from './ChatVirtualScroll.module.scss';
import { Trans } from '@lingui/react/macro';
import { useNativeScrollActivity } from '@/hooks/useNativeScrollActivity';
import { usePageVisible } from '@/hooks/usePageVisible';
import { isPageHidden } from '@/utils/dom';
import {
  capRange,
  clamp,
  classifyKeyMutation,
  detectAlternatingJitter,
  hasMeaningfulScrollDelta,
  normalizeRange,
  rangeSize,
  rangesEqual,
  roundScrollValue,
  scrollDirection,
  unionRanges,
  visiblePrefixHeight,
} from './layoutMath';
import {
  USER_SCROLL_ACTIVITY_GRACE_MS,
  TOP_DATE_FLOATING_GAP_PX,
  TOP_DATE_OVERLAY_FALLBACK_HEIGHT,
} from '@/constants/ui';

const debugVirtualScroll = import.meta.env.DEV;
const EDGE_HINT_HEIGHT = 36;
const JUMP_TARGET_HIGHLIGHT_MS = 1000;

function logVirtualScroll(event: string, details?: Record<string, unknown>) {
  if (!debugVirtualScroll) return;
  if (details) {
    console.debug(`[ChatVirtualScroll] ${event}`, details);
    return;
  }

  console.debug(`[ChatVirtualScroll] ${event}`);
}

function formatAnchorForLog(anchor: ChatVirtualScrollProps['initialAnchor']) {
  if (anchor.type === 'bottom') {
    return { type: 'bottom', token: anchor.token };
  }
  if (anchor.type === 'top') {
    return { type: 'top', token: anchor.token };
  }

  return { type: 'message', messageId: anchor.messageId, token: anchor.token };
}

export function ChatVirtualScroll({
  rows,
  renderRow,
  initialAnchor,
  scrollApiRef,
  loadOlder,
  loadNewer,
  header,
  topOverlay,
  bottomPadding = 0,
  onAtBottomChange,
  onLastFullyVisibleMessageChange,
  onFirstVisibleMessageChange,
  onScrollActivityChange,
  onTopDateCollidingChange,
}: ChatVirtualScrollProps) {
  const chatFontSizeStyle = useSelector(selectChatFontSizeStyle);
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const rowRefsMap = useRef(new Map<string, HTMLDivElement>());
  const heightCacheRef = useRef(new HeightCache());
  const treeRef = useRef(new FenwickTree(0));
  const treeKeysRef = useRef<string[]>([]);
  const mountedRef = useRef<MountedWindow | null>(null);
  const lastFontSizeRef = useRef(chatFontSizeStyle);
  const overlayMeasureElRef = useRef<HTMLElement | null>(null);
  const overlayHeightRef = useRef<number | null>(null);

  const topDateCollidingRef = useRef(false);
  const scrollingRef = useRef(false);
  if (lastFontSizeRef.current !== chatFontSizeStyle) {
    lastFontSizeRef.current = chatFontSizeStyle;
    heightCacheRef.current.clear();
    treeKeysRef.current = [];
  }

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create a hidden measurement element inside the container so CSS context
    // matches the real floating label. We prefer keeping a persistent node
    // to avoid reflows on every measurement.
    let el = overlayMeasureElRef.current;
    if (!el) {
      el = document.createElement('div');
      el.className = 'conversation-floating-date__label';
      el.style.visibility = 'hidden';
      el.style.position = 'absolute';
      el.style.pointerEvents = 'none';
      el.style.transform = 'translateY(-99999px)';
      container.appendChild(el);
      overlayMeasureElRef.current = el;
    }

    // Measure height for collision calculations
    overlayHeightRef.current = el.getBoundingClientRect().height || null;

    return () => {
      if (overlayMeasureElRef.current && overlayMeasureElRef.current.parentElement) {
        overlayMeasureElRef.current.parentElement.removeChild(overlayMeasureElRef.current);
      }
      overlayMeasureElRef.current = null;
      overlayHeightRef.current = null;
    };
  }, [chatFontSizeStyle]);

  const layoutIntentRef = useRef<LayoutIntent | null>(null);
  const isAtBottomRef = useRef(true);
  const lastFullyVisibleMessageIdRef = useRef<string | null>(null);
  const firstVisibleMessageIdRef = useRef<string | null>(null);
  const initialAnchorRef = useRef(initialAnchor);
  initialAnchorRef.current = initialAnchor;

  const pendingScrollKeyRef = useRef<string | null>(null);
  const pendingScrollMessageIdRef = useRef<string | null>(null);
  const initialAnchorConsumedRef = useRef(false);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior>('auto');
  const pendingScrollToBottomRef = useRef(false);
  const pendingScrollAlignRef = useRef<'top' | 'bottom' | 'custom'>('top');
  const pendingScrollOffsetRatioRef = useRef<number>(DEFAULT_OFFSET_RATIO);
  const pendingScrollToBottomBehaviorRef = useRef<ScrollBehavior>('auto');
  const pendingScrollToBottomSourceRef = useRef<string | null>(null);
  const pendingPrependRestoreRef = useRef<{ key: string; offsetTop: number } | null>(null);
  const pendingDeleteRestoreRef = useRef<{ key: string; offsetTop: number } | null>(null);
  const pendingPrependCompensationRef = useRef<number | null>(null);
  // Tracks the last message id seen on the previous layout pass. With sticky-avatar
  // grouping, a new message from the same sender is merged into the existing last
  // group row, so the row key array is unchanged and classifyKeyMutation returns
  // 'none'. Comparing the actual last message id detects this "group grew" case so
  // the append-bottom-lock auto-scroll still fires.
  const lastKnownLastMessageIdRef = useRef<string | null>(null);
  const pendingLayoutAnchorRestoreRef = useRef<{
    source: string;
    key: string;
    offsetTop: number;
  } | null>(null);
  const pendingAnchorDriftCheckRef = useRef<{
    source: string;
    key: string;
    offsetTop: number;
  } | null>(null);
  const mutationSnapshotRef = useRef<{
    mutation: MutationType;
    anchor: { key: string; offsetTop: number } | null;
    rowCountDelta: number;
  } | null>(null);
  const recenterTargetIndexRef = useRef<number | null>(null);

  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const bottomSettleRafRef = useRef<number | null>(null);
  const bottomSettleFramesRemainingRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProgrammaticScrollRef = useRef<{
    source: string;
    at: number;
    from: number;
    to: number;
    behavior?: ScrollBehavior;
  } | null>(null);
  const recentScrollPositionsRef = useRef<Array<{ top: number; at: number }>>([]);
  const lastJitterLogAtRef = useRef(0);
  const topLoadArmedRef = useRef(true);
  const bottomLoadArmedRef = useRef(true);

  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const keyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    rowKeys.forEach((key, index) => map.set(key, index));
    return map;
  }, [rowKeys]);
  const messageIdToTarget = useMemo(() => {
    const map = new Map<string, { key: string; index: number }>();
    rows.forEach((row, index) => {
      if (row.type !== 'group') return;
      // Map every messageId in the group to the group's row so that
      // scrollToMessageId / resolveMessageTarget land on the containing group.
      for (const msg of row.messages) {
        map.set(msg.id, { key: row.key, index });
      }
    });
    return map;
  }, [rows]);
  const prevKeysRef = useRef<string[]>([]);

  const [phase, setPhase] = useState<Phase>('WAITING_VIEWPORT');
  const phaseRef = useRef<Phase>('WAITING_VIEWPORT');
  const [containerHeight, setContainerHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [highlightedRowKey, setHighlightedRowKey] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [hiddenDateRowKey, setHiddenDateRowKey] = useState<string | null>(null);
  const [renderTick, setRenderTick] = useState(0);
  const triggerRender = useCallback(() => setRenderTick((value) => value + 1), []);

  const setPhaseState = useCallback(
    (next: Phase) => {
      if (phaseRef.current !== next) {
        logVirtualScroll('phase-change', {
          from: phaseRef.current,
          to: next,
          rowCount: rowKeys.length,
          mounted: mountedRef.current,
        });
      }
      phaseRef.current = next;
      setPhase(next);
    },
    [rowKeys.length],
  );

  if (treeKeysRef.current !== rowKeys) {
    const tree = new FenwickTree(rowKeys.length);
    for (let index = 0; index < rowKeys.length; index += 1) {
      const key = rowKeys[index];
      const row = rows[index];
      if (!row) continue;
      tree.set(index, heightCacheRef.current.get(key) ?? estimateRowHeight(row, chatFontSizeStyle));
    }
    treeRef.current = tree;
    treeKeysRef.current = rowKeys;
  }

  const topChromeHeight = useCallback(() => {
    return headerHeight;
  }, [headerHeight]);

  const totalHeight = useCallback(() => treeRef.current.total(), []);

  const offsetOf = useCallback((index: number) => treeRef.current.prefixSum(index), []);

  const heightBetween = useCallback((start: number, endExclusive: number) => {
    if (endExclusive <= start) return 0;
    return treeRef.current.prefixSum(endExclusive) - treeRef.current.prefixSum(start);
  }, []);

  const indexAtOffset = useCallback(
    (offset: number) => {
      if (rowKeys.length === 0) return 0;
      return treeRef.current.findIndexByOffset(offset);
    },
    [rowKeys.length],
  );

  const isMeasured = useCallback(
    (index: number) => {
      const key = rowKeys[index];
      return key ? heightCacheRef.current.has(key) : false;
    },
    [rowKeys],
  );

  const allMeasured = useCallback(
    (start: number, end: number) => {
      if (start > end) return true;
      for (let index = start; index <= end; index += 1) {
        if (!isMeasured(index)) return false;
      }
      return true;
    },
    [isMeasured],
  );

  const firstUnmeasuredInRange = useCallback(
    (start: number, end: number) => {
      for (let index = start; index <= end; index += 1) {
        if (!isMeasured(index)) return index;
      }
      return -1;
    },
    [isMeasured],
  );

  const deriveVisibleRange = useCallback(
    (scrollTop: number, viewportHeight: number): MountedWindow | null => {
      if (rowKeys.length === 0) return null;
      const contentTop = Math.max(0, scrollTop - topChromeHeight());
      const visibleStart = indexAtOffset(contentTop);
      const visibleEnd = indexAtOffset(contentTop + viewportHeight);
      return normalizeRange(visibleStart, visibleEnd, rowKeys.length - 1);
    },
    [indexAtOffset, rowKeys.length, topChromeHeight],
  );

  const deriveDesiredRange = useCallback(
    (scrollTop: number, viewportHeight: number): MountedWindow | null => {
      const visible = deriveVisibleRange(scrollTop, viewportHeight);
      if (!visible) return null;
      const desired = normalizeRange(
        visible.start - WINDOW_OVERSCAN,
        visible.end + WINDOW_OVERSCAN,
        rowKeys.length - 1,
      );
      return desired ? capRange(desired, rowKeys.length - 1) : null;
    },
    [deriveVisibleRange, rowKeys.length],
  );

  const deriveDesiredRangeForTargetIndex = useCallback(
    (targetIndex: number, viewportHeight: number): MountedWindow | null => {
      if (rowKeys.length === 0) return null;

      const container = containerRef.current;
      const maxScrollTop = container
        ? Math.max(0, container.scrollHeight - container.clientHeight)
        : Number.POSITIVE_INFINITY;
      const targetScrollTop = roundScrollValue(clamp(topChromeHeight() + offsetOf(targetIndex), 0, maxScrollTop));

      return deriveDesiredRange(targetScrollTop, viewportHeight);
    },
    [deriveDesiredRange, offsetOf, rowKeys.length, topChromeHeight],
  );

  const topSpacerHeight = useCallback(() => {
    const mounted = mountedRef.current;
    return mounted ? offsetOf(mounted.start) : 0;
  }, [offsetOf]);

  const bottomSpacerHeight = useCallback(() => {
    const mounted = mountedRef.current;
    return mounted ? totalHeight() - offsetOf(mounted.end + 1) : 0;
  }, [offsetOf, totalHeight]);

  const updateMountedRange = useCallback(
    (next: MountedWindow | null) => {
      if (rangesEqual(mountedRef.current, next)) return false;
      mountedRef.current = next;
      triggerRender();
      return true;
    },
    [triggerRender],
  );

  const scrollDistances = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;

    return {
      fromTop: container.scrollTop - topChromeHeight(),
      fromBottom: container.scrollHeight - (container.scrollTop + container.clientHeight),
    };
  }, [topChromeHeight]);

  const isAtTopEdge = useCallback(() => {
    const distances = scrollDistances();
    return distances ? distances.fromTop <= EDGE_EPSILON_PX : false;
  }, [scrollDistances]);

  const isAtBottomEdge = useCallback(() => {
    const distances = scrollDistances();
    return distances ? distances.fromBottom <= EDGE_EPSILON_PX : false;
  }, [scrollDistances]);

  const updateAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container || container.clientHeight === 0) return;
    if (phaseRef.current !== 'READY') return;

    const visualBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight) <= AT_BOTTOM_THRESHOLD_PX;
    const atBottom = visualBottom && !loadNewer?.hasMore;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      onAtBottomChange?.(atBottom);
    }
  }, [loadNewer?.hasMore, onAtBottomChange]);

  const setScrollActivity = useCallback(
    (scrolling: boolean) => {
      if (scrollingRef.current === scrolling) return;
      scrollingRef.current = scrolling;
      onScrollActivityChange?.(scrolling);
      if (!scrolling) {
        setHiddenDateRowKey(null);
      }
    },
    [onScrollActivityChange],
  );
  const { active: nativeScrollActive, markIntent } = useNativeScrollActivity(
    containerRef,
    USER_SCROLL_ACTIVITY_GRACE_MS,
    SCROLL_IDLE_MS,
  );

  useEffect(() => {
    setScrollActivity(nativeScrollActive);
  }, [nativeScrollActive, setScrollActivity]);

  const updateLastFullyVisibleMessage = useCallback(() => {
    const container = containerRef.current;
    if (!container || container.clientHeight === 0 || phaseRef.current !== 'READY') {
      if (lastFullyVisibleMessageIdRef.current !== null) {
        lastFullyVisibleMessageIdRef.current = null;
        onLastFullyVisibleMessageChange?.(null);
      }
      if (firstVisibleMessageIdRef.current !== null) {
        firstVisibleMessageIdRef.current = null;
        onFirstVisibleMessageChange?.(null);
      }
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const mounted = mountedRef.current;
    let lastFullyVisibleId: string | null = null;
    let firstMessageId: string | null = null;
    let firstMessageIndex: number | null = null;
    let nextTopDateColliding = false;
    let nextHiddenDateRowKey: string | null = null;
    if (mounted) {
      const overlayHeight = overlayHeightRef.current || TOP_DATE_OVERLAY_FALLBACK_HEIGHT;
      const floatingTop = TOP_DATE_FLOATING_GAP_PX;
      const floatingBottom = floatingTop + overlayHeight;

      for (let index = mounted.end; index >= mounted.start; index -= 1) {
        const row = rows[index];
        if (!row) continue;

        const rowNode = rowRefsMap.current.get(row.key);
        if (!rowNode) continue;

        const rowRect = rowNode.getBoundingClientRect();
        if (rowRect.height <= 0) continue;
        if (row.type === 'group') {
          const fullyVisible = rowRect.bottom <= containerRect.bottom + 0.5;
          const partiallyVisible = rowRect.bottom > containerRect.top && rowRect.top < containerRect.bottom;

          if (partiallyVisible) {
            // The topmost partially-visible group drives loadOlder / scroll-direction.
            firstMessageId = row.firstMessageId;
            firstMessageIndex = index;
          }

          // A fully-visible group ⇒ its last message is fully visible (the avatar
          // rests at the group's bottom). lastFullyVisibleMessageId drives read
          // receipts, so report the group's last message id.
          if (fullyVisible && lastFullyVisibleId === null) {
            lastFullyVisibleId = row.lastMessageId;
          }
        } else if (row.type === 'date') {
          if (!nextTopDateColliding) {
            const distanceFromTop = rowRect.top - containerRect.top;
            const distanceBottom = distanceFromTop + rowRect.height;
            const MARGIN = 1;
            if (distanceBottom + MARGIN >= floatingTop && distanceFromTop - MARGIN <= floatingBottom) {
              nextTopDateColliding = true;
            }
          }
        }
      }
    }

    if (scrollingRef.current && firstMessageIndex != null && mounted) {
      let activeDateRowKey: string | null = null;
      for (let index = firstMessageIndex; index >= 0; index -= 1) {
        const row = rows[index];
        if (row?.type === 'date') {
          activeDateRowKey = row.key;
          break;
        }
      }

      if (!nextTopDateColliding) {
        nextHiddenDateRowKey = activeDateRowKey;
      }
    }

    setHiddenDateRowKey((current) => (current === nextHiddenDateRowKey ? current : nextHiddenDateRowKey));

    if (topDateCollidingRef.current !== nextTopDateColliding) {
      topDateCollidingRef.current = nextTopDateColliding;
      onTopDateCollidingChange?.(nextTopDateColliding);
    }

    if (lastFullyVisibleId !== lastFullyVisibleMessageIdRef.current) {
      lastFullyVisibleMessageIdRef.current = lastFullyVisibleId;
      onLastFullyVisibleMessageChange?.(lastFullyVisibleId);
    }

    if (firstMessageId !== firstVisibleMessageIdRef.current) {
      firstVisibleMessageIdRef.current = firstMessageId;
      onFirstVisibleMessageChange?.(firstMessageId);
    }
  }, [onLastFullyVisibleMessageChange, onFirstVisibleMessageChange, onTopDateCollidingChange, rows]);

  const scrollToBottomInternal = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = containerRef.current;
    if (!container) return;

    const target = roundScrollValue(container.scrollHeight - container.clientHeight);
    if (!hasMeaningfulScrollDelta(container.scrollTop, target)) return;

    logVirtualScroll('scroll-position-write', {
      source: 'scrollToBottomInternal',
      from: container.scrollTop,
      to: target,
      behavior,
      mode: behavior === 'smooth' ? 'smooth-scroll' : 'jump-scroll',
      direction: scrollDirection(container.scrollTop, target),
    });
    lastProgrammaticScrollRef.current = {
      source: 'scrollToBottomInternal',
      at: performance.now(),
      from: container.scrollTop,
      to: target,
      behavior,
    };
    if (behavior === 'smooth') {
      container.scrollTo({ top: target, behavior });
      return;
    }
    container.scrollTop = target;
  }, []);

  const scrollToKeyInternal = useCallback(
    (
      key: string,
      behavior: ScrollBehavior = 'auto',
      align: 'top' | 'bottom' | 'custom' = 'top',
      offsetRatio: number = DEFAULT_OFFSET_RATIO,
    ) => {
      const container = containerRef.current;
      const row = rowRefsMap.current.get(key);
      if (!container || !row) {
        logVirtualScroll('scroll-to-item-missed-row', {
          key,
          behavior,
          hasContainer: container != null,
          hasRow: row != null,
          mounted: mountedRef.current,
        });
        return false;
      }

      const maxScroll = container.scrollHeight - container.clientHeight;
      let rawTarget: number;
      if (align === 'bottom') {
        rawTarget = row.offsetTop + row.offsetHeight - container.clientHeight;
      } else if (align === 'custom') {
        // Position row at offsetRatio (0=top, 0.5=center, 1=bottom) from top of viewport
        const ratio = Math.max(0, Math.min(1, offsetRatio));
        rawTarget = row.offsetTop - container.clientHeight * ratio;
      } else {
        rawTarget = row.offsetTop;
      }
      const target = roundScrollValue(Math.max(0, Math.min(rawTarget, maxScroll)));
      if (behavior === 'auto' && !hasMeaningfulScrollDelta(container.scrollTop, target)) {
        return true;
      }
      logVirtualScroll('scroll-to-item-execute', {
        key,
        behavior,
        mode: behavior === 'smooth' ? 'smooth-scroll' : 'jump-scroll',
        from: container.scrollTop,
        to: target,
        mounted: mountedRef.current,
      });
      container.scrollTo({ top: target, behavior });
      return true;
    },
    [],
  );

  const triggerJumpTargetHighlight = useCallback((key?: string, messageId?: string) => {
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }

    if (messageId) {
      setHighlightedRowKey(null);
      setHighlightedMessageId(messageId);
    } else {
      setHighlightedRowKey(key ?? null);
      setHighlightedMessageId(null);
    }

    highlightTimerRef.current = setTimeout(() => {
      setHighlightedRowKey((current) => (current === key ? null : current));
      setHighlightedMessageId((current) => (current === messageId ? null : current));
      highlightTimerRef.current = null;
    }, JUMP_TARGET_HIGHLIGHT_MS);
  }, []);

  // Highlight the specific message bubble via DOM — avoids prop threading through
  // SenderGroup / ChatMessageRow / ChatBubble. Re-runs on every renderTick so the
  // highlight survives virtual-scroll remounts.
  //
  // Coupling note: this reaches into ChatBubble's DOM by querying the stable
  // `data-message-row` attribute (set by ChatBubbleBase / StickerBubble /
  // InviteBubble). If those components stop emitting the attribute the highlight
  // will silently no-op — there is no compile-time link between the two.
  useLayoutEffect(() => {
    if (!highlightedMessageId) return;

    const container = containerRef.current;
    if (!container) return;

    const target = container.querySelector(`[data-message-id="${CSS.escape(highlightedMessageId)}"]`);
    if (!target) return;

    const chatRow = target.closest('[data-message-row]');
    if (!chatRow) return;
    const el = chatRow as HTMLElement;

    el.style.transition = 'background-color 100ms ease-out';
    el.style.backgroundColor = 'rgba(var(--ion-color-warning-rgb), 0.18)';

    return () => {
      el.style.backgroundColor = '';
      el.style.transition = '';
    };
  }, [highlightedMessageId, renderTick]);

  const resolveMessageTarget = useCallback(
    (messageId: string) => {
      return messageIdToTarget.get(messageId) ?? null;
    },
    [messageIdToTarget],
  );

  const restoreAnchorOffset = useCallback((key: string, offsetTop: number) => {
    const container = containerRef.current;
    const row = rowRefsMap.current.get(key);
    if (!container || !row) return false;

    const target = roundScrollValue(row.offsetTop - offsetTop);
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const nextScrollTop = roundScrollValue(Math.max(0, Math.min(target, maxScrollTop)));
    if (!hasMeaningfulScrollDelta(container.scrollTop, nextScrollTop)) return true;

    logVirtualScroll('scroll-position-write', {
      source: 'restoreAnchorOffset',
      key,
      offsetTop,
      from: container.scrollTop,
      to: nextScrollTop,
      direction: scrollDirection(container.scrollTop, nextScrollTop),
    });
    lastProgrammaticScrollRef.current = {
      source: 'restoreAnchorOffset',
      at: performance.now(),
      from: container.scrollTop,
      to: nextScrollTop,
    };
    container.scrollTop = nextScrollTop;
    return true;
  }, []);

  const captureVisibleAnchor = useCallback(() => {
    const container = containerRef.current;
    const mounted = mountedRef.current;
    if (!container || !mounted) return null;

    const containerRect = container.getBoundingClientRect();
    let firstVisibleMessage: { key: string; offsetTop: number } | null = null;
    let firstMountedMessage: { key: string; offsetTop: number } | null = null;

    for (let index = mounted.start; index <= mounted.end; index += 1) {
      const key = rowKeys[index];
      const row = rowRefsMap.current.get(key);
      if (!key || !row) continue;

      if (key.startsWith('grp:') && !firstMountedMessage) {
        firstMountedMessage = { key, offsetTop: roundScrollValue(row.offsetTop) };
      }

      const rect = row.getBoundingClientRect();
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;

      const anchor = { key, offsetTop: roundScrollValue(rect.top - containerRect.top) };
      if (key.startsWith('grp:')) {
        firstVisibleMessage = anchor;
        break;
      }
    }

    return firstVisibleMessage ?? firstMountedMessage;
  }, [rowKeys]);

  const logMutationSnapshot = useCallback((event: string, details?: Record<string, unknown>) => {
    logVirtualScroll(event, {
      mutationSnapshot: mutationSnapshotRef.current,
      mounted: mountedRef.current,
      ...details,
    });
  }, []);

  const registerRow = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) rowRefsMap.current.set(key, node);
    else rowRefsMap.current.delete(key);
  }, []);

  const scheduleBottomSettle = useCallback(() => {
    if (bottomSettleRafRef.current != null) {
      cancelAnimationFrame(bottomSettleRafRef.current);
    }

    let framesRemaining = 2;
    bottomSettleFramesRemainingRef.current = framesRemaining;
    logVirtualScroll('bottom-settle-scheduled', {
      framesRemaining,
      pendingScrollToBottom: pendingScrollToBottomRef.current,
      pendingScrollToBottomBehavior: pendingScrollToBottomBehaviorRef.current,
      pendingScrollToBottomSource: pendingScrollToBottomSourceRef.current,
      mounted: mountedRef.current,
    });
    const settle = () => {
      const container = containerRef.current;
      if (!container) {
        bottomSettleRafRef.current = null;
        bottomSettleFramesRemainingRef.current = 0;
        return;
      }

      logVirtualScroll('bottom-settle-tick', {
        framesRemaining,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      });
      scrollToBottomInternal();
      updateAtBottom();
      updateLastFullyVisibleMessage();
      framesRemaining -= 1;
      bottomSettleFramesRemainingRef.current = framesRemaining;
      if (framesRemaining > 0) {
        bottomSettleRafRef.current = requestAnimationFrame(settle);
        return;
      }

      bottomSettleRafRef.current = null;
      bottomSettleFramesRemainingRef.current = 0;
    };

    bottomSettleRafRef.current = requestAnimationFrame(settle);
  }, [scrollToBottomInternal, updateAtBottom, updateLastFullyVisibleMessage]);

  const createBatch = useCallback(
    (start: number, end: number, direction: BatchDirection, reason: PendingBatch['reason']): PendingBatch | null => {
      const range = normalizeRange(start, end, rowKeys.length - 1);
      if (!range) return null;
      const keys = rowKeys.slice(range.start, range.end + 1);
      if (keys.length === 0) return null;
      return { direction, reason, keys };
    },
    [rowKeys],
  );

  const handleBatchReady = useCallback(
    (batch: PendingBatch, heights: Map<string, number>) => {
      const container = containerRef.current;
      const viewportTop = container ? Math.max(0, container.scrollTop - topChromeHeight()) : 0;
      const viewportBottom = container ? viewportTop + container.clientHeight : viewportTop;
      const anchorBeforeBatch = phaseRef.current === 'READY' ? captureVisibleAnchor() : null;

      let preserveHeightDelta = 0;
      const batchIndices: number[] = [];
      const rowAdjustments: Array<{
        key: string;
        index: number;
        previousHeight: number;
        nextHeight: number;
        delta: number;
        preserveContribution: number;
        rowTopBefore: number;
        rowBottomBefore: number;
        rowTopAfter: number;
        rowBottomAfter: number;
        wasAboveViewportBefore: boolean;
        isAboveViewportAfter: boolean;
        intersectedViewportBefore: boolean;
        intersectsViewportAfter: boolean;
      }> = [];

      for (const [key, height] of heights) {
        const index = keyToIndex.get(key);
        if (index == null) continue;

        batchIndices.push(index);
        const previousHeight = treeRef.current.get(index);
        const rowTopBefore = offsetOf(index);
        const rowBottomBefore = rowTopBefore + previousHeight;
        treeRef.current.set(index, height);
        heightCacheRef.current.set(key, height);
        const rowTopAfter = offsetOf(index);
        const rowBottomAfter = rowTopAfter + height;

        const delta = height - previousHeight;
        const preserveContribution =
          visiblePrefixHeight(rowTopAfter, height, viewportTop) -
          visiblePrefixHeight(rowTopBefore, previousHeight, viewportTop);
        rowAdjustments.push({
          key,
          index,
          previousHeight,
          nextHeight: height,
          delta,
          rowTopBefore,
          rowBottomBefore,
          rowTopAfter,
          rowBottomAfter,
          wasAboveViewportBefore: rowTopBefore < viewportTop,
          isAboveViewportAfter: rowTopAfter < viewportTop,
          intersectedViewportBefore: rowBottomBefore > viewportTop && rowTopBefore < viewportBottom,
          intersectsViewportAfter: rowBottomAfter > viewportTop && rowTopAfter < viewportBottom,
          preserveContribution,
        });
        if (phaseRef.current === 'READY' && preserveContribution !== 0) {
          preserveHeightDelta += preserveContribution;
        }
      }

      if (batchIndices.length > 0) {
        const measuredRange = {
          start: Math.min(...batchIndices),
          end: Math.max(...batchIndices),
        };

        if (phaseRef.current === 'BOOTSTRAP') {
          mountedRef.current = unionRanges(mountedRef.current, measuredRange);
        } else if (phaseRef.current === 'RECENTERING') {
          mountedRef.current = unionRanges(mountedRef.current, measuredRange);
        } else {
          mountedRef.current = unionRanges(mountedRef.current, measuredRange);
        }
      }

      if (preserveHeightDelta !== 0 && !pendingScrollToBottomRef.current) {
        layoutIntentRef.current = { preserveHeightDelta };
      }
      if (anchorBeforeBatch) {
        pendingLayoutAnchorRestoreRef.current = {
          source: `batch:${batch.reason}:${batch.direction}`,
          key: anchorBeforeBatch.key,
          offsetTop: anchorBeforeBatch.offsetTop,
        };
        pendingAnchorDriftCheckRef.current = {
          source: `batch:${batch.reason}:${batch.direction}`,
          key: anchorBeforeBatch.key,
          offsetTop: anchorBeforeBatch.offsetTop,
        };
      }

      logVirtualScroll('batch-commit', {
        reason: batch.reason,
        direction: batch.direction,
        batchSize: batch.keys.length,
        preserveHeightDelta,
        phase: phaseRef.current,
        viewportTop,
        viewportBottom,
        mountedBefore: mountedRef.current,
        rowAdjustments: rowAdjustments
          .filter((item) => item.delta !== 0)
          .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
          .slice(0, 6),
      });
      if (debugVirtualScroll) {
        const compactRows = rowAdjustments
          .filter((item) => item.delta !== 0)
          .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
          .slice(0, 6)
          .map((item) => ({
            key: item.key,
            index: item.index,
            delta: item.delta,
            preserveContribution: item.preserveContribution,
            prev: item.previousHeight,
            next: item.nextHeight,
            topBefore: item.rowTopBefore,
            bottomBefore: item.rowBottomBefore,
            topAfter: item.rowTopAfter,
            bottomAfter: item.rowBottomAfter,
            aboveBefore: item.wasAboveViewportBefore,
            aboveAfter: item.isAboveViewportAfter,
            intersectsBefore: item.intersectedViewportBefore,
            intersectsAfter: item.intersectsViewportAfter,
          }));
        console.debug(
          `[ChatVirtualScroll] batch-commit-rows ${JSON.stringify({
            reason: batch.reason,
            direction: batch.direction,
            phase: phaseRef.current,
            viewportTop,
            viewportBottom,
            preserveHeightDelta,
            rows: compactRows,
          })}`,
        );
      }

      triggerRender();
    },
    [captureVisibleAnchor, keyToIndex, offsetOf, topChromeHeight, triggerRender],
  );

  const { pendingBatch, queueBatch, cancelBatch, handleStagingMeasure } = useStagingBatch(handleBatchReady);

  const queueRangeBatch = useCallback(
    (start: number, end: number, direction: BatchDirection, reason: PendingBatch['reason']) => {
      const batch = createBatch(start, end, direction, reason);
      if (!batch) return false;
      return queueBatch(batch);
    },
    [createBatch, queueBatch],
  );

  const queueAdjacentBatch = useCallback(
    (direction: BatchDirection, reason: PendingBatch['reason']) => {
      const mounted = mountedRef.current;
      if (!mounted || pendingBatch) return false;

      if (direction === 'backward') {
        if (mounted.start <= 0) return false;
        return queueRangeBatch(Math.max(0, mounted.start - STAGING_BATCH_SIZE), mounted.start - 1, direction, reason);
      }

      if (mounted.end >= rowKeys.length - 1) return false;
      return queueRangeBatch(
        mounted.end + 1,
        Math.min(rowKeys.length - 1, mounted.end + STAGING_BATCH_SIZE),
        direction,
        reason,
      );
    },
    [pendingBatch, queueRangeBatch, rowKeys.length],
  );

  const enterRecentering = useCallback(
    (targetIndex: number) => {
      recenterTargetIndexRef.current = clamp(targetIndex, 0, Math.max(0, rowKeys.length - 1));
      cancelBatch();
      mountedRef.current = null;
      setPhaseState('RECENTERING');
      triggerRender();
    },
    [cancelBatch, rowKeys.length, setPhaseState, triggerRender],
  );

  const maybeUpdateMountedForScroll = useCallback(() => {
    const container = containerRef.current;
    const mounted = mountedRef.current;
    if (!container || !mounted || rowKeys.length === 0) return;
    if (phaseRef.current !== 'READY') return;
    if (pendingPrependRestoreRef.current) return;

    const desired = deriveDesiredRange(container.scrollTop, container.clientHeight);
    if (!desired) return;

    if (desired.start < mounted.start - RECENTER_ROW_THRESHOLD || desired.end > mounted.end + RECENTER_ROW_THRESHOLD) {
      const visible = deriveVisibleRange(container.scrollTop, container.clientHeight);
      const targetIndex = visible ? Math.floor((visible.start + visible.end) / 2) : desired.start;
      logVirtualScroll('recenter-eval', {
        reason: 'mounted-outside-threshold',
        mounted,
        desired,
        visible,
        threshold: RECENTER_ROW_THRESHOLD,
        startGap: mounted.start - desired.start,
        endGap: desired.end - mounted.end,
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        pendingBatch: pendingBatch
          ? {
              reason: pendingBatch.reason,
              direction: pendingBatch.direction,
              size: pendingBatch.keys.length,
            }
          : null,
        pendingScrollToBottom: pendingScrollToBottomRef.current,
        pendingScrollToBottomSource: pendingScrollToBottomSourceRef.current,
      });
      logVirtualScroll('recenter-trigger', {
        mounted,
        desired,
        visible,
        targetIndex,
        scrollTop: container.scrollTop,
        pendingScrollKey: pendingScrollKeyRef.current,
        pendingScrollMessageId: pendingScrollMessageIdRef.current,
        initialAnchor: formatAnchorForLog(initialAnchorRef.current),
      });
      if (
        !pendingScrollMessageIdRef.current &&
        !initialAnchorConsumedRef.current &&
        initialAnchorRef.current.type === 'message'
      ) {
        pendingScrollMessageIdRef.current = initialAnchorRef.current.messageId;
        pendingScrollBehaviorRef.current = 'auto';
        logVirtualScroll('recenter-seeded-pending-message-scroll', {
          messageId: initialAnchorRef.current.messageId,
          targetIndex,
          source: 'initial-anchor',
        });
      }
      enterRecentering(targetIndex);
      return;
    }

    if (allMeasured(desired.start, desired.end)) {
      updateMountedRange(capRange(desired, rowKeys.length - 1));
      return;
    }

    if (pendingBatch) return;

    const firstMissing = firstUnmeasuredInRange(desired.start, desired.end);
    if (firstMissing === -1) return;

    if (firstMissing < mounted.start) {
      logVirtualScroll('preload-trigger', {
        direction: 'backward',
        mounted,
        desired,
        firstMissing,
        scrollTop: container.scrollTop,
      });
      queueAdjacentBatch('backward', 'preload');
      return;
    }
    if (firstMissing > mounted.end) {
      logVirtualScroll('preload-trigger', {
        direction: 'forward',
        mounted,
        desired,
        firstMissing,
        scrollTop: container.scrollTop,
      });
      queueAdjacentBatch('forward', 'preload');
      return;
    }

    const start = Math.max(0, firstMissing - Math.floor(STAGING_BATCH_SIZE / 2));
    const end = Math.min(rowKeys.length - 1, start + STAGING_BATCH_SIZE - 1);
    logVirtualScroll('preload-trigger', {
      direction: firstMissing <= desired.start ? 'backward' : 'forward',
      mounted,
      desired,
      firstMissing,
      start,
      end,
      scrollTop: container.scrollTop,
    });
    queueRangeBatch(start, end, firstMissing <= desired.start ? 'backward' : 'forward', 'preload');
  }, [
    allMeasured,
    deriveDesiredRange,
    deriveVisibleRange,
    enterRecentering,
    firstUnmeasuredInRange,
    pendingBatch,
    queueAdjacentBatch,
    queueRangeBatch,
    rowKeys.length,
    updateMountedRange,
  ]);

  const ensureBottomMeasured = useCallback(() => {
    if (rowKeys.length === 0) {
      console.debug('[msg-trace] ensureBottomMeasured:bail', {
        rowCount: rowKeys.length,
        pendingBatch: null,
        pendingScrollToBottom: pendingScrollToBottomRef.current,
      });
      return;
    }

    if (pendingBatch) {
      const mounted = mountedRef.current;
      const bottomAlreadyMounted = mounted != null && mounted.end >= rowKeys.length - 1;
      console.debug('[msg-trace] ensureBottomMeasured:bail', {
        rowCount: rowKeys.length,
        pendingBatch: { reason: pendingBatch.reason, size: pendingBatch.keys.length },
        pendingScrollToBottom: pendingScrollToBottomRef.current,
        bottomAlreadyMounted,
      });
      if (bottomAlreadyMounted && pendingScrollToBottomRef.current) {
        layoutIntentRef.current = {
          scrollToBottom: { behavior: pendingScrollToBottomBehaviorRef.current },
        };
        triggerRender();
      }
      return;
    }

    const container = containerRef.current;
    const fallbackRange = { start: Math.max(0, rowKeys.length - BOOTSTRAP_BOTTOM_SEED), end: rowKeys.length - 1 };
    const targetScrollTop = container ? roundScrollValue(container.scrollHeight - container.clientHeight) : 0;
    const desiredRange = container ? deriveDesiredRange(targetScrollTop, container.clientHeight) : null;
    const range = desiredRange ? capRange(desiredRange, rowKeys.length - 1) : fallbackRange;
    const alreadyMeasured = allMeasured(range.start, range.end);
    logVirtualScroll('ensure-bottom-measured', {
      start: range.start,
      end: range.end,
      alreadyMeasured,
      desiredRange,
      targetScrollTop,
      pendingScrollToBottom: pendingScrollToBottomRef.current,
      pendingScrollToBottomBehavior: pendingScrollToBottomBehaviorRef.current,
      pendingScrollToBottomSource: pendingScrollToBottomSourceRef.current,
      mounted: mountedRef.current,
    });
    if (alreadyMeasured) {
      updateMountedRange(range);
      layoutIntentRef.current = {
        scrollToBottom: { behavior: pendingScrollToBottomBehaviorRef.current },
      };
      triggerRender();
      return;
    }

    queueRangeBatch(range.start, range.end, 'forward', 'jump');
  }, [
    allMeasured,
    deriveDesiredRange,
    pendingBatch,
    queueRangeBatch,
    rowKeys.length,
    triggerRender,
    updateMountedRange,
  ]);

  const handleMountedMeasure = useCallback(
    (key: string, height: number) => {
      const index = keyToIndex.get(key);
      if (index == null) return;
      const rowModel = rows[index];
      const attachments = rowModel?.type === 'group' ? rowModel.messages.flatMap((m) => m.attachments ?? []) : [];
      const hasAttachments = attachments.length > 0;
      const hasUnknownAttachmentDimensions = attachments.some(
        (attachment) =>
          (attachment.kind.startsWith('image/') || attachment.kind.startsWith('video/')) &&
          (!(attachment.width && attachment.width > 0) || !(attachment.height && attachment.height > 0)),
      );

      const previousHeight = treeRef.current.get(index);
      if (previousHeight === height && heightCacheRef.current.get(key) === height) return;

      treeRef.current.set(index, height);
      heightCacheRef.current.set(key, height);

      const container = containerRef.current;
      const rowNode = rowRefsMap.current.get(key);
      if (!container || !rowNode) return;

      // Skip auto-scroll while backgrounded to preserve read position.
      if (isAtBottomRef.current && !isPageHidden()) {
        logVirtualScroll('mounted-row-resize', {
          key,
          index,
          phase: phaseRef.current,
          hasAttachments,
          hasUnknownAttachmentDimensions,
          attachmentKinds: attachments.map((attachment) => attachment.kind),
          previousHeight,
          nextHeight: height,
          delta: height - previousHeight,
          scrollTop: container.scrollTop,
          strategy: 'bottom-lock',
        });
        scrollToBottomInternal();
        scheduleBottomSettle();
        return;
      }

      const delta = height - previousHeight;
      if (delta === 0) return;
      const preserveContribution =
        visiblePrefixHeight(rowNode.offsetTop, height, container.scrollTop) -
        visiblePrefixHeight(rowNode.offsetTop, previousHeight, container.scrollTop);
      if (preserveContribution !== 0) {
        const nextScrollTop = roundScrollValue(container.scrollTop + preserveContribution);
        logVirtualScroll('mounted-row-resize', {
          key,
          index,
          phase: phaseRef.current,
          hasAttachments,
          hasUnknownAttachmentDimensions,
          attachmentKinds: attachments.map((attachment) => attachment.kind),
          previousHeight,
          nextHeight: height,
          delta,
          preserveContribution,
          scrollTop: container.scrollTop,
          nextScrollTop,
          rowOffsetTop: rowNode.offsetTop,
          strategy: 'preserve-above-viewport',
        });
        if (hasMeaningfulScrollDelta(container.scrollTop, nextScrollTop)) {
          container.scrollTop = nextScrollTop;
        }
      } else {
        logVirtualScroll('mounted-row-resize', {
          key,
          index,
          phase: phaseRef.current,
          hasAttachments,
          hasUnknownAttachmentDimensions,
          attachmentKinds: attachments.map((attachment) => attachment.kind),
          previousHeight,
          nextHeight: height,
          delta,
          preserveContribution,
          scrollTop: container.scrollTop,
          rowOffsetTop: rowNode.offsetTop,
          strategy: 'natural-reflow',
        });
      }
      // Row geometry changed (image loaded, content reflow). Recompute the
      // last-visible / floating-avatar state so coverage doesn't lag a frame
      // behind the new layout — the natural-reflow path (preserveContribution
      // === 0) doesn't touch scrollTop, so without this the stale geometry
      // would persist until the next user scroll.
      updateLastFullyVisibleMessage();
    },
    [keyToIndex, rows, scheduleBottomSettle, scrollToBottomInternal, updateLastFullyVisibleMessage],
  );

  const handleScrollIdle = useCallback(() => {
    maybeUpdateMountedForScroll();
    setScrollActivity(false);

    const distances = scrollDistances();
    if (!distances) return;

    const atTopEdge = isAtTopEdge();
    const atBottomEdge = isAtBottomEdge();

    logVirtualScroll('scroll-idle', {
      phase: phaseRef.current,
      topDistance: distances.fromTop,
      bottomDistance: distances.fromBottom,
      atTopEdge,
      atBottomEdge,
      loadOlderLoading: !!loadOlder.loading,
      loadNewerLoading: !!loadNewer?.loading,
      loadOlderHasMore: loadOlder.hasMore,
      loadNewerHasMore: !!loadNewer?.hasMore,
      mounted: mountedRef.current,
      pendingBatch: pendingBatch?.keys.length ?? 0,
      logicalAtBottom: isAtBottomRef.current,
      pendingScrollToBottom: pendingScrollToBottomRef.current,
      pendingScrollMessageId: pendingScrollMessageIdRef.current,
    });

    if (pendingScrollMessageIdRef.current) {
      logVirtualScroll('scroll-idle-navigation-lock', {
        phase: phaseRef.current,
        messageId: pendingScrollMessageIdRef.current,
        atTopEdge,
        atBottomEdge,
      });
      return;
    }

    if (atTopEdge) {
      if (loadOlder.hasMore && !loadOlder.loading && topLoadArmedRef.current) {
        topLoadArmedRef.current = false;
        logVirtualScroll('load-older-trigger', { reason: 'idle-top-edge' });
        loadOlder.onLoad();
      }
    }

    if (atBottomEdge && loadNewer) {
      if (loadNewer.hasMore && !loadNewer.loading && bottomLoadArmedRef.current) {
        bottomLoadArmedRef.current = false;
        logVirtualScroll('load-newer-trigger', {
          reason: 'idle-bottom-edge',
          logicalAtBottom: isAtBottomRef.current,
          hasMore: loadNewer.hasMore,
        });
        loadNewer.onLoad();
      }
    }
    updateLastFullyVisibleMessage();
  }, [
    isAtBottomEdge,
    isAtTopEdge,
    loadNewer,
    loadOlder,
    maybeUpdateMountedForScroll,
    pendingBatch,
    scrollDistances,
    setScrollActivity,
    updateLastFullyVisibleMessage,
  ]);

  const handleScroll = useCallback(() => {
    // Immediately mark activity so updateLastFullyVisibleMessage runs with
    // scrollingRef set. This prevents a race where the scroll handler runs
    // before the native scroll activity effect updates `scrollingRef`, which
    // caused the floating date to appear and overlap a visible fixed date.
    setScrollActivity(true);
    const container = containerRef.current;
    const now = performance.now();
    if (container) {
      const recent = recentScrollPositionsRef.current;
      recent.push({ top: roundScrollValue(container.scrollTop), at: now });
      while (recent.length > 8) recent.shift();

      const jitter = detectAlternatingJitter(recent);
      if (jitter && now - lastJitterLogAtRef.current > 250) {
        lastJitterLogAtRef.current = now;
        const distances = scrollDistances();
        const payload = {
          positions: recent.map((sample) => sample.top),
          values: jitter.values,
          durationMs: jitter.durationMs,
          lastProgrammaticScroll: lastProgrammaticScrollRef.current,
          lastProgrammaticScrollAgeMs: lastProgrammaticScrollRef.current
            ? Math.round(now - lastProgrammaticScrollRef.current.at)
            : null,
          pendingBatch: pendingBatch
            ? {
                reason: pendingBatch.reason,
                direction: pendingBatch.direction,
                size: pendingBatch.keys.length,
              }
            : null,
          pendingScrollToBottom: pendingScrollToBottomRef.current,
          pendingScrollToBottomBehavior: pendingScrollToBottomBehaviorRef.current,
          pendingScrollToBottomSource: pendingScrollToBottomSourceRef.current,
          bottomSettleFramesRemaining: bottomSettleFramesRemainingRef.current,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
          topDistance: distances?.fromTop ?? null,
          bottomDistance: distances?.fromBottom ?? null,
          mounted: mountedRef.current,
        };
        logVirtualScroll('scroll-jitter-detected', payload);
        console.debug(`[ChatVirtualScroll] scroll-jitter-json ${JSON.stringify(payload)}`);
      }
    }

    // scroll activity (user vs programmatic) is handled by useNativeScrollActivity

    if (scrollRafRef.current == null) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        maybeUpdateMountedForScroll();
      });
    }

    updateAtBottom();
    updateLastFullyVisibleMessage();

    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = setTimeout(handleScrollIdle, SCROLL_IDLE_MS);

    const distances = scrollDistances();
    if (!distances) return;

    if (distances.fromTop >= EDGE_REARM_PX) {
      topLoadArmedRef.current = true;
    }
    if (distances.fromBottom >= EDGE_REARM_PX) {
      bottomLoadArmedRef.current = true;
    }
  }, [
    handleScrollIdle,
    maybeUpdateMountedForScroll,
    pendingBatch,
    scrollDistances,
    updateAtBottom,
    updateLastFullyVisibleMessage,
    setScrollActivity,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const mutation = classifyKeyMutation(prevKeysRef.current, rowKeys);
    const intent = layoutIntentRef.current;

    // Sticky-avatar grouping merges same-sender messages into one group row, so a
    // new message that joins the last group leaves rowKeys unchanged and
    // classifyKeyMutation reports 'none'. Detect that case by comparing the last
    // message id so the append-bottom-lock auto-scroll still fires.
    let treatAsAppend = mutation === 'append';
    if (mutation === 'none') {
      let currentLastMessageId: string | null = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.type === 'group') {
          currentLastMessageId = row.lastMessageId;
          break;
        }
      }
      if (currentLastMessageId != null && currentLastMessageId !== lastKnownLastMessageIdRef.current) {
        treatAsAppend = true;
      }
    }

    if (intent?.preserveHeightDelta && intent.preserveHeightDelta !== 0) {
      const nextScrollTop = roundScrollValue(container.scrollTop + intent.preserveHeightDelta);
      if (hasMeaningfulScrollDelta(container.scrollTop, nextScrollTop)) {
        logVirtualScroll('scroll-position-write', {
          source: 'preserveHeightDelta',
          preserveHeightDelta: intent.preserveHeightDelta,
          from: container.scrollTop,
          to: nextScrollTop,
          direction: scrollDirection(container.scrollTop, nextScrollTop),
        });
        lastProgrammaticScrollRef.current = {
          source: 'preserveHeightDelta',
          at: performance.now(),
          from: container.scrollTop,
          to: nextScrollTop,
        };
        container.scrollTop = nextScrollTop;
      }
    }

    if (intent?.scrollToBottom) {
      logVirtualScroll('layout-intent-scroll-to-bottom', {
        pendingScrollToBottom: pendingScrollToBottomRef.current,
        pendingScrollToBottomBehavior: intent.scrollToBottom.behavior,
        pendingScrollToBottomSource: pendingScrollToBottomSourceRef.current,
        mounted: mountedRef.current,
      });
      scrollToBottomInternal(intent.scrollToBottom.behavior);
      scheduleBottomSettle();
      pendingScrollToBottomRef.current = false;
      pendingScrollToBottomBehaviorRef.current = 'auto';
      pendingScrollToBottomSourceRef.current = null;
    }

    if (intent?.scrollToMessageId) {
      const target = resolveMessageTarget(intent.scrollToMessageId.messageId);
      logVirtualScroll('layout-intent-scroll-to-message', {
        messageId: intent.scrollToMessageId.messageId,
        resolvedKey: target?.key ?? null,
        behavior: intent.scrollToMessageId.behavior,
        mounted: mountedRef.current,
      });
      if (target) {
        const scrolled = scrollToKeyInternal(
          target.key,
          intent.scrollToMessageId.behavior,
          intent.scrollToMessageId.align ?? 'top',
          intent.scrollToMessageId.offsetRatio,
        );
        if (scrolled && pendingScrollMessageIdRef.current === intent.scrollToMessageId.messageId) {
          pendingScrollMessageIdRef.current = null;
          pendingScrollAlignRef.current = intent.scrollToMessageId.align ?? 'top';
          if (
            initialAnchorRef.current.type === 'message' &&
            initialAnchorRef.current.messageId === intent.scrollToMessageId.messageId
          ) {
            initialAnchorConsumedRef.current = true;
          }
        }
        if (scrolled) {
          // Skip highlight only when resuming to the very latest message (all read →
          // no jump). Compare by messageId, not row index: with sticky-avatar grouping
          // the last group row holds multiple messages, so a row-index check would
          // wrongly suppress the unread-divider flash whenever the last-read message
          // shares the final group with later unread messages.
          const lastRow = rows[rows.length - 1];
          const latestMessageId = lastRow?.type === 'group' ? lastRow.lastMessageId : null;
          if (intent.scrollToMessageId.messageId !== latestMessageId) {
            triggerJumpTargetHighlight(target.key, intent.scrollToMessageId.messageId);
          }
        }
      } else {
        logVirtualScroll('layout-intent-scroll-to-message-missed', {
          messageId: intent.scrollToMessageId.messageId,
          behavior: intent.scrollToMessageId.behavior,
        });
      }
    }

    if (intent?.scrollToKey) {
      logVirtualScroll('layout-intent-scroll-to-item', {
        key: intent.scrollToKey.key,
        behavior: intent.scrollToKey.behavior,
        mounted: mountedRef.current,
      });
      const scrolled = scrollToKeyInternal(intent.scrollToKey.key, intent.scrollToKey.behavior);
      if (scrolled && pendingScrollKeyRef.current === intent.scrollToKey.key) {
        pendingScrollKeyRef.current = null;
      }
      if (scrolled) {
        triggerJumpTargetHighlight(intent.scrollToKey.key);
      }
    }

    if (pendingScrollKeyRef.current && !intent?.scrollToKey) {
      const targetRow = rowRefsMap.current.get(pendingScrollKeyRef.current);
      if (targetRow) {
        logVirtualScroll('pending-scroll-to-item-execute', {
          key: pendingScrollKeyRef.current,
          behavior: pendingScrollBehaviorRef.current,
          mounted: mountedRef.current,
        });
        const scrolled = scrollToKeyInternal(pendingScrollKeyRef.current, pendingScrollBehaviorRef.current);
        if (scrolled) {
          triggerJumpTargetHighlight(pendingScrollKeyRef.current);
          pendingScrollKeyRef.current = null;
        }
      }
    }

    const pendingPrependRestore = pendingPrependRestoreRef.current;
    const pendingPrependCompensation = pendingPrependCompensationRef.current;
    if (pendingPrependCompensation && pendingPrependCompensation !== 0) {
      const nextScrollTop = roundScrollValue(container.scrollTop + pendingPrependCompensation);
      logMutationSnapshot('prepend-height-compensation', {
        preserveHeightDelta: pendingPrependCompensation,
        from: container.scrollTop,
        to: nextScrollTop,
      });
      lastProgrammaticScrollRef.current = {
        source: 'prepend-height-compensation',
        at: performance.now(),
        from: container.scrollTop,
        to: nextScrollTop,
      };
      container.scrollTop = nextScrollTop;
      pendingPrependCompensationRef.current = null;
    }

    const pendingLayoutAnchorRestore = pendingLayoutAnchorRestoreRef.current;
    if (pendingLayoutAnchorRestore) {
      logVirtualScroll('layout-anchor-restore-attempt', {
        source: pendingLayoutAnchorRestore.source,
        key: pendingLayoutAnchorRestore.key,
        offsetTop: pendingLayoutAnchorRestore.offsetTop,
      });
      const restored = restoreAnchorOffset(pendingLayoutAnchorRestore.key, pendingLayoutAnchorRestore.offsetTop);
      if (restored) {
        pendingLayoutAnchorRestoreRef.current = null;
        logVirtualScroll('layout-anchor-restore-complete', {
          source: pendingLayoutAnchorRestore.source,
          key: pendingLayoutAnchorRestore.key,
        });
      }
    }

    if (pendingPrependRestore) {
      logMutationSnapshot('prepend-restore-attempt', {
        key: pendingPrependRestore.key,
        offsetTop: pendingPrependRestore.offsetTop,
      });
      const restored = restoreAnchorOffset(pendingPrependRestore.key, pendingPrependRestore.offsetTop);
      if (restored) {
        pendingPrependRestoreRef.current = null;
        mutationSnapshotRef.current = null;
        logVirtualScroll('prepend-restore-complete');
      } else {
        logMutationSnapshot('prepend-restore-missed-anchor', {
          key: pendingPrependRestore.key,
        });
      }
    }

    const pendingDeleteRestore = pendingDeleteRestoreRef.current;
    if (pendingDeleteRestore) {
      logVirtualScroll('delete-restore-attempt', {
        key: pendingDeleteRestore.key,
        offsetTop: pendingDeleteRestore.offsetTop,
      });
      let restored = restoreAnchorOffset(pendingDeleteRestore.key, pendingDeleteRestore.offsetTop);
      if (!restored) {
        // Anchor was deleted — walk backward to find nearest surviving key
        const oldKeys = prevKeysRef.current;
        const oldIndex = oldKeys.indexOf(pendingDeleteRestore.key);
        for (let i = oldIndex - 1; i >= 0; i--) {
          if (keyToIndex.has(oldKeys[i])) {
            restored = restoreAnchorOffset(oldKeys[i], pendingDeleteRestore.offsetTop);
            if (restored) logVirtualScroll('delete-restore-fallback', { key: oldKeys[i] });
            break;
          }
        }
      } else {
        logVirtualScroll('delete-restore-complete');
      }
      pendingDeleteRestoreRef.current = null;
      mutationSnapshotRef.current = null;
    }

    const pendingAnchorDriftCheck = pendingAnchorDriftCheckRef.current;
    if (pendingAnchorDriftCheck) {
      const row = rowRefsMap.current.get(pendingAnchorDriftCheck.key);
      if (row) {
        const containerRect = container.getBoundingClientRect();
        const currentOffsetTop = roundScrollValue(row.getBoundingClientRect().top - containerRect.top);
        logVirtualScroll('anchor-drift-check', {
          source: pendingAnchorDriftCheck.source,
          key: pendingAnchorDriftCheck.key,
          expectedOffsetTop: pendingAnchorDriftCheck.offsetTop,
          actualOffsetTop: currentOffsetTop,
          drift: currentOffsetTop - pendingAnchorDriftCheck.offsetTop,
          scrollTop: container.scrollTop,
        });
        pendingAnchorDriftCheckRef.current = null;
      }
    }

    if (mutation !== 'none') {
      console.debug('[msg-trace] vs:layoutEffect:mutation', {
        mutation,
        phase: phaseRef.current,
        isAtBottom: isAtBottomRef.current,
        pendingScrollToBottom: pendingScrollToBottomRef.current,
        hasScrollToKeyIntent: !!intent?.scrollToKey,
        prevKeyCount: prevKeysRef.current.length,
        nextKeyCount: rowKeys.length,
        mounted: mountedRef.current,
      });
    }

    if (mutation === 'reset' && rowKeys.length > 0) {
      logVirtualScroll('rows-reset', {
        previousCount: prevKeysRef.current.length,
        nextCount: rowKeys.length,
      });
      cancelBatch();
      mountedRef.current = null;
      setPhaseState(containerHeight > 0 ? 'BOOTSTRAP' : 'WAITING_VIEWPORT');
      triggerRender();
    } else if (
      treatAsAppend &&
      (isAtBottomRef.current || pendingScrollToBottomRef.current) &&
      !isPageHidden() && // skip auto-scroll while backgrounded
      !intent?.scrollToKey
    ) {
      logVirtualScroll('append-bottom-lock', {
        pendingScrollToBottom: pendingScrollToBottomRef.current,
        pendingScrollToBottomBehavior: pendingScrollToBottomBehaviorRef.current,
        pendingScrollToBottomSource: pendingScrollToBottomSourceRef.current,
        visualBottomDistance: container.scrollHeight - (container.scrollTop + container.clientHeight),
        mounted: mountedRef.current,
      });
      if (!pendingScrollToBottomRef.current) {
        pendingScrollToBottomRef.current = true;
        pendingScrollToBottomBehaviorRef.current = 'smooth';
        pendingScrollToBottomSourceRef.current = 'append-detected';
      }
      ensureBottomMeasured();
    } else if (treatAsAppend) {
      logVirtualScroll('append-preserve-natural-position', {
        logicalAtBottom: isAtBottomRef.current,
        visualBottomDistance: container.scrollHeight - (container.scrollTop + container.clientHeight),
      });
    }

    updateAtBottom();
    updateLastFullyVisibleMessage();
    layoutIntentRef.current = null;
    prevKeysRef.current = rowKeys;
    // Track the last message id so the next render can detect a same-sender
    // message merging into the final group (mutation 'none' but content grew).
    {
      let lastId: string | null = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.type === 'group') {
          lastId = row.lastMessageId;
          break;
        }
      }
      lastKnownLastMessageIdRef.current = lastId;
    }
  }, [
    rowKeys,
    rowKeys.length,
    renderTick,
    cancelBatch,
    containerHeight,
    ensureBottomMeasured,
    restoreAnchorOffset,
    scheduleBottomSettle,
    logMutationSnapshot,
    resolveMessageTarget,
    scrollToBottomInternal,
    scrollToKeyInternal,
    setPhaseState,
    triggerRender,
    triggerJumpTargetHighlight,
    updateAtBottom,
    updateLastFullyVisibleMessage,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !debugVirtualScroll) return;

    const mounted = mountedRef.current;
    const topSpacer = mounted ? topSpacerHeight() : 0;
    const bottomSpacer = mounted ? bottomSpacerHeight() : 0;
    const mountedContentHeight = mounted ? heightBetween(mounted.start, mounted.end + 1) : 0;
    const contentPaddingTop = loadOlder.hasMore || loadOlder.loading ? EDGE_HINT_HEIGHT : 0;
    const mountedTop = topSpacer + contentPaddingTop;
    const mountedBottom = mountedTop + mountedContentHeight;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const mountedIntersectsViewport = mountedBottom > viewportTop && mountedTop < viewportBottom;
    const mountedVisibleHeight = mounted
      ? Math.max(0, Math.min(mountedBottom, viewportBottom) - Math.max(mountedTop, viewportTop))
      : 0;
    const showLoadingScrim = phase === 'WAITING_VIEWPORT' || phase === 'BOOTSTRAP' || phase === 'RECENTERING';

    logVirtualScroll('render-state', {
      phase,
      rowCount: rowKeys.length,
      mounted,
      pendingBatch: pendingBatch
        ? {
            reason: pendingBatch.reason,
            direction: pendingBatch.direction,
            size: pendingBatch.keys.length,
            firstKey: pendingBatch.keys[0] ?? null,
            lastKey: pendingBatch.keys[pendingBatch.keys.length - 1] ?? null,
          }
        : null,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      topSpacer,
      bottomSpacer,
      mountedContentHeight,
      mountedTop,
      mountedBottom,
      mountedIntersectsViewport,
      mountedVisibleHeight,
      initialAnchor: formatAnchorForLog(initialAnchorRef.current),
      showLoadingScrim,
      bootstrapRevealState:
        phase === 'BOOTSTRAP'
          ? {
              mountedSize: rangeSize(mounted),
              mountedIntersectsViewport,
              mountedVisibleHeight,
              pendingBatchSize: pendingBatch?.keys.length ?? 0,
            }
          : null,
    });
  }, [
    bottomSpacerHeight,
    heightBetween,
    loadOlder.hasMore,
    loadOlder.loading,
    pendingBatch,
    phase,
    renderTick,
    rowKeys.length,
    topSpacerHeight,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let previousHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = container.clientHeight;
      if (nextHeight === previousHeight) return;
      const heightDelta = previousHeight - nextHeight;
      previousHeight = nextHeight;
      setContainerHeight(nextHeight);

      if (phaseRef.current === 'WAITING_VIEWPORT' && nextHeight > 0) {
        setPhaseState('BOOTSTRAP');
      }

      if (phaseRef.current === 'READY') {
        if (isAtBottomRef.current) {
          scrollToBottomInternal();
          scheduleBottomSettle();
        } else if (heightDelta !== 0) {
          container.scrollTop += heightDelta;
        }
      }
    });

    setContainerHeight(container.clientHeight);
    if (phaseRef.current === 'WAITING_VIEWPORT' && container.clientHeight > 0) {
      setPhaseState('BOOTSTRAP');
    }

    observer.observe(container);
    return () => observer.disconnect();
  }, [scheduleBottomSettle, scrollToBottomInternal, setPhaseState]);

  useEffect(() => {
    const node = headerRef.current;
    if (!node) {
      setHeaderHeight(0);
      return;
    }

    const observer = new ResizeObserver(() => {
      setHeaderHeight(node.getBoundingClientRect().height);
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [header]);

  useEffect(() => {
    rowRefsMap.current.clear();
    cancelBatch();
    mountedRef.current = null;
    recenterTargetIndexRef.current = null;
    pendingScrollKeyRef.current = null;
    pendingScrollMessageIdRef.current = null;
    initialAnchorConsumedRef.current = false;
    pendingScrollToBottomRef.current = false;
    pendingScrollAlignRef.current = 'top';
    pendingScrollToBottomBehaviorRef.current = 'auto';
    pendingScrollToBottomSourceRef.current = null;
    pendingPrependRestoreRef.current = null;
    pendingDeleteRestoreRef.current = null;
    pendingPrependCompensationRef.current = null;
    pendingLayoutAnchorRestoreRef.current = null;
    mutationSnapshotRef.current = null;
    layoutIntentRef.current = null;
    prevKeysRef.current = rowKeys;

    if (bottomSettleRafRef.current != null) {
      cancelAnimationFrame(bottomSettleRafRef.current);
      bottomSettleRafRef.current = null;
    }

    const container = containerRef.current;
    if (container) {
      logVirtualScroll('initial-anchor-reset-effect', {
        anchor: formatAnchorForLog(initialAnchor),
        previousScrollTop: container.scrollTop,
        rowCount: rowKeys.length,
      });
      container.scrollTop = 0;
    }

    isAtBottomRef.current = initialAnchor.type === 'bottom';
    onAtBottomChange?.(initialAnchor.type === 'bottom');
    lastFullyVisibleMessageIdRef.current = null;
    onLastFullyVisibleMessageChange?.(null);
    setPhaseState(containerHeight > 0 ? 'BOOTSTRAP' : 'WAITING_VIEWPORT');
    triggerRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAnchor.token]);

  useEffect(() => {
    if (phase !== 'BOOTSTRAP') return;
    if (pendingBatch || containerHeight <= 0) return;
    if (rowKeys.length === 0) {
      if (!loadOlder.loading && !loadNewer?.loading) {
        setPhaseState('READY');
        triggerRender();
      }
      return;
    }

    const mounted = mountedRef.current;
    const anchor = initialAnchorRef.current;

    if (!mounted) {
      if (anchor.type === 'bottom') {
        queueRangeBatch(
          Math.max(0, rowKeys.length - BOOTSTRAP_BOTTOM_SEED),
          rowKeys.length - 1,
          'backward',
          'bootstrap',
        );
      } else if (anchor.type === 'top') {
        queueRangeBatch(0, Math.min(rowKeys.length - 1, BOOTSTRAP_BOTTOM_SEED - 1), 'forward', 'bootstrap');
      } else {
        const anchorIndex = resolveMessageTarget(anchor.messageId)?.index ?? rowKeys.length - 1;
        queueRangeBatch(
          Math.max(0, anchorIndex - BOOTSTRAP_ITEM_RADIUS),
          Math.min(rowKeys.length - 1, anchorIndex + BOOTSTRAP_ITEM_RADIUS),
          'forward',
          'bootstrap',
        );
      }
      return;
    }

    if (anchor.type === 'bottom' || anchor.type === 'top') {
      const measuredHeight = heightBetween(mounted.start, mounted.end + 1);
      const currentTopSpacer = offsetOf(mounted.start);
      const currentMountedBottom = currentTopSpacer + measuredHeight;
      const viewportTop = containerRef.current?.scrollTop ?? 0;
      const viewportBottom = viewportTop + (containerRef.current?.clientHeight ?? 0);

      const hasMoreToLoad = anchor.type === 'bottom' ? mounted.start > 0 : mounted.end < rowKeys.length - 1;

      if (measuredHeight < containerHeight * BOOTSTRAP_HEIGHT_MULTIPLIER && hasMoreToLoad) {
        logVirtualScroll('bootstrap-viewport-coverage', {
          anchor: formatAnchorForLog(anchor),
          mounted,
          measuredHeight,
          containerHeight,
          topSpacer: currentTopSpacer,
          mountedBottom: currentMountedBottom,
          viewportTop,
          viewportBottom,
          intersectsViewport: currentMountedBottom > viewportTop && currentTopSpacer < viewportBottom,
          reason: 'insufficient-measured-height',
        });
        if (anchor.type === 'bottom') {
          queueRangeBatch(Math.max(0, mounted.start - STAGING_BATCH_SIZE), mounted.start - 1, 'backward', 'bootstrap');
        } else {
          queueRangeBatch(
            mounted.end + 1,
            Math.min(rowKeys.length - 1, mounted.end + STAGING_BATCH_SIZE),
            'forward',
            'bootstrap',
          );
        }
        return;
      }

      logVirtualScroll('bootstrap-ready', {
        anchor: formatAnchorForLog(anchor),
        measuredHeight,
        containerHeight,
        mounted,
        topSpacer: currentTopSpacer,
        mountedBottom: currentMountedBottom,
        viewportTop,
        viewportBottom,
        action: anchor.type === 'bottom' ? 'scrollToBottom' : 'keep-at-top',
      });
      if (anchor.type === 'bottom') {
        layoutIntentRef.current = { scrollToBottom: { behavior: 'auto' } };
      }
      // top: container is already at scrollTop = 0 from the reset effect
      updateMountedRange(capRange(mounted, rowKeys.length - 1));
      setPhaseState('READY');
      triggerRender();
      return;
    }

    const anchorIndex = resolveMessageTarget(anchor.messageId)?.index ?? rowKeys.length - 1;
    const heightBelowAnchor = heightBetween(Math.max(anchorIndex + 1, mounted.start), mounted.end + 1);
    if (heightBelowAnchor < containerHeight && mounted.end < rowKeys.length - 1) {
      queueRangeBatch(
        mounted.end + 1,
        Math.min(rowKeys.length - 1, mounted.end + STAGING_BATCH_SIZE),
        'forward',
        'bootstrap',
      );
      return;
    }

    const measuredHeight = heightBetween(mounted.start, mounted.end + 1);
    if (measuredHeight < containerHeight * BOOTSTRAP_HEIGHT_MULTIPLIER && mounted.start > 0) {
      queueRangeBatch(Math.max(0, mounted.start - STAGING_BATCH_SIZE), mounted.start - 1, 'backward', 'bootstrap');
      return;
    }

    logVirtualScroll('bootstrap-ready', {
      anchor: formatAnchorForLog(anchor),
      measuredHeight,
      containerHeight,
      mounted,
      action: 'scrollToMessageId',
    });
    pendingScrollMessageIdRef.current = anchor.messageId;
    pendingScrollAlignRef.current = anchor.align ?? 'bottom';
    pendingScrollOffsetRatioRef.current = anchor.offsetRatio ?? DEFAULT_OFFSET_RATIO;

    pendingScrollBehaviorRef.current = 'auto';
    updateMountedRange(capRange(mounted, rowKeys.length - 1));
    setPhaseState('READY');
    triggerRender();
  }, [
    containerHeight,
    heightBetween,
    offsetOf,
    pendingBatch,
    phase,
    queueRangeBatch,
    resolveMessageTarget,
    loadNewer?.loading,
    loadOlder.loading,
    rowKeys.length,
    setPhaseState,
    triggerRender,
    updateMountedRange,
  ]);

  useEffect(() => {
    if (phase !== 'RECENTERING') return;
    if (pendingBatch || rowKeys.length === 0 || containerHeight <= 0) return;

    const mounted = mountedRef.current;
    const container = containerRef.current;
    const targetIndex = recenterTargetIndexRef.current ?? rowKeys.length - 1;

    if (!mounted) {
      queueRangeBatch(
        Math.max(0, targetIndex - BOOTSTRAP_ITEM_RADIUS),
        Math.min(rowKeys.length - 1, targetIndex + BOOTSTRAP_ITEM_RADIUS),
        'forward',
        'recenter',
      );
      return;
    }

    const desired = container ? deriveDesiredRangeForTargetIndex(targetIndex, container.clientHeight) : null;
    if (!desired) {
      updateMountedRange(capRange(mounted, rowKeys.length - 1));
      setPhaseState('READY');
      triggerRender();
      return;
    }

    if (allMeasured(desired.start, desired.end)) {
      if (!pendingScrollMessageIdRef.current && initialAnchorRef.current.type === 'message') {
        const anchorIndex = resolveMessageTarget(initialAnchorRef.current.messageId)?.index ?? null;
        logVirtualScroll('recenter-ready-without-pending-message-scroll', {
          anchor: formatAnchorForLog(initialAnchorRef.current),
          anchorIndex,
          targetIndex,
          desired,
          mounted,
          scrollTop: container?.scrollTop ?? null,
        });
      }

      updateMountedRange(capRange(desired, rowKeys.length - 1));

      if (pendingScrollMessageIdRef.current) {
        layoutIntentRef.current = {
          scrollToMessageId: {
            messageId: pendingScrollMessageIdRef.current,
            behavior: pendingScrollBehaviorRef.current,
            align: pendingScrollAlignRef.current,
            offsetRatio: pendingScrollOffsetRatioRef.current,
          },
        };
      } else if (pendingScrollKeyRef.current) {
        layoutIntentRef.current = {
          scrollToKey: { key: pendingScrollKeyRef.current, behavior: pendingScrollBehaviorRef.current },
        };
      } else if (pendingScrollToBottomRef.current) {
        logVirtualScroll('recenter-ready-with-pending-bottom-scroll', {
          targetIndex,
          desired,
          mounted,
          pendingScrollToBottomBehavior: pendingScrollToBottomBehaviorRef.current,
          pendingScrollToBottomSource: pendingScrollToBottomSourceRef.current,
        });
        layoutIntentRef.current = {
          scrollToBottom: { behavior: pendingScrollToBottomBehaviorRef.current },
        };
      }

      setPhaseState('READY');
      triggerRender();
      return;
    }

    const firstMissing = firstUnmeasuredInRange(desired.start, desired.end);
    if (firstMissing === -1) return;

    const start = Math.max(0, firstMissing - Math.floor(STAGING_BATCH_SIZE / 2));
    const end = Math.min(rowKeys.length - 1, start + STAGING_BATCH_SIZE - 1);
    queueRangeBatch(start, end, firstMissing < targetIndex ? 'backward' : 'forward', 'recenter');
  }, [
    allMeasured,
    containerHeight,
    deriveDesiredRangeForTargetIndex,
    firstUnmeasuredInRange,
    pendingBatch,
    phase,
    queueRangeBatch,
    resolveMessageTarget,
    rowKeys.length,
    setPhaseState,
    triggerRender,
    updateMountedRange,
  ]);

  useEffect(() => {
    if (phase !== 'READY') return;

    if (pendingScrollToBottomRef.current) {
      logVirtualScroll('ready-effect-pending-bottom-scroll', {
        pendingScrollToBottomBehavior: pendingScrollToBottomBehaviorRef.current,
        pendingScrollToBottomSource: pendingScrollToBottomSourceRef.current,
        mounted: mountedRef.current,
      });
      ensureBottomMeasured();
      return;
    }

    if (pendingScrollMessageIdRef.current) {
      const target = resolveMessageTarget(pendingScrollMessageIdRef.current);
      if (!target) {
        logVirtualScroll('pending-scroll-to-message-target-missed', {
          messageId: pendingScrollMessageIdRef.current,
          phase,
        });
        pendingScrollMessageIdRef.current = null;
        return;
      }

      const mounted = mountedRef.current;
      if (mounted && target.index >= mounted.start && target.index <= mounted.end) {
        layoutIntentRef.current = {
          scrollToMessageId: {
            messageId: pendingScrollMessageIdRef.current,
            behavior: pendingScrollBehaviorRef.current,
            align: pendingScrollAlignRef.current,
            offsetRatio: pendingScrollOffsetRatioRef.current,
          },
        };
        triggerRender();
        return;
      }

      enterRecentering(target.index);
      return;
    }

    if (pendingScrollKeyRef.current) {
      const targetIndex = keyToIndex.get(pendingScrollKeyRef.current);
      if (targetIndex == null) {
        pendingScrollKeyRef.current = null;
        return;
      }

      const mounted = mountedRef.current;
      if (mounted && targetIndex >= mounted.start && targetIndex <= mounted.end) {
        layoutIntentRef.current = {
          scrollToKey: { key: pendingScrollKeyRef.current, behavior: pendingScrollBehaviorRef.current },
        };
        triggerRender();
        return;
      }

      enterRecentering(targetIndex);
      return;
    }

    maybeUpdateMountedForScroll();
  }, [
    ensureBottomMeasured,
    enterRecentering,
    keyToIndex,
    maybeUpdateMountedForScroll,
    phase,
    resolveMessageTarget,
    renderTick,
    triggerRender,
  ]);

  useEffect(() => {
    if (!scrollApiRef) return;

    scrollApiRef.current = {
      scrollToBottom: (options?: ScrollToBottomOptions) => {
        pendingScrollKeyRef.current = null;
        pendingScrollMessageIdRef.current = null;
        pendingScrollToBottomRef.current = true;
        const {
          behavior = 'auto',
          ifAlreadyMountedKey,
          fallbackBehavior = 'auto',
          source = 'scrollApi.scrollToBottom',
        } = options ?? {};
        const targetIndex = ifAlreadyMountedKey ? keyToIndex.get(ifAlreadyMountedKey) : null;
        const mounted = mountedRef.current;
        const shouldUsePrimaryBehavior =
          ifAlreadyMountedKey == null ||
          (targetIndex != null && mounted != null && targetIndex >= mounted.start && targetIndex <= mounted.end);
        const resolvedBehavior = shouldUsePrimaryBehavior ? behavior : fallbackBehavior;
        pendingScrollToBottomBehaviorRef.current = resolvedBehavior;
        pendingScrollToBottomSourceRef.current = source;
        logVirtualScroll('scroll-to-bottom-requested', {
          source: pendingScrollToBottomSourceRef.current,
          requestedBehavior: behavior,
          resolvedBehavior,
          fallbackBehavior,
          shouldUsePrimaryBehavior,
          ifAlreadyMountedKey: ifAlreadyMountedKey ?? null,
          targetIndex: targetIndex ?? null,
          phase: phaseRef.current,
          mounted,
        });

        if (phaseRef.current === 'READY') {
          ensureBottomMeasured();
        }
      },
      scrollToItem: (key: string, behavior: ScrollBehavior = 'auto') => {
        const targetIndex = keyToIndex.get(key);
        if (targetIndex == null) {
          logVirtualScroll('scroll-to-item-requested', {
            key,
            requestedBehavior: behavior,
            resolvedBehavior: behavior,
            targetIndex: null,
            mounted: mountedRef.current,
            phase: phaseRef.current,
            found: false,
          });
          return;
        }

        const mounted = mountedRef.current;
        const isMounted = mounted != null && targetIndex >= mounted.start && targetIndex <= mounted.end;
        const resolvedBehavior = isMounted ? behavior : behavior === 'smooth' ? 'auto' : behavior;
        pendingScrollBehaviorRef.current = resolvedBehavior;
        pendingScrollKeyRef.current = key;
        pendingScrollMessageIdRef.current = null;
        pendingScrollToBottomRef.current = false;
        pendingScrollAlignRef.current = 'top';
        pendingScrollToBottomBehaviorRef.current = 'auto';
        pendingScrollToBottomSourceRef.current = null;
        logVirtualScroll('scroll-to-item-requested', {
          key,
          requestedBehavior: behavior,
          resolvedBehavior,
          targetIndex,
          mounted,
          phase: phaseRef.current,
          found: true,
          isMounted,
        });

        if (mounted && targetIndex >= mounted.start && targetIndex <= mounted.end) {
          const scrolled = scrollToKeyInternal(key, resolvedBehavior);
          if (scrolled) {
            triggerJumpTargetHighlight(key);
            pendingScrollKeyRef.current = null;
          }
          return;
        }

        if (phaseRef.current === 'READY') {
          logVirtualScroll('scroll-to-item-recenter-requested', {
            key,
            targetIndex,
            requestedBehavior: behavior,
            resolvedBehavior,
            mounted,
          });
          enterRecentering(targetIndex);
        }
      },
      scrollToMessageId: (
        messageId: string,
        behavior: ScrollBehavior = 'auto',
        align: 'top' | 'bottom' | 'custom' = 'top',
        offsetRatio: number = DEFAULT_OFFSET_RATIO,
      ) => {
        const target = resolveMessageTarget(messageId);
        if (!target) {
          logVirtualScroll('scroll-to-message-requested', {
            messageId,
            requestedBehavior: behavior,
            resolvedBehavior: behavior,
            targetIndex: null,
            targetKey: null,
            mounted: mountedRef.current,
            phase: phaseRef.current,
            found: false,
          });
          return;
        }

        const mounted = mountedRef.current;
        const isMounted = mounted != null && target.index >= mounted.start && target.index <= mounted.end;
        const resolvedBehavior = isMounted ? behavior : behavior === 'smooth' ? 'auto' : behavior;
        pendingScrollBehaviorRef.current = resolvedBehavior;
        pendingScrollMessageIdRef.current = messageId;
        pendingScrollKeyRef.current = null;
        pendingScrollToBottomRef.current = false;
        pendingScrollAlignRef.current = align;
        pendingScrollOffsetRatioRef.current = offsetRatio;
        pendingScrollToBottomBehaviorRef.current = 'auto';
        pendingScrollToBottomSourceRef.current = null;
        logVirtualScroll('scroll-to-message-requested', {
          messageId,
          requestedBehavior: behavior,
          resolvedBehavior,
          targetIndex: target.index,
          targetKey: target.key,
          mounted,
          phase: phaseRef.current,
          found: true,
          isMounted,
        });

        if (mounted && target.index >= mounted.start && target.index <= mounted.end) {
          const scrolled = scrollToKeyInternal(target.key, resolvedBehavior, align, offsetRatio);
          if (scrolled) {
            // Skip highlight when resuming the latest message — no jump is happening.
            if (target.index < rowKeys.length - 1) {
              triggerJumpTargetHighlight(target.key, messageId);
            }
            pendingScrollMessageIdRef.current = null;
          }
          return;
        }

        if (phaseRef.current === 'READY') {
          logVirtualScroll('scroll-to-message-recenter-requested', {
            messageId,
            targetIndex: target.index,
            targetKey: target.key,
            requestedBehavior: behavior,
            resolvedBehavior,
            mounted,
          });
          enterRecentering(target.index);
        }
      },
    };

    return () => {
      if (scrollApiRef.current) {
        scrollApiRef.current = null;
      }
    };
  }, [
    rowKeys.length,
    ensureBottomMeasured,
    enterRecentering,
    keyToIndex,
    resolveMessageTarget,
    scrollApiRef,
    scrollToKeyInternal,
    triggerJumpTargetHighlight,
  ]);

  useEffect(() => {
    return () => {
      setScrollActivity(false);
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
      if (bottomSettleRafRef.current != null) cancelAnimationFrame(bottomSettleRafRef.current);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [setScrollActivity]);

  const adjustPrevKeysRef = useRef<string[]>([]);
  if (rowKeys !== adjustPrevKeysRef.current) {
    if (adjustPrevKeysRef.current.length > 0) {
      const mutation = classifyKeyMutation(adjustPrevKeysRef.current, rowKeys);
      if (pendingBatch) {
        const missingPendingKeys = pendingBatch.keys.filter((key) => !keyToIndex.has(key));
        logVirtualScroll('row-mutation-during-pending-batch', {
          mutation,
          pendingBatch: {
            reason: pendingBatch.reason,
            direction: pendingBatch.direction,
            size: pendingBatch.keys.length,
            firstKey: pendingBatch.keys[0] ?? null,
            lastKey: pendingBatch.keys[pendingBatch.keys.length - 1] ?? null,
          },
          mounted: mountedRef.current,
          recenterTargetIndex: recenterTargetIndexRef.current,
          missingPendingKeysCount: missingPendingKeys.length,
          missingPendingKeysSample: missingPendingKeys.slice(0, 6),
        });
      }
      if (mutation === 'prepend') {
        const anchor = captureVisibleAnchor();
        pendingPrependRestoreRef.current = anchor;
        mutationSnapshotRef.current = {
          mutation,
          anchor,
          rowCountDelta: rowKeys.length - adjustPrevKeysRef.current.length,
        };
        logMutationSnapshot('prepend-detected', {
          previousCount: adjustPrevKeysRef.current.length,
          nextCount: rowKeys.length,
        });
        const prependCount = rowKeys.length - adjustPrevKeysRef.current.length;
        pendingPrependCompensationRef.current = heightBetween(0, prependCount);
        const mounted = mountedRef.current;
        if (mounted) {
          const expandedRange = {
            start: Math.max(0, mounted.start),
            end: Math.min(rowKeys.length - 1, mounted.end + prependCount),
          };
          mountedRef.current = {
            start: expandedRange.start,
            end: expandedRange.end,
          };
          logMutationSnapshot('prepend-expanded-mounted-window', {
            prependCount,
            prependCompensation: pendingPrependCompensationRef.current,
            previousMounted: mounted,
            nextMounted: mountedRef.current,
          });
        }
        if (recenterTargetIndexRef.current != null) {
          recenterTargetIndexRef.current += prependCount;
          logMutationSnapshot('prepend-shifted-recenter-target', {
            prependCount,
            nextRecenterTargetIndex: recenterTargetIndexRef.current,
          });
        }
      } else if (mutation === 'append') {
        mutationSnapshotRef.current = {
          mutation,
          anchor: captureVisibleAnchor(),
          rowCountDelta: rowKeys.length - adjustPrevKeysRef.current.length,
        };
        logMutationSnapshot('append-detected', {
          previousCount: adjustPrevKeysRef.current.length,
          nextCount: rowKeys.length,
          logicalAtBottom: isAtBottomRef.current,
        });
        // When at bottom, eagerly expand mounted range to include appended rows
        // so they render immediately (with estimated heights). This avoids the
        // case where ensureBottomMeasured bails due to a pending staging batch,
        // leaving the new rows unmounted and invisible until the batch completes.
        const mounted = mountedRef.current;
        if (mounted && (isAtBottomRef.current || pendingScrollToBottomRef.current)) {
          const cappedEnd = Math.min(rowKeys.length - 1, mounted.end + WINDOW_CAP);
          if (cappedEnd > mounted.end) {
            mountedRef.current = { start: mounted.start, end: cappedEnd };
            logMutationSnapshot('append-expanded-mounted-window', {
              appendCount: rowKeys.length - adjustPrevKeysRef.current.length,
              previousMounted: mounted,
              nextMounted: mountedRef.current,
            });
          }
        }
      } else if (mutation === 'delete') {
        const anchor = captureVisibleAnchor();
        mutationSnapshotRef.current = {
          mutation,
          anchor,
          rowCountDelta: rowKeys.length - adjustPrevKeysRef.current.length,
        };
        logMutationSnapshot('delete-detected', {
          previousCount: adjustPrevKeysRef.current.length,
          nextCount: rowKeys.length,
        });
        if (anchor) {
          pendingDeleteRestoreRef.current = anchor;
        }
        // Adjust mounted window for the reduced row count
        const mounted = mountedRef.current;
        if (mounted) {
          const newEnd = Math.min(mounted.end, rowKeys.length - 1);
          if (newEnd < mounted.start) {
            // All mounted rows were deleted — recenter around anchor
            const anchorIndex = anchor ? keyToIndex.get(anchor.key) : null;
            if (anchorIndex != null) {
              const halfWindow = Math.floor(WINDOW_CAP / 2);
              mountedRef.current = normalizeRange(
                anchorIndex - halfWindow,
                anchorIndex + halfWindow,
                rowKeys.length - 1,
              );
            }
          } else if (newEnd !== mounted.end) {
            mountedRef.current = { start: mounted.start, end: newEnd };
          }
        }
      }
    }

    adjustPrevKeysRef.current = rowKeys;
  }

  const mounted = mountedRef.current;

  const mountedRows: ReactNode[] = [];
  if (mounted) {
    for (let index = mounted.start; index <= mounted.end; index += 1) {
      const row = rows[index];
      if (!row) continue;

      mountedRows.push(
        <MeasuredRow key={row.key} rowKey={row.key} onMeasure={handleMountedMeasure} registerRow={registerRow}>
          <div
            className={[
              styles.rowContent,
              row.key === highlightedRowKey ? styles.rowContentHighlighted : null,
              row.key === hiddenDateRowKey ? styles.dateRowContentHidden : null,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {renderRow(row)}
          </div>
        </MeasuredRow>,
      );
    }
  }

  const stagingRows: ReactNode[] = [];
  if (pendingBatch) {
    for (const key of pendingBatch.keys) {
      const index = keyToIndex.get(key);
      if (index == null) continue;
      const row = rows[index];
      if (!row) continue;

      stagingRows.push(
        <MeasuredRow key={`staging-${key}`} rowKey={key} hidden onMeasure={handleStagingMeasure}>
          {renderRow(row)}
        </MeasuredRow>,
      );
    }
  }

  const isLoading = !!loadOlder.loading || !!loadNewer?.loading;
  const topSpacer = mounted ? topSpacerHeight() : phase === 'RECENTERING' ? totalHeight() : 0;
  const bottomSpacer = mounted ? bottomSpacerHeight() : 0;
  const showLoadingScrim = phase === 'WAITING_VIEWPORT' || phase === 'BOOTSTRAP' || phase === 'RECENTERING';
  const showEmptyState = rowKeys.length === 0 && !isLoading && !showLoadingScrim;
  const showTopEdgeHint = loadOlder.hasMore || loadOlder.loading;
  const showBottomEdgeHint = !!loadNewer && (loadNewer.hasMore || loadNewer.loading);
  const topEdgeLabel = loadOlder.loading ? t`Loading…` : t`Earlier messages`;
  const bottomEdgeLabel = loadNewer?.loading ? t`Loading…` : t`Newer messages`;
  const contentPaddingTop = showTopEdgeHint ? EDGE_HINT_HEIGHT : 0;
  const contentPaddingBottom = bottomPadding + (showBottomEdgeHint ? EDGE_HINT_HEIGHT : 0);

  // Recalculate atBottom when the page becomes visible again, since the scroll
  // position may have been affected while the tab was in the background.
  usePageVisible(updateAtBottom);
  return (
    <div
      ref={containerRef}
      className={styles.container}
      onScroll={handleScroll}
      onWheel={markIntent}
      onTouchStart={markIntent}
      onTouchMove={markIntent}
      onPointerDown={markIntent}
    >
      {topOverlay}
      <div
        className={styles.flowContent}
        style={{ paddingTop: contentPaddingTop, paddingBottom: contentPaddingBottom }}
      >
        {header && <div ref={headerRef}>{header}</div>}
        {showTopEdgeHint && (
          <div className={`${styles.edgeHintRow} ${styles.edgeHintTop}`} style={{ height: EDGE_HINT_HEIGHT }}>
            {topEdgeLabel}
          </div>
        )}
        {topSpacer > 0 && <div className={styles.spacer} style={{ height: topSpacer }} />}
        {mountedRows}
        {bottomSpacer > 0 && <div className={styles.spacer} style={{ height: bottomSpacer }} />}
        {showBottomEdgeHint && (
          <div className={`${styles.edgeHintRow} ${styles.edgeHintBottom}`} style={{ height: EDGE_HINT_HEIGHT }}>
            {bottomEdgeLabel}
          </div>
        )}
        <div className={styles.stagingArea}>{stagingRows}</div>
      </div>
      {showEmptyState && (
        <div className={styles.overlayScrim}>
          <Trans>No messages yet</Trans>
        </div>
      )}
      {showLoadingScrim && (
        <div className={styles.overlayScrim}>
          <Trans>Loading…</Trans>
        </div>
      )}
    </div>
  );
}
