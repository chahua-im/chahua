import { type ReactNode, type UIEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { IonSpinner } from '@ionic/react';
import { useNativeScrollActivity } from '@/hooks/useNativeScrollActivity';
import { AT_BOTTOM_THRESHOLD_PX, DEFAULT_OFFSET_RATIO, type ChatRow, type ChatVirtualScrollProps } from './types';
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

  // ResizeObserver: compensate scrollTop when a row above the viewport changes
  // height (image/video load, link unfurl). Without this, an image finishing
  // load above the viewport pushes visible content down → jump.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const flushHeightDelta = () => {
      heightRafRef.current = null;
      const delta = pendingHeightDeltaRef.current;
      pendingHeightDeltaRef.current = 0;
      if (delta === 0) return;
      const el = containerRef.current;
      if (!el) return;
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
      // Skip compensation during a programmatic jump — the viewport move is
      // intentional and instant scroll has already positioned the target.
      // (Heights are still tracked above so the anchor stays accurate.)
      if (isReplacingHistoryRef.current || delta === 0) return;
      pendingHeightDeltaRef.current += delta;
      if (heightRafRef.current == null) {
        heightRafRef.current = requestAnimationFrame(flushHeightDelta);
      }
    });
    resizeObserverRef.current = observer;
    // Observe any rows already registered before this effect ran.
    for (const node of rowRefs.current.values()) observer.observe(node);

    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
      if (heightRafRef.current != null) {
        cancelAnimationFrame(heightRafRef.current);
        heightRafRef.current = null;
      }
      pendingHeightDeltaRef.current = 0;
    };
  }, [captureAnchor, setScrollTop]);

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

  // ── Core layout effect: anchor restore on mutation, intent on token change ──

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const tokenChanged = prevTokenRef.current !== initialAnchor.token;
    const rowsChanged = prevRowsRef.current !== rows;

    if (tokenChanged) {
      prevTokenRef.current = initialAnchor.token;
      if (initialAnchor.type === 'bottom') {
        setScrollTop(container, container.scrollHeight);
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
      // Prepend / append / delete — restore the captured anchor exactly.
      // anchorRef holds the pre-commit viewport-relative top (refreshed on the
      // last scroll/commit), so delta = newTop - oldTop is the real shift.
      const anchor = anchorRef.current;
      if (anchor) {
        // Fast path: anchor key unchanged (common case).
        let node: HTMLDivElement | undefined = rowRefs.current.get(anchor.key);
        // Fallback: group merged on prepend → `grp:firstId` key changed. Look
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
    if (rowsChanged) {
      prevRowsRef.current = rows;
    }

    captureAnchor(container);
    updateViewportState();
  }, [rows, initialAnchor, applyMessageIntent, captureAnchor, setScrollTop, updateViewportState, messageIdToRowKey]);

  // ── scrollApi ──

  useEffect(() => {
    if (!scrollApiRef) return;
    scrollApiRef.current = {
      scrollToBottom: (options) => {
        const container = containerRef.current;
        if (!container) return;
        setScrollTop(container, container.scrollHeight, options?.behavior);
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
    };
  }, []);

  // Loading scrim: shown when a jump target is not yet in the rendered rows.
  const showLoadingScrim = useMemo(() => {
    if (initialAnchor.type === 'message' && !messageIdToRowKey.has(initialAnchor.messageId)) {
      return true;
    }
    return false;
  }, [initialAnchor, messageIdToRowKey]);

  // Edge hints: show a loading spinner while fetching, or a subtle
  // "more messages" affordance when more history exists but isn't loading yet.
  // When an edge is reached (no more), nothing is shown — the list simply ends.
  // Partition rows into per-day segments once per `rows` change; the render
  // below maps over this memoized array so we don't re-partition every render.
  const dateSegments = useMemo(() => segmentRowsByDate(rows), [rows]);
  const showTopHint = loadOlder.loading;
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
