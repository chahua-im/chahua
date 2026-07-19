import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { t } from '@lingui/core/macro';
import { useDispatch, useSelector } from 'react-redux';
import { selectShowAllAvatars } from '@/store/settingsSlice';
import { setMessageHighlight, clearMessageHighlight } from '@/store/highlightSlice';
import { getMessages } from '@/api/messages';
import { getThreadReadState } from '@/api/threads';
import type { VirtualScrollAnchor, VirtualScrollHandle } from '@/components/chat/virtualScroll/types';
import { DEFAULT_OFFSET_RATIO } from '@/components/chat/virtualScroll/types';
import { useChatRows } from '@/components/chat/virtualScroll/useChatRows';
import { useFloatingDateVisibility } from '@/hooks/useFloatingDate';
import store from '@/store';

import {
  clearPendingLiveMessages,
  insertAfterAnchor,
  insertAround,
  insertBeforeAnchor,
  refreshLatest,
  resetChat,
  setTimelineMode,
} from '@/store/messages/slice';
import {
  selectActiveTimelineMessages,
  selectCanLoadNewer,
  selectCanLoadOlder,
  selectChatGeneration,
  selectNewerAnchor,
  selectOlderAnchor,
  selectPendingLiveCount,
} from '@/store/messages/selectors';
import { collectTimelineSnapshot, logTimelineDiagnostic } from '@/store/messages/timelineDiagnostics';
import type { RootState } from '@/store';
import { areMessageListsEquivalent, isMessageAtOrAfter, parseComparableMessageId } from '../utils/conversationUtils';

/** How long the jump-target highlight stays visible before fading out. */
const HIGHLIGHT_DURATION_MS = 2000;

interface UseConversationTimelineArgs {
  chatId: string;
  storeChatId: string;
  threadId?: string;
  initialResumeMessageId: string | null;
  lastReadMessageId: string | null;
  scrollToBottomUnreadCount: number;
  threadLastReadMessageIdRef: RefObject<string | null>;
  formatDateSeparator: (iso: string) => string;
  showToast: (text: string, duration?: number, options?: { positionAnchor?: string }) => void;
}

export function useConversationTimeline({
  chatId,
  storeChatId,
  threadId,
  initialResumeMessageId,
  lastReadMessageId,
  scrollToBottomUnreadCount,
  threadLastReadMessageIdRef,
  formatDateSeparator,
  showToast,
}: UseConversationTimelineArgs) {
  const dispatch = useDispatch();
  const scrollApiRef = useRef<VirtualScrollHandle | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasInitialFetchResolved, setHasInitialFetchResolved] = useState(false);
  const loadingMoreRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [initialAnchor, setInitialAnchor] = useState<VirtualScrollAnchor>(() => {
    if (initialResumeMessageId) {
      return { type: 'message', messageId: initialResumeMessageId, token: 0, align: 'top' };
    }
    if (!threadId && lastReadMessageId && scrollToBottomUnreadCount) {
      return { type: 'message', messageId: lastReadMessageId, token: 0, align: 'top' };
    }
    return { type: threadId ? 'top' : 'bottom', token: 0 } as VirtualScrollAnchor;
  });

  // Update initial anchor when lastReadMessageId loads asynchronously.
  // Render-time state adjustment (not an effect) to avoid cascading renders.
  // The `initialAnchor.type === 'bottom'` guard makes it fire at most once
  // (bottom -> message), so there is no render loop.
  //
  // No unread -> stay at the bottom; only jump to last-read when there are
  // unread messages (mirrors telegram-tt, which only uses the unread divider
  // when unreadCount > 0). Without this, a fully-read chat re-anchors from
  // bottom to message-top on the async lastReadMessageId arrival, causing an
  // extra scroll adjustment and landing short of the bottom.
  //
  // The `lastReadMessageId &&` guard narrows it to `string` inline so the
  // 'message' anchor below type-checks (extracting to a named boolean would
  // lose that narrowing and re-introduce a string|null error).
  if (
    !initialResumeMessageId &&
    !threadId &&
    lastReadMessageId &&
    scrollToBottomUnreadCount &&
    initialAnchor.type === 'bottom'
  ) {
    setInitialAnchor((current) => {
      if (current.type !== 'bottom') return current;
      return {
        type: 'message',
        messageId: lastReadMessageId,
        token: current.token + 1,
        align: 'top' as const,
      };
    });
  }

  const [pendingResumeMessageId, setPendingResumeMessageId] = useState<string | null>(initialResumeMessageId);
  const [lastFullyVisibleMessageId, setLastFullyVisibleMessageId] = useState<string | null>(null);
  const [firstVisibleMessageId, setFirstVisibleMessageId] = useState<string | null>(null);
  const [scrollDirection, setScrollDirection] = useState(() => ({
    storeChatId,
    towardNewer: false,
  }));
  const previousFirstVisibleComparableIdRef = useRef<bigint | null>(null);
  const [messageListScrolling, setMessageListScrolling] = useState(false);
  const [floatingDateColliding, setFloatingDateColliding] = useState(false);
  const [atBottom, setAtBottom] = useState(() => {
    if (threadId) return false;
    if (initialResumeMessageId) return false;
    return true;
  });
  const initialLoadCompletedRef = useRef(false);
  const emptyTimelinePendingLiveLogKeyRef = useRef<string | null>(null);

  const messages = useSelector((state: RootState) => selectActiveTimelineMessages(state, storeChatId));
  const canLoadOlder = useSelector((state: RootState) => selectCanLoadOlder(state, storeChatId));
  const canLoadNewer = useSelector((state: RootState) => selectCanLoadNewer(state, storeChatId));
  const pendingLiveCount = useSelector((state: RootState) => selectPendingLiveCount(state, storeChatId));

  const messageLookup = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const latestMessageId = useMemo(() => (messages.length ? messages[messages.length - 1].id : null), [messages]);
  const showAllAvatars = useSelector(selectShowAllAvatars);

  // ── Unread divider position (memoized once per chat session) ──
  // Mirrors telegram-tt's memoUnreadDividerBeforeIdRef: the first unread
  // message id is captured once when the unread boundary is first seen in the
  // loaded window, then kept stable for the session. The divider therefore
  // marks "where new messages started" and doesn't jump as the user reads past
  // it; it only clears on chat reopen (when there are no unread messages, no
  // divider is captured).
  //
  // Implemented with the "adjusting state during render" pattern (React docs,
  // "You Might Not Need an Effect"): setState is called during render - not in
  // an effect - so it neither trips react-hooks/set-state-in-effect nor
  // react-hooks/refs. The `unreadDividerBeforeId === null` guard makes the
  // capture fire at most once per storeChatId (reset below), so there is no
  // render loop.
  const [unreadDividerBeforeId, setUnreadDividerBeforeId] = useState<string | null>(null);
  const [unreadDividerStoreChatId, setUnreadDividerStoreChatId] = useState(storeChatId);
  if (unreadDividerStoreChatId !== storeChatId) {
    // Chat switched: reset so the new chat captures its own boundary.
    setUnreadDividerStoreChatId(storeChatId);
    setUnreadDividerBeforeId(null);
  }

  if (
    unreadDividerBeforeId === null &&
    !threadId &&
    scrollToBottomUnreadCount &&
    lastReadMessageId &&
    messages.length > 0
  ) {
    const lastReadComparable = parseComparableMessageId(lastReadMessageId);
    if (lastReadComparable != null) {
      const firstUnread = messages.find((message) => {
        const comparableId = parseComparableMessageId(message.id);
        return comparableId != null && comparableId > lastReadComparable;
      });
      if (firstUnread) {
        setUnreadDividerBeforeId(firstUnread.id);
      }
    }
  }

  const chatRows = useChatRows(messages, formatDateSeparator, showAllAvatars, unreadDividerBeforeId);

  // Defer the heavy chatRows render. When fetchLatestWindow resolves for a
  // cached chat, a single urgent render fires both "data arrived" (rows change)
  // and "spinner should hide" (hasInitialFetchResolved=true). Without
  // deferral, that urgent render must commit ~50 ChatMessageRow mounts +
  // getBoundingClientRect calls synchronously, which freezes the SVG-based
  // IonSpinner animation for the duration of the heavy commit — the user sees
  // "spinner stopped, content not yet visible". By deferring chatRows, the
  // urgent render stays light (old/empty rows + scrim still up), and the
  // expensive row render happens in an interruptible transition so the spinner
  // keeps animating until the deferred rows catch up.
  const deferredChatRows = useDeferredValue(chatRows);
  const chatRowsStale = deferredChatRows !== chatRows;

  useEffect(() => {
    if (messages.length > 0 || pendingLiveCount === 0) {
      emptyTimelinePendingLiveLogKeyRef.current = null;
      return;
    }

    const logKey = `${storeChatId}:${pendingLiveCount}`;
    if (emptyTimelinePendingLiveLogKeyRef.current === logKey) return;
    emptyTimelinePendingLiveLogKeyRef.current = logKey;

    logTimelineDiagnostic('empty-active-timeline-with-pending-live', {
      chatId,
      storeChatId,
      threadId: threadId ?? null,
      pendingLiveCount,
      snapshot: collectTimelineSnapshot(store.getState(), storeChatId),
    });
  }, [chatId, messages.length, pendingLiveCount, storeChatId, threadId]);

  const topVisibleMessageDate = useMemo(() => {
    if (!firstVisibleMessageId) return null;
    const msg = messages.find((message) => message.id === firstVisibleMessageId);
    return msg?.createdAt ?? null;
  }, [firstVisibleMessageId, messages]);

  const bottomVisibleMessageDate = useMemo(() => {
    if (!lastFullyVisibleMessageId) return null;
    const msg = messages.find((message) => message.id === lastFullyVisibleMessageId);
    return msg?.createdAt ?? null;
  }, [lastFullyVisibleMessageId, messages]);

  const { visible: floatingDateVisible, fading: floatingDateFading } = useFloatingDateVisibility(
    !!topVisibleMessageDate,
    messageListScrolling,
  );

  const floatingDateLabel = useMemo(() => {
    if (!topVisibleMessageDate || floatingDateColliding) return null;
    if (messageListScrolling || floatingDateVisible || floatingDateFading) {
      return formatDateSeparator(topVisibleMessageDate);
    }
    return null;
  }, [
    formatDateSeparator,
    messageListScrolling,
    topVisibleMessageDate,
    floatingDateVisible,
    floatingDateFading,
    floatingDateColliding,
  ]);

  const handleFirstVisibleMessageChange = useCallback(
    (messageId: string | null) => {
      setFirstVisibleMessageId(messageId);

      const comparableId = messageId ? parseComparableMessageId(messageId) : null;
      const previousComparableId = previousFirstVisibleComparableIdRef.current;
      if (comparableId == null) return;

      if (previousComparableId != null && comparableId !== previousComparableId) {
        setScrollDirection({ storeChatId, towardNewer: comparableId > previousComparableId });
      }
      previousFirstVisibleComparableIdRef.current = comparableId;
    },
    [storeChatId],
  );

  const getAnchorAlign = (anchor: VirtualScrollAnchor): 'top' | 'bottom' | 'custom' =>
    anchor.type === 'message' ? (anchor.align ?? 'top') : 'top';

  useEffect(() => {
    previousFirstVisibleComparableIdRef.current = null;
    initialLoadCompletedRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasInitialFetchResolved(false);
  }, [storeChatId]);

  const fetchLatestWindow = useCallback(
    (options?: { forceReopen?: boolean }) => {
      const forceReopen = options?.forceReopen ?? false;
      if (!chatId) return;

      const resetAnchor = (resumeMessageId: string | null | undefined) => {
        const effectiveAnchorType: VirtualScrollAnchor['type'] = threadId
          ? resumeMessageId
            ? 'message'
            : 'top'
          : 'bottom';

        setInitialAnchor((currentAnchor) => {
          const align = getAnchorAlign(currentAnchor);
          if (effectiveAnchorType === 'message' && currentAnchor.type === 'message') {
            return {
              type: 'message',
              messageId: currentAnchor.messageId,
              token: currentAnchor.token + 1,
              align,
            };
          }
          if (effectiveAnchorType === 'message' && resumeMessageId) {
            return { type: 'message', messageId: resumeMessageId, token: currentAnchor.token + 1, align };
          }
          return { type: effectiveAnchorType, token: currentAnchor.token + 1 } as VirtualScrollAnchor;
        });
      };

      getMessages(chatId, threadId ? { threadId } : undefined)
        .then((res) => {
          const list = res.data.messages ?? [];
          const olderCursor = res.data.olderCursor ?? null;
          const newerCursor = null;
          const currentState = store.getState();
          const currentMessages = selectActiveTimelineMessages(currentState, storeChatId);
          const currentOlderCursor = selectOlderAnchor(currentState, storeChatId);
          const currentNewerCursor = selectNewerAnchor(currentState, storeChatId);
          const shouldResetAnchor =
            forceReopen ||
            !areMessageListsEquivalent(currentMessages, list) ||
            olderCursor !== currentOlderCursor ||
            newerCursor !== currentNewerCursor;

          dispatch(refreshLatest({ chatId: storeChatId, messages: list, olderCursor, newerCursor }));
          dispatch(setTimelineMode({ chatId: storeChatId, mode: { type: 'latest' } }));

          if (shouldResetAnchor) {
            const resumeId: string | null | undefined =
              initialResumeMessageId ?? (threadId ? threadLastReadMessageIdRef.current : lastReadMessageId);
            resetAnchor(resumeId);
          }
          setHasInitialFetchResolved(true);
        })
        .catch((err: Error) => {
          dispatch(resetChat({ chatId: storeChatId, messages: [], olderCursor: null, newerCursor: null }));
          resetAnchor(initialResumeMessageId);
          showToast(err.message || t`Failed to load messages`);
          setHasInitialFetchResolved(true);
        });
    },
    [
      chatId,
      dispatch,
      initialResumeMessageId,
      lastReadMessageId,
      showToast,
      storeChatId,
      threadId,
      threadLastReadMessageIdRef,
    ],
  );

  useEffect(() => {
    if (!chatId) return;

    if (pendingResumeMessageId != null) {
      initialLoadCompletedRef.current = true;
      getMessages(chatId, { around: pendingResumeMessageId, max: 50, threadId })
        .then((res) => {
          const list = res.data.messages ?? [];
          const olderCursor = res.data.olderCursor ?? null;
          const newerCursor = res.data.newerCursor ?? null;
          const containsTarget = list.some((message) => message.id === pendingResumeMessageId);
          logTimelineDiagnostic('initial-around-response', {
            chatId,
            storeChatId,
            threadId: threadId ?? null,
            requestedAroundId: pendingResumeMessageId,
            fetchedCount: list.length,
            firstId: list[0]?.id ?? null,
            lastId: list[list.length - 1]?.id ?? null,
            containsTarget,
            olderCursor,
            newerCursor,
          });
          dispatch(
            insertAround({
              chatId: storeChatId,
              targetMessageId: pendingResumeMessageId,
              messages: list,
              olderCursor,
              newerCursor,
            }),
          );
          logTimelineDiagnostic('initial-around-store-snapshot', {
            chatId,
            storeChatId,
            threadId: threadId ?? null,
            requestedAroundId: pendingResumeMessageId,
            containsTarget,
            responseReachedLatest: newerCursor === null,
            snapshot: collectTimelineSnapshot(store.getState(), storeChatId),
          });
          if (containsTarget) {
            setInitialAnchor((currentAnchor) => ({
              type: 'message',
              messageId: pendingResumeMessageId,
              token: currentAnchor.token + 1,
              align: 'top' as const,
            }));
          } else {
            // The resume target was not in the fetched window (e.g. the read
            // pointer is ahead of the newest delivered message, or the target
            // was deleted). Anchoring to the phantom id leaves VirtualScroll
            // unable to resolve it, stranding the view at the top of the
            // loaded window. Fall back to the newest message instead.
            setInitialAnchor((currentAnchor) => ({
              type: 'bottom',
              token: currentAnchor.token + 1,
            }));
          }
          setPendingResumeMessageId(null);
          setHasInitialFetchResolved(true);
        })
        .catch(() => {
          setPendingResumeMessageId(null);
          fetchLatestWindow();
        });
    } else if (!initialLoadCompletedRef.current) {
      initialLoadCompletedRef.current = true;
      if (threadId) {
        getThreadReadState(threadId)
          .then((res) => {
            threadLastReadMessageIdRef.current = res.data.lastReadMessageId;
          })
          .catch((err) => {
            console.debug('[Conversation] getThreadReadState failed, falling back', err);
          })
          .finally(() => {
            fetchLatestWindow();
          });
      } else {
        fetchLatestWindow();
      }
    }
  }, [chatId, fetchLatestWindow, dispatch, pendingResumeMessageId, storeChatId, threadId, threadLastReadMessageIdRef]);

  const loadMore = useCallback(() => {
    const st = store.getState();
    const cursor = selectOlderAnchor(st, storeChatId);
    if (!chatId || cursor == null || loadingMoreRef.current) return;
    const gen = selectChatGeneration(st, storeChatId);
    loadingMoreRef.current = true;
    setLoadingMore(true);
    getMessages(chatId, { before: cursor, max: 50, threadId })
      .then((res) => {
        if (selectChatGeneration(store.getState(), storeChatId) !== gen) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
          return;
        }
        const list = res.data.messages ?? [];
        dispatch(
          insertBeforeAnchor({
            chatId: storeChatId,
            anchorMessageId: cursor,
            messages: list,
            olderCursor: res.data.olderCursor ?? null,
          }),
        );
        loadingMoreRef.current = false;
        setLoadingMore(false);
      })
      .catch((err: Error) => {
        showToast(err.message || t`Failed to load more`);
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [chatId, storeChatId, threadId, dispatch, showToast]);

  const loadNewer = useCallback(() => {
    const st = store.getState();
    const newerCursor = selectNewerAnchor(st, storeChatId);
    if (!chatId || newerCursor == null || loadingNewerRef.current) return;
    const gen = selectChatGeneration(st, storeChatId);
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    getMessages(chatId, { after: newerCursor, max: 50, threadId })
      .then((res) => {
        if (selectChatGeneration(store.getState(), storeChatId) !== gen) return;
        const list = res.data.messages ?? [];
        dispatch(
          insertAfterAnchor({
            chatId: storeChatId,
            anchorMessageId: newerCursor,
            messages: list,
            newerCursor: res.data.newerCursor ?? null,
          }),
        );
      })
      .catch((err: Error) => {
        showToast(err.message || t`Failed to load newer messages`);
      })
      .finally(() => {
        loadingNewerRef.current = false;
        setLoadingNewer(false);
      });
  }, [chatId, storeChatId, threadId, dispatch, showToast]);

  // Trigger a brief highlight on the jump target, unless it is the latest
  // message (= resuming to the bottom after opening the chat, not a real jump).
  // Mirrors telegram-tt's focusedMessage behavior.
  const triggerJumpHighlight = useCallback(
    (targetId: string) => {
      if (targetId === latestMessageId) return;
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      dispatch(setMessageHighlight(targetId));
      highlightTimerRef.current = setTimeout(() => {
        dispatch(clearMessageHighlight());
        highlightTimerRef.current = null;
      }, HIGHLIGHT_DURATION_MS);
    },
    [dispatch, latestMessageId],
  );

  const jumpToMessage = useCallback(
    (
      messageId: string,
      options?: { silent?: boolean; align?: 'top' | 'bottom' | 'custom'; offsetRatio?: number },
    ): Promise<boolean> => {
      const align = options?.align ?? 'top';
      const offsetRatio = options?.offsetRatio ?? DEFAULT_OFFSET_RATIO;
      const state = store.getState();
      const currentMessages = selectActiveTimelineMessages(state, storeChatId);
      const idx = currentMessages.findIndex((message) => message.id === messageId);
      if (idx !== -1) {
        const scrolled = scrollApiRef.current?.scrollToMessageId(messageId, 'smooth', align, offsetRatio);
        if (!scrolled) {
          // DOM not ready (rows mid-update) — fall back to the token mechanism
          // so the layout effect retries the scroll once rows commit.
          setInitialAnchor((currentAnchor) => ({
            type: 'message',
            messageId,
            token: currentAnchor.token + 1,
            align,
            offsetRatio,
          }));
        }
        triggerJumpHighlight(messageId);
        return Promise.resolve(true);
      }

      return getMessages(chatId, { around: messageId, max: 50, threadId })
        .then((res) => {
          const list = res.data.messages ?? [];
          const targetMessage = list.find((message) => message.id === messageId) ?? null;

          if (!targetMessage) {
            if (!options?.silent) {
              showToast(t`Message not found`);
            }
            return false;
          }

          dispatch(
            insertAround({
              chatId: storeChatId,
              targetMessageId: messageId,
              messages: list,
              olderCursor: res.data.olderCursor ?? null,
              newerCursor: res.data.newerCursor ?? null,
            }),
          );
          setInitialAnchor((currentAnchor) => ({
            type: 'message',
            messageId,
            token: currentAnchor.token + 1,
            align,
            offsetRatio,
          }));
          triggerJumpHighlight(messageId);
          return true;
        })
        .catch((err: Error) => {
          if (!options?.silent) {
            showToast(err.message || t`Failed to jump to message`);
          }
          return false;
        });
    },
    [chatId, dispatch, showToast, storeChatId, threadId, triggerJumpHighlight],
  );

  const scrollToAbsoluteBottom = useCallback(() => {
    if (canLoadNewer || pendingLiveCount > 0) {
      dispatch(setTimelineMode({ chatId: storeChatId, mode: { type: 'latest' } }));
      dispatch(clearPendingLiveMessages({ chatId: storeChatId }));
      fetchLatestWindow({ forceReopen: true });
      return;
    }

    scrollApiRef.current?.scrollToBottom();
  }, [canLoadNewer, dispatch, fetchLatestWindow, pendingLiveCount, storeChatId]);

  const handleScrollToBottomClick = useCallback(() => {
    const hasUnreadReadBoundary =
      !threadId &&
      scrollToBottomUnreadCount > 0 &&
      lastReadMessageId != null &&
      parseComparableMessageId(lastReadMessageId) != null;
    const alreadyAtReadBoundary =
      lastReadMessageId != null && isMessageAtOrAfter(lastFullyVisibleMessageId, lastReadMessageId);

    if (hasUnreadReadBoundary && !alreadyAtReadBoundary) {
      void jumpToMessage(lastReadMessageId, { silent: true, align: 'bottom' }).then((found) => {
        if (!found) {
          scrollToAbsoluteBottom();
        }
      });
      return;
    }

    scrollToAbsoluteBottom();
  }, [
    jumpToMessage,
    lastFullyVisibleMessageId,
    lastReadMessageId,
    scrollToAbsoluteBottom,
    scrollToBottomUnreadCount,
    threadId,
  ]);

  const revealLatestAfterSend = useCallback(() => {
    if (canLoadNewer || pendingLiveCount > 0) {
      dispatch(setTimelineMode({ chatId: storeChatId, mode: { type: 'latest' } }));
      dispatch(clearPendingLiveMessages({ chatId: storeChatId }));
      setInitialAnchor((current) => ({ type: 'bottom', token: current.token + 1 }));
      fetchLatestWindow({ forceReopen: true });
      return;
    }

    scrollApiRef.current?.scrollToBottom();
  }, [canLoadNewer, dispatch, fetchLatestWindow, pendingLiveCount, storeChatId]);

  const pendingJumpCount = scrollToBottomUnreadCount + pendingLiveCount;
  const isScrollingTowardNewerMessages = scrollDirection.storeChatId === storeChatId && scrollDirection.towardNewer;
  const showScrollToBottomButton = pendingJumpCount > 0 || (!atBottom && isScrollingTowardNewerMessages);
  // Loading ends only when the data fetch has resolved AND the deferred rows
  // have caught up with the latest rows. The `chatRowsStale` term covers the
  // window where fetchLatestWindow resolved (hasInitialFetchResolved=true)
  // but the heavy ChatMessageRow render is still pending in a transition —
  // during that window the spinner must keep animating, otherwise the user
  // sees "spinner stopped, content not yet visible". This makes "loading done"
  // mean "the first stable visible frame is ready", not just "data arrived".
  const isInitialLoading = !hasInitialFetchResolved || chatRowsStale;

  return {
    messages,
    messageLookup,
    chatRows: deferredChatRows,
    bottomVisibleMessageDate,
    lastFullyVisibleMessageId,
    atBottom,
    initialAnchor,
    isInitialLoading,
    scrollApiRef,
    floatingDateLabel,
    floatingDateFading,
    loadOlder: { hasMore: canLoadOlder, loading: loadingMore, onLoad: loadMore },
    loadNewer: canLoadNewer ? { hasMore: true, loading: loadingNewer, onLoad: loadNewer } : undefined,
    jumpToMessage,
    handleScrollToBottomClick,
    pendingJumpCount,
    showScrollToBottomButton,
    revealLatestAfterSend,
    setAtBottom,
    setLastFullyVisibleMessageId,
    handleFirstVisibleMessageChange,
    setMessageListScrolling,
    setFloatingDateColliding,
  };
}
