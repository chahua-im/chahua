import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useDispatch } from 'react-redux';
import { markMessagesAsRead } from '@/api/messages';
import { markThreadAsRead as apiMarkThreadAsRead } from '@/api/threads';
import { READ_REQUEST_COOLDOWN_MS } from '@/constants/chatTiming';
import { usePageVisible } from '@/hooks/usePageVisible';
import { setChatLastReadMessageId, setChatUnreadCount } from '@/store/chatsSlice';
import { setThreadReadState } from '@/store/threadsSlice';
import { syncAppBadgeCount } from '@/utils/badges';
import { isPageHidden } from '@/utils/dom';
import { parseComparableMessageId } from '../utils/conversationUtils';

interface UseChatReadTrackingArgs {
  chatId: string;
  storeChatId: string;
  threadId?: string;
  lastFullyVisibleMessageId: string | null;
  lastReadMessageId: string | null;
  initialResumeMessageId: string | null;
  atBottom: boolean;
  threadLastReadMessageIdRef?: RefObject<string | null>;
}

export function useChatReadTracking({
  chatId,
  storeChatId,
  threadId,
  lastFullyVisibleMessageId,
  lastReadMessageId,
  initialResumeMessageId,
  atBottom,
  threadLastReadMessageIdRef: providedThreadLastReadMessageIdRef,
}: UseChatReadTrackingArgs) {
  const dispatch = useDispatch();
  const internalThreadLastReadMessageIdRef = useRef<string | null>(null);
  const threadLastReadMessageIdRef = providedThreadLastReadMessageIdRef ?? internalThreadLastReadMessageIdRef;
  const lastReportedReadId = useRef<string | null>(null);
  const readRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReadTargetIdRef = useRef<string | null>(null);
  const lastReadRequestAtRef = useRef(0);
  const threadReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastThreadReadIdRef = useRef<string | null>(null);
  const pendingThreadReadIdRef = useRef<string | null>(null);

  useEffect(() => {
    lastReportedReadId.current = null;
    pendingReadTargetIdRef.current = null;
    lastReadRequestAtRef.current = 0;
    lastThreadReadIdRef.current = null;
    pendingThreadReadIdRef.current = null;

    if (readRequestTimerRef.current) {
      clearTimeout(readRequestTimerRef.current);
      readRequestTimerRef.current = null;
    }
    if (threadReadTimerRef.current) {
      clearTimeout(threadReadTimerRef.current);
      threadReadTimerRef.current = null;
    }
  }, [storeChatId]);

  const flushPendingReadTarget = useCallback(() => {
    if (threadId || !chatId) return;
    if (isPageHidden()) return;

    const targetMessageId = pendingReadTargetIdRef.current;
    if (!targetMessageId) return;

    const targetComparableId = parseComparableMessageId(targetMessageId);
    if (targetComparableId == null) {
      pendingReadTargetIdRef.current = null;
      return;
    }

    const currentReadComparableId = lastReadMessageId ? parseComparableMessageId(lastReadMessageId) : null;
    if (currentReadComparableId != null && targetComparableId <= currentReadComparableId) {
      pendingReadTargetIdRef.current = null;
      return;
    }

    if (targetMessageId === lastReportedReadId.current) return;

    pendingReadTargetIdRef.current = null;
    readRequestTimerRef.current = null;
    lastReportedReadId.current = targetMessageId;
    lastReadRequestAtRef.current = Date.now();

    markMessagesAsRead(chatId, targetMessageId)
      .then((res) => {
        dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: res.data.lastReadMessageId }));
        dispatch(setChatUnreadCount({ chatId, unreadCount: res.data.unreadCount }));
        void syncAppBadgeCount();
      })
      .catch((err) => {
        console.error('Failed to mark as read', err);
        lastReportedReadId.current = null;
      });
  }, [chatId, dispatch, lastReadMessageId, threadId]);

  const flushPendingThreadRead = useCallback(() => {
    if (!threadId || !chatId) return;
    const targetId = pendingThreadReadIdRef.current;
    if (!targetId || isPageHidden()) return;
    pendingThreadReadIdRef.current = null;
    threadReadTimerRef.current = null;
    lastThreadReadIdRef.current = targetId;
    apiMarkThreadAsRead(chatId, threadId, targetId)
      .then((res) => {
        dispatch(
          setThreadReadState({
            threadRootId: threadId,
            lastReadMessageId: res.data.lastReadMessageId,
            unreadCount: res.data.unreadCount,
          }),
        );
      })
      .catch((err) => {
        console.error('Failed to mark thread as read', err);
        lastThreadReadIdRef.current = null;
      });
  }, [chatId, threadId, dispatch]);

  useEffect(() => {
    if (threadId || !chatId) return;
    if (initialResumeMessageId == null && lastReadMessageId == null && atBottom) return;

    if (readRequestTimerRef.current) {
      clearTimeout(readRequestTimerRef.current);
      readRequestTimerRef.current = null;
    }

    pendingReadTargetIdRef.current = lastFullyVisibleMessageId;
    if (!lastFullyVisibleMessageId) return;

    const targetComparableId = parseComparableMessageId(lastFullyVisibleMessageId);
    if (targetComparableId == null) {
      pendingReadTargetIdRef.current = null;
      return;
    }

    const currentReadComparableId = lastReadMessageId ? parseComparableMessageId(lastReadMessageId) : null;
    if (currentReadComparableId != null && targetComparableId <= currentReadComparableId) {
      pendingReadTargetIdRef.current = null;
      return;
    }

    const elapsed = Date.now() - lastReadRequestAtRef.current;
    if (elapsed >= READ_REQUEST_COOLDOWN_MS) {
      flushPendingReadTarget();
      return;
    }

    readRequestTimerRef.current = setTimeout(flushPendingReadTarget, READ_REQUEST_COOLDOWN_MS - elapsed);

    return () => {
      if (readRequestTimerRef.current) {
        clearTimeout(readRequestTimerRef.current);
        readRequestTimerRef.current = null;
      }
    };
  }, [
    atBottom,
    chatId,
    flushPendingReadTarget,
    initialResumeMessageId,
    lastFullyVisibleMessageId,
    lastReadMessageId,
    threadId,
  ]);

  useEffect(() => {
    if (!threadId || !chatId) return;
    if (!lastFullyVisibleMessageId) return;
    if (lastFullyVisibleMessageId === lastThreadReadIdRef.current) return;

    const targetComparableId = parseComparableMessageId(lastFullyVisibleMessageId);
    if (targetComparableId == null) return;

    if (threadReadTimerRef.current) {
      clearTimeout(threadReadTimerRef.current);
    }

    pendingThreadReadIdRef.current = lastFullyVisibleMessageId;
    threadReadTimerRef.current = setTimeout(flushPendingThreadRead, READ_REQUEST_COOLDOWN_MS);

    return () => {
      if (threadReadTimerRef.current) {
        clearTimeout(threadReadTimerRef.current);
        threadReadTimerRef.current = null;
      }
    };
  }, [chatId, threadId, lastFullyVisibleMessageId, flushPendingThreadRead]);

  usePageVisible(() => {
    if (!chatId) return;
    if (threadId) {
      flushPendingThreadRead();
    } else {
      flushPendingReadTarget();
    }
  });

  return {
    threadLastReadMessageIdRef,
  };
}
