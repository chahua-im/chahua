import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { t } from '@lingui/core/macro';
import { useDispatch, useSelector } from 'react-redux';
import { selectShowAllAvatars } from '@/store/settingsSlice';
import { getMessages } from '@/api/messages';
import { getThreadReadState } from '@/api/threads';
import type { VirtualScrollAnchor, VirtualScrollHandle } from '@/components/chat/virtualScroll/types';
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
  const loadingMoreRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const [initialAnchor, setInitialAnchor] = useState<VirtualScrollAnchor>(() => {
    if (initialResumeMessageId) {
      return { type: 'message', messageId: initialResumeMessageId, token: 0 };
    }
    return { type: threadId ? 'top' : 'bottom', token: 0 } as VirtualScrollAnchor;
  });
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
  const showAllAvatars = useSelector(selectShowAllAvatars);
  const chatRows = useChatRows(messages, formatDateSeparator, showAllAvatars);

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

  useEffect(() => {
    previousFirstVisibleComparableIdRef.current = null;
    initialLoadCompletedRef.current = false;
  }, [storeChatId]);

  const fetchLatestWindow = useCallback(
    (options?: { forceReopen?: boolean }) => {
      const forceReopen = options?.forceReopen ?? false;
      if (!chatId) return;
      if (import.meta.env.DEV) {
        console.log('[Conversation] fetchLatestWindow:start', {
          chatId,
          storeChatId,
          threadId: threadId ?? null,
          forceReopen,
        });
      }

      const resetAnchor = (resumeMessageId: string | null | undefined) => {
        const effectiveAnchorType: VirtualScrollAnchor['type'] = threadId
          ? resumeMessageId
            ? 'message'
            : 'top'
          : 'bottom';

        setInitialAnchor((currentAnchor) => {
          if (effectiveAnchorType === 'message' && currentAnchor.type === 'message') {
            return { type: 'message', messageId: currentAnchor.messageId, token: currentAnchor.token + 1 };
          }
          if (effectiveAnchorType === 'message' && resumeMessageId) {
            return { type: 'message', messageId: resumeMessageId, token: currentAnchor.token + 1 };
          }
          return { type: effectiveAnchorType, token: currentAnchor.token + 1 } as VirtualScrollAnchor;
        });
      };

      getMessages(chatId, threadId ? { threadId } : undefined)
        .then((res) => {
          const list = res.data.messages ?? [];
          const nextCursor = res.data.nextCursor ?? null;
          const prevCursor = null;
          const currentState = store.getState();
          const currentMessages = selectActiveTimelineMessages(currentState, storeChatId);
          const currentNextCursor = selectOlderAnchor(currentState, storeChatId);
          const currentPrevCursor = selectNewerAnchor(currentState, storeChatId);
          const shouldResetAnchor =
            forceReopen ||
            !areMessageListsEquivalent(currentMessages, list) ||
            nextCursor !== currentNextCursor ||
            prevCursor !== currentPrevCursor;

          if (import.meta.env.DEV) {
            console.log('[Conversation] fetchLatestWindow:resolved', {
              chatId,
              storeChatId,
              threadId: threadId ?? null,
              forceReopen,
              fetchedCount: list.length,
              firstMessageId: list[0]?.id ?? null,
              lastMessageId: list[list.length - 1]?.id ?? null,
              nextCursor,
              prevCursor,
              currentMessageCount: currentMessages.length,
              currentFirstMessageId: currentMessages[0]?.id ?? null,
              currentLastMessageId: currentMessages[currentMessages.length - 1]?.id ?? null,
              shouldResetAnchor,
            });
          }

          console.debug('[msg-trace] fetchLatestWindow:resolved', {
            storeChatId,
            forceReopen,
            fetchedCount: list.length,
            shouldResetAnchor,
            firstFetchedId: list[0]?.id ?? null,
            lastFetchedId: list[list.length - 1]?.id ?? null,
          });

          dispatch(refreshLatest({ chatId: storeChatId, messages: list, nextCursor, prevCursor }));
          dispatch(setTimelineMode({ chatId: storeChatId, mode: { type: 'latest' } }));

          if (shouldResetAnchor) {
            const resumeId: string | null | undefined =
              initialResumeMessageId ?? (threadId ? threadLastReadMessageIdRef.current : lastReadMessageId);
            resetAnchor(resumeId);
          } else if (import.meta.env.DEV) {
            console.log('[Conversation] initialAnchor-preserved', {
              reason: 'fetchLatestWindow-equivalentWindow',
              chatId,
              storeChatId,
            });
          }
        })
        .catch((err: Error) => {
          console.debug('[msg-trace] fetchLatestWindow:error', {
            storeChatId,
            error: err.message,
          });
          dispatch(resetChat({ chatId: storeChatId, messages: [], nextCursor: null, prevCursor: null }));
          resetAnchor(initialResumeMessageId);
          showToast(err.message || t`Failed to load messages`);
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
          const nextCursor = res.data.nextCursor ?? null;
          const prevCursor = res.data.prevCursor ?? null;
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
            nextCursor,
            prevCursor,
          });
          dispatch(
            insertAround({
              chatId: storeChatId,
              targetMessageId: pendingResumeMessageId,
              messages: list,
              nextCursor,
              prevCursor,
            }),
          );
          logTimelineDiagnostic('initial-around-store-snapshot', {
            chatId,
            storeChatId,
            threadId: threadId ?? null,
            requestedAroundId: pendingResumeMessageId,
            containsTarget,
            responseReachedLatest: prevCursor === null,
            snapshot: collectTimelineSnapshot(store.getState(), storeChatId),
          });
          setInitialAnchor((currentAnchor) => ({
            type: 'message',
            messageId: pendingResumeMessageId,
            token: currentAnchor.token + 1,
          }));
          setPendingResumeMessageId(null);
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
        if (import.meta.env.DEV) {
          console.log('[Conversation] loadMore resolved', {
            fetchedCount: list.length,
            oldestId: list[0]?.id ?? null,
            newestId: list[list.length - 1]?.id ?? null,
            nextCursor: res.data.nextCursor ?? null,
          });
        }
        dispatch(
          insertBeforeAnchor({
            chatId: storeChatId,
            anchorMessageId: cursor,
            messages: list,
            nextCursor: res.data.nextCursor ?? null,
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
    const prevCursor = selectNewerAnchor(st, storeChatId);
    if (!chatId || prevCursor == null || loadingNewerRef.current) return;
    const gen = selectChatGeneration(st, storeChatId);
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    getMessages(chatId, { after: prevCursor, max: 50, threadId })
      .then((res) => {
        if (selectChatGeneration(store.getState(), storeChatId) !== gen) return;
        const list = res.data.messages ?? [];
        dispatch(
          insertAfterAnchor({
            chatId: storeChatId,
            anchorMessageId: prevCursor,
            messages: list,
            prevCursor: res.data.prevCursor ?? null,
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

  const jumpToMessage = useCallback(
    (messageId: string, options?: { silent?: boolean }): Promise<boolean> => {
      const state = store.getState();
      const currentMessages = selectActiveTimelineMessages(state, storeChatId);
      const idx = currentMessages.findIndex((message) => message.id === messageId);
      if (idx !== -1) {
        scrollApiRef.current?.scrollToMessageId(messageId, 'smooth');
        return Promise.resolve(true);
      }

      return getMessages(chatId, { around: messageId, max: 50, threadId })
        .then((res) => {
          const list = res.data.messages ?? [];
          const targetMessage = list.find((message) => message.id === messageId) ?? null;

          if (import.meta.env.DEV) {
            console.log('[Conversation] jumpToMessage fetched-window', {
              chatId,
              storeChatId,
              threadId: threadId ?? null,
              messageId,
              fetchedCount: list.length,
              targetFound: targetMessage != null,
              targetClientGeneratedId: targetMessage?.clientGeneratedId ?? null,
            });
          }

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
              nextCursor: res.data.nextCursor ?? null,
              prevCursor: res.data.prevCursor ?? null,
            }),
          );
          setInitialAnchor((currentAnchor) => ({
            type: 'message',
            messageId,
            token: currentAnchor.token + 1,
          }));
          return true;
        })
        .catch((err: Error) => {
          if (!options?.silent) {
            showToast(err.message || t`Failed to jump to message`);
          }
          return false;
        });
    },
    [chatId, dispatch, showToast, storeChatId, threadId],
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
      void jumpToMessage(lastReadMessageId, { silent: true }).then((found) => {
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
    const state = store.getState();
    const chatState = state.messages.chats[storeChatId];
    const winInfo = chatState
      ? {
          segmentCount: chatState.segments.length,
          segmentMsgCounts: chatState.segments.map((segment: { messages: unknown[] }) => segment.messages.length),
          optimisticCount: chatState.optimisticMessages.length,
        }
      : null;

    if (canLoadNewer || pendingLiveCount > 0) {
      console.debug('[msg-trace] revealLatestAfterSend:activateLatest', {
        storeChatId,
        canLoadNewer,
        pendingLiveCount,
        ...winInfo,
      });
      dispatch(setTimelineMode({ chatId: storeChatId, mode: { type: 'latest' } }));
      dispatch(clearPendingLiveMessages({ chatId: storeChatId }));
      setInitialAnchor((current) => ({ type: 'bottom', token: current.token + 1 }));
      fetchLatestWindow({ forceReopen: true });
      return;
    }

    console.debug('[msg-trace] revealLatestAfterSend:scrollToBottom', {
      storeChatId,
      ...winInfo,
    });
    scrollApiRef.current?.scrollToBottom();
  }, [canLoadNewer, dispatch, fetchLatestWindow, pendingLiveCount, storeChatId]);

  const pendingJumpCount = scrollToBottomUnreadCount + pendingLiveCount;
  const isScrollingTowardNewerMessages = scrollDirection.storeChatId === storeChatId && scrollDirection.towardNewer;
  const showScrollToBottomButton = pendingJumpCount > 0 || (!atBottom && isScrollingTowardNewerMessages);

  return {
    messages,
    messageLookup,
    chatRows,
    bottomVisibleMessageDate,
    lastFullyVisibleMessageId,
    atBottom,
    initialAnchor,
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
