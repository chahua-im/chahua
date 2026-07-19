import {
  type ReactNode,
  type UIEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { IonSpinner } from '@ionic/react';
import { useNativeScrollActivity } from '@/hooks/useNativeScrollActivity';
import {
  AT_BOTTOM_THRESHOLD_PX,
  DEFAULT_OFFSET_RATIO,
  type ChatRow,
  type ChatVirtualScrollProps,
  type VirtualScrollAnchor,
} from './types';
import styles from './ChatVirtualScroll.module.scss';

const SCROLL_IDLE_MS = 200;
const USER_SCROLL_ACTIVITY_GRACE_MS = 1000;
// A date separator counts as "stuck" (pinned at the top via position:sticky)
// when its rendered top is within this tolerance of the container top. Mirrors
// Telegram's findStuckDate range.
const STUCK_TOLERANCE_PX = 2;
// Preload trigger distance. Telegram uses 750px (MESSAGE_LIST_SENSITIVE_AREA);
// we use 1500px (doubled) because we render the whole ~50-row segment, so an
// aggressive margin is cheap and the next page loads well before the edge.
const IO_ROOT_MARGIN = '1500px';
const EDGE_HINT_HEIGHT = 36;

interface Anchor {
  key: string;
  // firstMessageId of the picked group row; survives group-key merges on
  // prepend (a merged group's `grp:firstId` key changes, but its firstMessageId
  // stays findable via messageIdToRowKey). Used as the fallback lookup key.
  messageId: string | null;
  offsetTop: number;
}

// Memo'd row wrapper that registers its DOM node for measurement. Stable-keyed
// rows skip re-render when sibling rows shift (only props that changed rerender).
const RowWrapper = memo(function RowWrapper({
  row,
  registerRow,
  renderRow,
}: {
  row: ChatRow;
  registerRow: (key: string, node: HTMLDivElement | null) => void;
  renderRow: (row: ChatRow) => ReactNode;
}) {
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      registerRow(row.key, node);
    },
    [row.key, registerRow],
  );
  return (
    <div
      ref={setRef}
      className={row.type === 'date' ? `${styles.row} ${styles.dateRow}` : styles.row}
      data-row-key={row.key}
      data-row-type={row.type}
      data-first-message-id={row.type === 'group' ? row.firstMessageId : undefined}
    >
      {renderRow(row)}
    </div>
  );
});

// Partition flat rows into per-day segments. Each date separator opens a
// new segment; the segment's wrapper div becomes the `position: sticky`
// containing block for its date row — so the sticky date is pushed out exactly
// when that day scrolls off the top, and the next day's date takes over at
// top:0. Mirrors Telegram's `.message-date-group`. Leading rows before the
// first date form a flat segment with no wrapper.
function segmentRowsByDate(rows: ChatRow[]): ChatRow[][] {
  const segments: ChatRow[][] = [];
  for (const row of rows) {
    if (row.type === 'date' || segments.length === 0) {
      segments.push([row]);
    } else {
      segments[segments.length - 1].push(row);
    }
  }
  return segments;
}

export function ChatVirtualScroll({
  rows,
  renderRow,
  initialAnchor,
  scrollApiRef,
  loadOlder,
  loadNewer,
  header,
  bottomPadding = 0,
  isInitialLoading = false,
  onAtBottomChange,
  onLastFullyVisibleMessageChange,
  onFirstVisibleMessageChange,
  onScrollActivityChange,
}: ChatVirtualScrollProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Captured anchor: the first-or-second visible group row's viewport-relative
  // top, refreshed on scroll (rAF) and after each commit. Used by the prepend
  // restore to compute the exact delta — no estimated heights.
  const anchorRef = useRef<Anchor | null>(null);
  const prevTokenRef = useRef(initialAnchor.token);
  const prevRowsRef = useRef<ChatRow[]>(rows);
  // First-mount flag: forces the token-changed branch on the initial layout
  // effect so the initial anchor (bottom / top / message) is applied before
  // first paint. Without this, prevTokenRef.current === initialAnchor.token on
  // mount and the effect skips all scroll positioning — the viewport stays at
  // scrollTop=0 until a later anchor update (e.g. fetchLatestWindow resolves
  // and bumps the token) triggers the token-changed branch, producing the
  // visible "middle -> snap to bottom" flicker on cached chats.
  const isFirstLayoutRef = useRef(true);
  // Pending initial anchor: when the very first layout effect runs but
  // container.clientHeight === 0 (the Ionic IonContent web component has not
  // finished its layout yet — the inner scroll container has height:100% but
  // the parent is still 0px tall at commit time), we cannot compute a correct
  // scrollTop (scrollHeight is meaningless, scrollToBottom would set scrollTop=0
  // which becomes the visible "stuck at top" position once the container
  // gains height on the next frame). We stash the anchor here and apply it the
  // moment the container reports a non-zero clientHeight — either in a later
  // layout effect (next render) or via the container ResizeObserver. This
  // guarantees the FIRST visible frame is already at the correct position,
  // with no "middle -> snap to bottom" flicker. Mirrors telegram-tt's
  // `wasContainerReady` guard.
  const pendingInitialAnchorRef = useRef<VirtualScrollAnchor | null>(null);
  // rAF handle for the "poll until container is ready" loop. Cancelled on
  // unmount and when the pending anchor is applied.
  const pendingReadyRafRef = useRef<number | null>(null);
  const isScrollTopJustUpdatedRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  // True during a programmatic jump (scrollToMessageId / token change). The
  // ResizeObserver skips compensation while this is set — an intentional
  // viewport move should not be "corrected" back, and instant scroll avoids
  // the smooth-animation-interruption problem. Mirrors Telegram's
  // isReplacingHistoryRef.
  const isReplacingHistoryRef = useRef(false);

  // ── Row-height-change compensation (image/video load, link unfurl) ──
  // A shared ResizeObserver watches every rendered row. When a row ABOVE the
  // viewport top grows/shrinks (e.g. an image finishes loading), the visible
  // content would otherwise shift; we compensate scrollTop by the exact delta.
  // Deltas are accumulated and applied once per frame (rAF) to coalesce bursts
  // of simultaneously-loading images. Mirrors Telegram's "stable height" goal.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const pendingHeightDeltaRef = useRef(0);
  const heightRafRef = useRef<number | null>(null);
  // PRE-resize "at bottom" flag, refreshed in updateViewportState and after a
  // programmatic scroll-to-bottom. The ResizeObserver reads this to decide
  // between re-pinning to the bottom (telegram-tt `isAtBottom && isResized`)
  // and compensating the top anchor.
  const atBottomRef = useRef(false);
  const pendingBottomPinRef = useRef(false);

  // Render-visible mirror of atBottomRef. The top edge hint is an in-flow
  // 36px box at the top of the list; when pinned to the bottom it is off-screen
  // but its box still shifts the newest message out of view (the confirmed
  // "half-visible last bubble" cause). Suppressing the hint while at the bottom
  // removes that shift - the hint is invisible there anyway. A ref tracks the
  // previous value so we only setState on actual changes (no render churn).
  const [atBottomState, setAtBottomState] = useState(false);
  const prevAtBottomStateRef = useRef(false);

  // Latest-callbacks ref so the layout effect doesn't re-run on identity churn
  // (which would pollute isScrollTopJustUpdatedRef). Updated in a layout effect
  // below before the main layout effect reads it.
  const callbacksRef = useRef({
    onAtBottomChange,
    onLastFullyVisibleMessageChange,
    onFirstVisibleMessageChange,
    onScrollActivityChange,
  });

  const messageIdToRowKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of rows) {
      if (row.type === 'group') {
        for (const msg of row.messages) m.set(msg.id, row.key);
      }
    }
    return m;
  }, [rows]);

  const registerRow = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) {
      rowRefs.current.set(key, node);
      rowHeightsRef.current.set(key, node.getBoundingClientRect().height);
      resizeObserverRef.current?.observe(node);
    } else {
      const prev = rowRefs.current.get(key);
      if (prev) resizeObserverRef.current?.unobserve(prev);
      rowRefs.current.delete(key);
      rowHeightsRef.current.delete(key);
    }
  }, []);

  const {
    active: scrolling,
    markIntent,
    notifyScroll,
  } = useNativeScrollActivity(USER_SCROLL_ACTIVITY_GRACE_MS, SCROLL_IDLE_MS);

  useLayoutEffect(() => {
    callbacksRef.current = {
      onAtBottomChange,
      onLastFullyVisibleMessageChange,
      onFirstVisibleMessageChange,
      onScrollActivityChange,
    };
  });

  useEffect(() => {
    onScrollActivityChange?.(scrolling);
  }, [scrolling, onScrollActivityChange]);

  // ── Anchor capture / viewport state (rAF-batched) ──

  const captureAnchor = useCallback((container: HTMLDivElement): Anchor | null => {
    const containerRect = container.getBoundingClientRect();
    const visibleGroups: Anchor[] = [];
    for (const [key, node] of rowRefs.current) {
      if (node.dataset.rowType !== 'group') continue;
      const rect = node.getBoundingClientRect();
      const isVisible = rect.bottom > containerRect.top && rect.top < containerRect.bottom;
      if (isVisible) {
        visibleGroups.push({
          key,
          messageId: node.dataset.firstMessageId ?? null,
          offsetTop: rect.top - containerRect.top,
        });
        if (visibleGroups.length >= 3) break; // 2nd + 1 extra is enough
      }
    }
    // Prefer the 2nd visible group (the 1st may be trimmed on slice limits).
    const picked = visibleGroups[1] ?? visibleGroups[0] ?? null;
    if (picked) anchorRef.current = picked;
    return picked;
  }, []);

  const updateViewportState = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const cbs = callbacksRef.current;

    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < AT_BOTTOM_THRESHOLD_PX;
    atBottomRef.current = atBottom;
    if (atBottom !== prevAtBottomStateRef.current) {
      prevAtBottomStateRef.current = atBottom;
      setAtBottomState(atBottom);
    }

    let firstVisibleMessageId: string | null = null;
    let lastFullyVisibleMessageId: string | null = null;
    // The "stuck" date = the topmost date separator currently pinned at the
    // container top by position:sticky. With flat sibling sticky dates, every
    // already-scrolled-past date renders at top:0 (stacked); the visible one is
    // the LAST such date in DOM order. We mark only it for the idle fade.
    let stuckDateKey: string | null = null;

    for (const row of rows) {
      const node = rowRefs.current.get(row.key);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const fullyVisible = rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
      if (row.type === 'group') {
        if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
          if (firstVisibleMessageId == null) firstVisibleMessageId = row.firstMessageId;
        }
        if (rect.top < containerRect.bottom) {
          lastFullyVisibleMessageId = row.lastMessageId;
        }
        void fullyVisible;
      } else if (row.type === 'date') {
        const top = rect.top - containerRect.top;
        if (-rect.height <= top && top <= STUCK_TOLERANCE_PX) {
          stuckDateKey = row.key; // last match wins = topmost visible stuck date
        }
      }
    }

    // Apply the stuck marker directly to the DOM (mirrors Telegram's
    // findStuckDate + classList toggle). Avoids React re-renders.
    for (const [key, node] of rowRefs.current) {
      if (node.dataset.rowType !== 'date') continue;
      if (key === stuckDateKey) node.dataset.stuck = 'true';
      else delete node.dataset.stuck;
    }

    captureAnchor(container);

    cbs.onAtBottomChange?.(atBottom);
    cbs.onFirstVisibleMessageChange?.(firstVisibleMessageId);
    cbs.onLastFullyVisibleMessageChange?.(lastFullyVisibleMessageId);
  }, [captureAnchor, rows]);

  // ── Scroll handler ──

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      notifyScroll(e.nativeEvent.isTrusted);
      if (isScrollTopJustUpdatedRef.current) {
        isScrollTopJustUpdatedRef.current = false;
        return;
      }
      if (scrollRafRef.current == null) {
        scrollRafRef.current = requestAnimationFrame(() => {
          scrollRafRef.current = null;
          updateViewportState();
        });
      }
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        updateViewportState();
      }, SCROLL_IDLE_MS);
    },
    [notifyScroll, updateViewportState],
  );

  // ── Programmatic scroll helper ──

  const setScrollTop = useCallback((container: HTMLDivElement, top: number, behavior?: ScrollBehavior) => {
    isScrollTopJustUpdatedRef.current = true;
    if (behavior === 'smooth') {
      container.scrollTo({ top, behavior: 'smooth' });
    } else {
      container.scrollTop = top;
    }
  }, []);

  const applyMessageIntent = useCallback(
    (
      container: HTMLDivElement,
      messageId: string,
      align?: 'top' | 'bottom' | 'custom',
      offsetRatio?: number,
    ): boolean => {
      const rowKey = messageIdToRowKey.get(messageId);
      const node = rowKey ? rowRefs.current.get(rowKey) : null;
      if (!node) return false;
      const ratio = offsetRatio ?? DEFAULT_OFFSET_RATIO;
      let target: number;
      if (align === 'top') target = node.offsetTop;
      else if (align === 'bottom') target = node.offsetTop + node.offsetHeight - container.clientHeight;
      else target = node.offsetTop - ratio * (container.clientHeight - node.offsetHeight);
      setScrollTop(container, target);
      return true;
    },
    [messageIdToRowKey, setScrollTop],
  );

  // Apply a previously-deferred anchor (saved when container.clientHeight was
  // 0 at first mount). Mirrors the tokenChanged branch but reads from the
  // passed anchor so it is independent of the current `initialAnchor` prop
  // identity. Runs synchronously inside a layout effect or a ResizeObserver
  // callback (which fires before paint for the size transition), so the first
  // visible frame after the container gains height is already at the correct
  // position.
  const applyPendingAnchor = useCallback(
    (container: HTMLDivElement, anchor: VirtualScrollAnchor) => {
      if (anchor.type === 'bottom') {
        setScrollTop(container, container.scrollHeight);
        atBottomRef.current = true;
      } else if (anchor.type === 'top') {
        setScrollTop(container, 0);
      } else if (anchor.type === 'message') {
        isReplacingHistoryRef.current = true;
        applyMessageIntent(container, anchor.messageId, anchor.align, anchor.offsetRatio);
      }
      requestAnimationFrame(() => {
        if (containerRef.current) captureAnchor(containerRef.current);
        isReplacingHistoryRef.current = false;
      });
    },
    [applyMessageIntent, captureAnchor, setScrollTop],
  );

  // ResizeObserver: compensate scrollTop when a row above the viewport changes
  // height (image/video load, link unfurl). Without this, an image finishing
  // load above the viewport pushes visible content down → jump.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const flushHeightDelta = () => {
      heightRafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      // Bottom-pin takes precedence: when the viewport was at the bottom and a
      // row resized (image load, link unfurl), re-glue to the newest message
      // instead of compensating the top anchor. Re-check atBottomRef here in
      // case the user scrolled away between the RO callback and this frame -
      // if so, fall through to the delta compensation. Mirrors telegram-tt's
      // `isAtBottom && isResized` branch.
      if (pendingBottomPinRef.current && atBottomRef.current) {
        pendingBottomPinRef.current = false;
        pendingHeightDeltaRef.current = 0;
        setScrollTop(el, el.scrollHeight);
        captureAnchor(el);
        return;
      }
      pendingBottomPinRef.current = false;
      const delta = pendingHeightDeltaRef.current;
      pendingHeightDeltaRef.current = 0;
      if (delta === 0) return;
      setScrollTop(el, el.scrollTop + delta);
      // Keep the anchor consistent after the programmatic correction.
      captureAnchor(el);
    };

    // Update each changed row's cached height and return the total height
    // increase of rows sitting ENTIRELY ABOVE the viewport top (those shift the
    // visible area down and need scrollTop compensation). Rows intersecting or
    // below the viewport top reflow naturally and contribute 0.
    const trackHeights = (entries: ResizeObserverEntry[], containerTop: number): number => {
      let delta = 0;
      for (const entry of entries) {
        const node = entry.target as HTMLDivElement;
        const key = node.dataset.rowKey;
        if (!key) continue;
        const rect = node.getBoundingClientRect();
        const prevHeight = rowHeightsRef.current.get(key) ?? rect.height;
        rowHeightsRef.current.set(key, rect.height);
        const diff = rect.height - prevHeight;
        if (diff !== 0 && rect.bottom <= containerTop) {
          delta += diff;
        }
      }
      return delta;
    };

    const observer = new ResizeObserver((entries) => {
      const el = containerRef.current;
      if (!el) return;
      const containerTop = el.getBoundingClientRect().top;
      const delta = trackHeights(entries, containerTop);
      // Skip compensation during a programmatic jump - the viewport move is
      // intentional and instant scroll has already positioned the target.
      // (Heights are still tracked above so the anchor stays accurate.)
      if (isReplacingHistoryRef.current) return;
      pendingHeightDeltaRef.current += delta;
      // Telegram-aligned: when pinned to the bottom, a height change re-pins
      // to the bottom (queued, coalesced in one rAF) instead of compensating
      // the top anchor - otherwise image load drifts the viewport off the
      // newest message. We read the PRE-resize atBottom (refreshed on scroll /
      // commit) because RO fires after the resize, when the post-resize math
      // would already look "not at bottom".
      if (atBottomRef.current) {
        pendingBottomPinRef.current = true;
      }
      if (pendingBottomPinRef.current || pendingHeightDeltaRef.current !== 0) {
        if (heightRafRef.current == null) {
          heightRafRef.current = requestAnimationFrame(flushHeightDelta);
        }
      }
    });
    resizeObserverRef.current = observer;
    // Observe any rows already registered before this effect ran.
    for (const node of rowRefs.current.values()) observer.observe(node);

    // Container ResizeObserver serves two purposes:
    // 1) When the viewport was pinned to the bottom and the CONTAINER itself
    //    resizes (composer/input bar mounting after the list, Ionic page
    //    transition settling, safe-area inset, keyboard), clientHeight changes
    //    and the last message would be left half-visible. Row RO does not fire
    //    (rows did not resize), so without this the viewport stays cut off
    //    until some unrelated row RO (font/emoji load) happens to correct it -
    //    the "half visible, then jumps a second later" symptom. Re-pin to the
    //    bottom via the same coalesced path. Mirrors telegram-tt's layout-effect
    //    `isAtBottom && isResized -> scrollHeight - offsetHeight` branch.
    // 2) Apply a deferred initial anchor when the container transitions from
    //    clientHeight=0 (IonContent not yet laid out) to a real size. The RO
    //    callback fires before the browser paints the new size, so the anchor
    //    is applied synchronously and the FIRST visible frame is at the correct
    //    position — no "middle -> snap to bottom" flicker.
    const containerObserver = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      // Case 2: deferred initial anchor pending application (fallback if the
      // rAF poll did not catch it — e.g. if the layout effect was skipped).
      const pending = pendingInitialAnchorRef.current;
      if (pending && el.clientHeight > 0) {
        pendingInitialAnchorRef.current = null;
        applyPendingAnchor(el, pending);
        return;
      }
      // Case 1: container resize while pinned to bottom — re-pin.
      if (isReplacingHistoryRef.current) return;
      if (!atBottomRef.current) return;
      pendingBottomPinRef.current = true;
      if (heightRafRef.current == null) {
        heightRafRef.current = requestAnimationFrame(flushHeightDelta);
      }
    });
    containerObserver.observe(container);

    return () => {
      observer.disconnect();
      containerObserver.disconnect();
      resizeObserverRef.current = null;
      if (heightRafRef.current != null) {
        cancelAnimationFrame(heightRafRef.current);
        heightRafRef.current = null;
      }
      pendingHeightDeltaRef.current = 0;
      pendingBottomPinRef.current = false;
    };
  }, [captureAnchor, setScrollTop, applyPendingAnchor]);

  // ── Core layout effect: anchor restore on mutation, intent on token change ──

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Container-not-ready guard: on first mount inside Ionic's IonContent (a
    // web component), the inner scroll container has height:100% but the parent
    // IonContent has not yet laid out, so container.clientHeight === 0 at the
    // moment the layout effect runs. scrollHeight is also unreliable in this
    // state. If we call setScrollTop(scrollHeight) now it clamps to 0, and once
    // IonContent gains height on the next frame the viewport is left stuck at
    // scrollTop=0 — i.e. the visible "list starts ~80-100 messages above the
    // bottom, then snaps to bottom" flicker. Stash the anchor and apply it when
    // the container reports a real size.
    //
    // The container ResizeObserver fires only AFTER paint (RO callbacks are
    // delivered in a separate task post-paint), so it is too late to prevent
    // the first visible frame from showing scrollTop=0. Instead we poll with
    // requestAnimationFrame, which runs BEFORE the next paint. As soon as the
    // container reports a non-zero clientHeight, we synchronously apply the
    // pending anchor — before the browser paints, so the first visible frame
    // is already at the correct position. This mirrors telegram-tt's pattern
    // of deferring scroll positioning until `wasContainerReady` becomes true.
    if (container.clientHeight === 0) {
      pendingInitialAnchorRef.current = initialAnchor;
      // Schedule a rAF loop to apply the pending anchor as soon as the
      // container gains a real size, BEFORE the browser paints the new size.
      // Without this, the first visible frame after IonContent lays out would
      // show scrollTop=0 (stuck at the top of the cached window, ~80-100
      // messages above the bottom), and only afterwards would the RO callback
      // re-pin to the bottom — the visible "middle -> snap to bottom" flicker.
      const pollForReady = () => {
        const el = containerRef.current;
        if (!el || pendingInitialAnchorRef.current == null) return;
        if (el.clientHeight > 0) {
          const pending = pendingInitialAnchorRef.current;
          pendingInitialAnchorRef.current = null;
          applyPendingAnchor(el, pending);
          return;
        }
        // Container still not laid out — try again before the next paint.
        pendingReadyRafRef.current = requestAnimationFrame(pollForReady);
      };
      pendingReadyRafRef.current = requestAnimationFrame(pollForReady);
      return;
    }

    // If we previously deferred an anchor because the container was not ready,
    // apply it now (container has a real size). This runs before any other
    // scroll logic so the first visible frame lands at the correct position.
    const pendingAnchor = pendingInitialAnchorRef.current;
    if (pendingAnchor) {
      pendingInitialAnchorRef.current = null;
      applyPendingAnchor(container, pendingAnchor);
      // After applying the deferred anchor, capture state and bail out — the
      // token/rows diff logic below is for subsequent updates, not the initial
      // positioning which we just handled.
      prevTokenRef.current = initialAnchor.token;
      prevRowsRef.current = rows;
      isFirstLayoutRef.current = false;
      captureAnchor(container);
      updateViewportState();
      return;
    }

    // On first mount, force the token-changed branch so the initial anchor
    // (bottom / top / message) is applied synchronously before first paint.
    // Without this, prevTokenRef.current === initialAnchor.token on mount and
    // the effect skips all scroll positioning — the viewport stays at
    // scrollTop=0 until a later anchor update (e.g. fetchLatestWindow resolves
    // and bumps the token) triggers the token-changed branch, producing the
    // visible "middle -> snap to bottom" flicker on cached chats.
    const isFirstLayout = isFirstLayoutRef.current;
    isFirstLayoutRef.current = false;
    const tokenChanged = isFirstLayout || prevTokenRef.current !== initialAnchor.token;
    const rowsChanged = prevRowsRef.current !== rows;

    if (tokenChanged) {
      prevTokenRef.current = initialAnchor.token;
      if (initialAnchor.type === 'bottom') {
        setScrollTop(container, container.scrollHeight);
        atBottomRef.current = true;
      } else if (initialAnchor.type === 'top') {
        setScrollTop(container, 0);
      } else if (initialAnchor.type === 'message') {
        // Guard RO during the jump so image-load compensation doesn't fight
        // the intentional viewport move. Instant scroll (no behavior param)
        // avoids smooth-animation interruption — mirrors Telegram's
        // FocusDirection.Static / forceDuration=0 for history replaces.
        isReplacingHistoryRef.current = true;
        applyMessageIntent(container, initialAnchor.messageId, initialAnchor.align, initialAnchor.offsetRatio);
      }
      requestAnimationFrame(() => {
        if (containerRef.current) captureAnchor(containerRef.current);
        isReplacingHistoryRef.current = false;
      });
    } else if (rowsChanged) {
      // Bottom-pin: if the viewport was anchored to the bottom before the rows
      // changed (loadOlder prepend, new-message append, delete), re-pin to the
      // newest message instead of restoring the top anchor. Otherwise the last
      // bubble lands half-visible: the prepend delta sits below the restored
      // anchor and no RO fires to correct it (the shift is from a non-row
      // element or from content added above the viewport).
      if (atBottomRef.current) {
        setScrollTop(container, container.scrollHeight);
      } else {
        // Prepend / append / delete - restore the captured anchor exactly.
        // anchorRef holds the pre-commit viewport-relative top (refreshed on the
        // last scroll/commit), so delta = newTop - oldTop is the real shift.
        const anchor = anchorRef.current;
        if (anchor) {
          // Fast path: anchor key unchanged (common case).
          let node: HTMLDivElement | undefined = rowRefs.current.get(anchor.key);
          // Fallback: group merged on prepend -> `grp:firstId` key changed. Look
          // up the row containing the anchor's firstMessageId instead (the row's
          // firstMessageId survives merges even when the row key does not).
          if (!node && anchor.messageId) {
            const fallbackRowKey = messageIdToRowKey.get(anchor.messageId);
            node = fallbackRowKey ? rowRefs.current.get(fallbackRowKey) : undefined;
          }
          if (node) {
            const containerRect = container.getBoundingClientRect();
            const newTop = node.getBoundingClientRect().top - containerRect.top;
            const delta = newTop - anchor.offsetTop;
            if (delta !== 0) {
              setScrollTop(container, container.scrollTop + delta);
            }
          }
        }
      }
    }
    if (rowsChanged) {
      prevRowsRef.current = rows;
    }

    captureAnchor(container);
    updateViewportState();
  }, [
    rows,
    initialAnchor,
    applyMessageIntent,
    applyPendingAnchor,
    captureAnchor,
    setScrollTop,
    updateViewportState,
    messageIdToRowKey,
  ]);

  // ── scrollApi ──

  useEffect(() => {
    if (!scrollApiRef) return;
    scrollApiRef.current = {
      scrollToBottom: (options) => {
        const container = containerRef.current;
        if (!container) return;
        setScrollTop(container, container.scrollHeight, options?.behavior);
        atBottomRef.current = true;
        requestAnimationFrame(() => {
          if (containerRef.current) captureAnchor(containerRef.current);
        });
      },
      scrollToItem: (key, behavior) => {
        const container = containerRef.current;
        if (!container) return;
        const node = rowRefs.current.get(key);
        if (node) {
          setScrollTop(container, node.offsetTop, behavior);
          requestAnimationFrame(() => {
            if (containerRef.current) captureAnchor(containerRef.current);
          });
        }
      },
      scrollToMessageId: (messageId, _behavior, align, offsetRatio) => {
        const container = containerRef.current;
        if (!container) return false;
        // Instant scroll (ignore behavior='smooth') + RO guard — prevents
        // the smooth-animation-interruption bug and keeps the target stable.
        isReplacingHistoryRef.current = true;
        const scrolled = applyMessageIntent(container, messageId, align, offsetRatio);
        requestAnimationFrame(() => {
          if (containerRef.current) captureAnchor(containerRef.current);
          isReplacingHistoryRef.current = false;
        });
        return scrolled;
      },
    };
    return () => {
      scrollApiRef.current = null;
    };
  }, [scrollApiRef, applyMessageIntent, captureAnchor, setScrollTop]);

  // ── IntersectionObserver sentinels ──

  useEffect(() => {
    const container = containerRef.current;
    const sentinel = topSentinelRef.current;
    if (!container || !sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && loadOlder.hasMore && !loadOlder.loading) {
            loadOlder.onLoad();
          }
        }
      },
      { root: container, rootMargin: IO_ROOT_MARGIN },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
    // Granular deps are intentional: the parent rebuilds `loadOlder` every
    // render, so depending on the whole object would recreate this observer
    // each frame. The three fields are stable (primitives + memoized onLoad).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOlder.hasMore, loadOlder.loading, loadOlder.onLoad]);

  useEffect(() => {
    const container = containerRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!container || !sentinel || !loadNewer) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && loadNewer.hasMore && !loadNewer.loading) {
            loadNewer.onLoad();
          }
        }
      },
      { root: container, rootMargin: IO_ROOT_MARGIN },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [loadNewer]);

  // ── Cleanup ──

  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      // Cancel any pending "wait for container ready" rAF poll so a stale
      // instance cannot apply its anchor after the component unmounted (e.g.
      // on quick A -> B -> C switches).
      if (pendingReadyRafRef.current != null) {
        cancelAnimationFrame(pendingReadyRafRef.current);
        pendingReadyRafRef.current = null;
      }
    };
  }, []);

  // Loading scrim: shown when a jump target is not yet in the rendered rows.
  const showLoadingScrim = useMemo(() => {
    if (initialAnchor.type === 'message' && !messageIdToRowKey.has(initialAnchor.messageId)) {
      return true;
    }
    // Show the scrim while the initial window is fetching for a chat with no
    // cached rows (e.g. first open). Previously this was covered by the
    // 'message' anchor path; with the no-unread -> 'bottom' anchor fix, the
    // 'bottom' anchor needs its own loading signal.
    if (isInitialLoading && rows.length === 0) {
      return true;
    }
    return false;
  }, [initialAnchor, messageIdToRowKey, isInitialLoading, rows]);

  // Edge hints: show a loading spinner while fetching, or a subtle
  // "more messages" affordance when more history exists but isn't loading yet.
  // When an edge is reached (no more), nothing is shown — the list simply ends.
  // Partition rows into per-day segments once per `rows` change; the render
  // below maps over this memoized array so we don't re-partition every render.
  const dateSegments = useMemo(() => segmentRowsByDate(rows), [rows]);
  const showTopHint = loadOlder.loading && !atBottomState;
  const showBottomHint = !!loadNewer?.loading;

  return (
    <div
      ref={containerRef}
      className={styles.container}
      data-scrolling={scrolling}
      onScroll={handleScroll}
      onWheel={markIntent}
      onTouchStart={markIntent}
      onTouchMove={markIntent}
      onPointerDown={markIntent}
    >
      <div className={styles.flowContent}>
        {header}
        <div ref={topSentinelRef} className={styles.sentinel} aria-hidden />
        {showTopHint ? (
          <div className={styles.edgeHint} style={{ minHeight: EDGE_HINT_HEIGHT }}>
            <IonSpinner name="dots" className={styles.edgeHintSpinner} />
          </div>
        ) : null}
        {dateSegments.map((segment) =>
          segment[0].type === 'date' ? (
            <div key={segment[0].key}>
              {segment.map((row) => (
                <RowWrapper key={row.key} row={row} registerRow={registerRow} renderRow={renderRow} />
              ))}
            </div>
          ) : (
            segment.map((row) => <RowWrapper key={row.key} row={row} registerRow={registerRow} renderRow={renderRow} />)
          ),
        )}
        {showBottomHint ? (
          <div className={styles.edgeHint} style={{ minHeight: EDGE_HINT_HEIGHT }}>
            <IonSpinner name="dots" className={styles.edgeHintSpinner} />
          </div>
        ) : null}
        <div ref={bottomSentinelRef} className={styles.sentinel} aria-hidden />
        {bottomPadding > 0 ? <div className={styles.bottomPadding} style={{ height: bottomPadding }} /> : null}
      </div>
      {showLoadingScrim ? (
        <div className={styles.loadingScrim}>
          <IonSpinner name="crescent" />
        </div>
      ) : null}
    </div>
  );
}
