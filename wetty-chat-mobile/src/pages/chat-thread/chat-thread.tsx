import { MAX_PINNED_REACTIONS } from '@/constants/emojiAndStickers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPageHidden } from '@/utils/dom';
import { usePageVisible } from '@/hooks/usePageVisible';
import { useFloatingDateVisibility } from '@/hooks/useFloatingDate';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFab,
  IonFabButton,
  IonFooter,
  IonHeader,
  IonIcon,
  IonPage,
  IonProgressBar,
  IonTitle,
  IonToolbar,
  useIonAlert,
  useIonToast,
} from '@ionic/react';
import { useHistory, useLocation, useParams } from 'react-router-dom';
import {
  arrowUndo,
  bookmarkOutline,
  chatbubbles,
  chevronDown,
  copyOutline,
  createOutline,
  informationCircleOutline,
  notificationsOffOutline,
  linkOutline,
  heartOutline,
  notifications,
  people,
  pin as pinIcon,
  pinOutline,
  trashOutline,
} from 'ionicons/icons';
import { useDispatch, useSelector } from 'react-redux';
import {
  type Attachment,
  deleteMessage,
  deleteReaction,
  getMessage,
  getMessages,
  markMessagesAsRead,
  mentionToUser,
  type MessageResponse,
  putReaction,
  type User,
  sendMessage,
  sendThreadMessage,
  updateMessage,
} from '@/api/messages';
import { getChatUnreadCount } from '@/api/chats';
import {
  selectChatLastReadMessageId,
  selectChatMeta,
  selectChatName,
  selectChatUnreadCount,
  selectIsChatMuted,
  setChatLastReadMessageId,
  setChatMeta,
  setChatMutedUntil,
  setChatUnreadCount,
} from '@/store/chatsSlice';
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
  selectChatGeneration,
  selectActiveTimelineMessages,
  selectCanLoadNewer,
  selectCanLoadOlder,
  selectNewerAnchor,
  selectOlderAnchor,
  selectPendingLiveCount,
} from '@/store/messages/selectors';
import { messageAdded, messageConfirmed, messagePatched, reactionsUpdated } from '@/store/messageEvents';
import type { RootState } from '@/store/index';
import store from '@/store/index';
import { ChatVirtualScroll } from '@/components/chat/virtualScroll/ChatVirtualScroll';
import type { ChatRow, VirtualScrollAnchor, VirtualScrollHandle } from '@/components/chat/virtualScroll/types';
import { useChatRows } from '@/components/chat/virtualScroll/useChatRows';
import {
  type ComposeSendPayload,
  type MessageComposeBarHandle,
  type ComposeUploadedAttachment,
  type ComposeUploadInput,
  type EditingMessage,
  MessageComposeBar,
} from '@/components/chat/compose/MessageComposeBar';
import './chat-thread.scss';
import { t } from '@lingui/core/macro';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { MessageOverlay, type MessageOverlayAction } from '@/components/chat/messages/MessageOverlay';
import { ReactionDetailsModal } from '@/components/chat/reactions/ReactionDetailsModal';
import { StickerPreviewModal } from '@/components/chat/compose/StickerPreviewModal';
import { getGroupInfo, type GroupRole } from '@/api/group';
import { BackButton } from '@/components/BackButton';
import type { BackAction } from '@/types/back-action';
import { requestUploadUrl, uploadFileToS3 } from '@/api/upload';
import { syncAppBadgeCount } from '@/utils/badges';
import { buildPermalinkUrl } from '@/utils/permalinkUrl';
import { ChatContext } from '@/components/chat/messages/ChatContext';
import { useIsDesktop, useMouseDetected } from '@/hooks/platformHooks';
import { useChatRole } from '@/components/chat/permissions/useChatRole';
import { ChatMessageRow } from '@/components/chat/messages/ChatMessageRow';
import { parseResumeHash } from '@/types/chatThreadNavigation';
import { getUploadMimeType } from '@/utils/heicMedia';
import { READ_REQUEST_COOLDOWN_MS } from '@/constants/chatTiming';
import {
  archiveThread,
  getThreadReadState,
  markThreadAsRead as apiMarkThreadAsRead,
  getThreadSubscriptionStatus,
  getThreads,
  subscribeToThread,
  unarchiveThread,
} from '@/api/threads';
import {
  selectThreadArchivedStatus,
  selectThreadSubscriptionStatus,
  setThreadReadState,
  setThreadSubscriptionStatus,
  setThreadsList,
} from '@/store/threadsSlice';
import { listPins, createPin, deletePin } from '@/api/pins';
import { setPins, selectPinsForChat, selectPinsLoaded } from '@/store/pinsSlice';
import { PinBanner } from '@/components/chat/pins/PinBanner';
import { PinListModal } from '@/components/chat/pins/PinListModal';
import {
  selectEffectiveLocale,
  selectPinnedReactions,
  selectRecentReactions,
  addRecentReaction,
} from '@/store/settingsSlice';
import { MAX_REACTIONS_PER_USER_PER_MESSAGE } from '@/constants/emojiAndStickers';
import { favoriteSticker } from '@/api/stickers';
import { saveMessage } from '@/api/savedMessages';
import { useFeatureGate } from '@/hooks/useFeatureGate';

function generateClientId(): string {
  return `cg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function parseComparableMessageId(messageId: string): bigint | null {
  if (!/^\d+$/.test(messageId)) return null;
  return BigInt(messageId);
}

function isMessageAtOrAfter(messageId: string | null, targetMessageId: string): boolean {
  if (!messageId) return false;
  const comparableId = parseComparableMessageId(messageId);
  const targetComparableId = parseComparableMessageId(targetMessageId);
  if (comparableId == null || targetComparableId == null) return false;
  return comparableId >= targetComparableId;
}

function areAttachmentIdsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function areMessageListsEquivalent(left: MessageResponse[], right: MessageResponse[]): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => {
      const candidate = right[index];
      return candidate != null && message.id === candidate.id;
    })
  );
}

function isAudioMessage(message: MessageResponse): boolean {
  return message.messageType === 'audio';
}

function buildOptimisticUploadedAttachments(uploadedAttachments: ComposeUploadedAttachment[]): {
  attachments: Attachment[];
  revoke: () => void;
} {
  const previewUrls: string[] = [];
  const attachments = uploadedAttachments.map((attachment) => {
    const previewUrl = URL.createObjectURL(attachment.file);
    previewUrls.push(previewUrl);

    return {
      id: attachment.attachmentId,
      url: previewUrl,
      kind: attachment.mimeType,
      size: attachment.size,
      fileName: attachment.file.name,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
    };
  });

  return {
    attachments,
    revoke: () => {
      previewUrls.forEach((previewUrl) => URL.revokeObjectURL(previewUrl));
    },
  };
}

interface ChatThreadCoreProps {
  chatId: string;
  threadId?: string;
  backAction?: BackAction;
}

interface EditSession extends EditingMessage {
  originalMessage: MessageResponse;
}

function hasLoadedThreadChatMeta(cachedMeta?: { name?: string | null; myRole?: GroupRole | null }) {
  return cachedMeta?.name != null && cachedMeta.myRole !== undefined;
}

function ChatThreadCore({ chatId, threadId, backAction }: ChatThreadCoreProps) {
  const storeChatId = threadId ? `${chatId}_thread_${threadId}` : chatId;
  const history = useHistory();
  const location = useLocation();
  const initialResumeMessageIdRef = useRef<string | null>(parseResumeHash(location.hash));
  const initialResumeMessageId = initialResumeMessageIdRef.current;
  const lastHandledResumeKeyRef = useRef<string | null>(
    initialResumeMessageId ? `${storeChatId}:${initialResumeMessageId}` : null,
  );
  const dispatch = useDispatch();
  const currentUserId = useSelector((state: RootState) => state.user.uid);
  const currentUserName = useSelector((state: RootState) => state.user.username);
  const currentUserAvatarUrl = useSelector((state: RootState) => state.user.avatarUrl);
  const wsConnected = useSelector((state: RootState) => state.connection.wsConnected);
  const isDesktop = useIsDesktop();
  const hasPointerDevice = useMouseDetected();
  const savedMessagesEnabled = useFeatureGate('savedMessages');
  const cachedMeta = useSelector((state: RootState) => selectChatMeta(state, chatId));
  const { role: myRole } = useChatRole(chatId);
  const isAdmin = myRole === 'admin';
  const storedName = useSelector((state: RootState) => selectChatName(state, chatId));
  const isMuted = useSelector((state: RootState) => selectIsChatMuted(state, chatId));
  const lastReadMessageId = useSelector((state: RootState) => selectChatLastReadMessageId(state, chatId));
  const threadLastReadMessageIdRef = useRef<string | null>(null);
  const scrollToBottomUnreadCount = useSelector((state: RootState) =>
    threadId ? 0 : selectChatUnreadCount(state, chatId),
  );
  const locale = useSelector(selectEffectiveLocale);
  const pinnedReactions = useSelector(selectPinnedReactions);
  const recentReactions = useSelector(selectRecentReactions);
  const QUICK_REACTION_EMOJIS = useMemo(() => {
    return [...pinnedReactions, ...recentReactions.filter((r) => !pinnedReactions.includes(r))].slice(
      0,
      MAX_PINNED_REACTIONS,
    );
  }, [pinnedReactions, recentReactions]);
  const chatName = threadId ? t`Thread` : (storedName ?? t`Loading...`);

  useEffect(() => {
    if (threadId || !chatId) return;

    let canceled = false;
    getChatUnreadCount(chatId)
      .then((res) => {
        if (canceled) return;
        dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: res.data.lastReadMessageId }));
        dispatch(setChatUnreadCount({ chatId, unreadCount: res.data.unreadCount }));
      })
      .catch(() => {});

    return () => {
      canceled = true;
    };
  }, [chatId, dispatch, threadId]);

  useEffect(() => {
    if (!chatId || hasLoadedThreadChatMeta(cachedMeta)) return;
    getGroupInfo(chatId)
      .then((res) => {
        const { id, mutedUntil, ...meta } = res.data;
        void id;
        dispatch(setChatMeta({ chatId: chatId, meta }));
        dispatch(setChatMutedUntil({ chatId, mutedUntil: mutedUntil ?? null }));
      })
      .catch(() => {});
  }, [chatId, cachedMeta, dispatch]);
  const messages = useSelector((state: RootState) => selectActiveTimelineMessages(state, storeChatId));
  const messageLookup = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);

  const formatDateSeparator = useCallback(
    (iso: string) => {
      if (!iso) return '';
      const date = new Date(iso);
      const now = new Date();

      const isSameDay = (d1: Date, d2: Date) =>
        d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();

      if (isSameDay(date, now)) return t`Today`;

      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (isSameDay(date, yesterday)) return t`Yesterday`;

      return date.toLocaleDateString(locale, {
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
        month: 'short',
        day: 'numeric',
      });
    },
    [locale],
  );

  const scrollApiRef = useRef<VirtualScrollHandle | null>(null);
  const composeBarRef = useRef<MessageComposeBarHandle | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const loadingMoreRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const [initialAnchor, setInitialAnchor] = useState<VirtualScrollAnchor>(() => {
    if (initialResumeMessageId) {
      return { type: 'message', messageId: initialResumeMessageId, token: 0 };
    }
    // For threads without a resume message, default to top (first visit).
    return { type: threadId ? 'top' : 'bottom', token: 0 } as VirtualScrollAnchor;
  });
  const [pendingResumeMessageId, setPendingResumeMessageId] = useState<string | null>(initialResumeMessageId);
  const [lastFullyVisibleMessageId, setLastFullyVisibleMessageId] = useState<string | null>(null);
  const [firstVisibleMessageId, setFirstVisibleMessageId] = useState<string | null>(null);
  const [isScrollingTowardNewerMessages, setIsScrollingTowardNewerMessages] = useState(false);
  const previousFirstVisibleComparableIdRef = useRef<bigint | null>(null);
  const [messageListScrolling, setMessageListScrolling] = useState(false);
  const [floatingDateColliding, setFloatingDateColliding] = useState(false);

  const topVisibleMessageDate = useMemo(() => {
    if (!firstVisibleMessageId) return null;
    const msg = messages.find((m) => m.id === firstVisibleMessageId);
    return msg?.createdAt ?? null;
  }, [firstVisibleMessageId, messages]);
  const bottomVisibleMessageDate = useMemo(() => {
    if (!lastFullyVisibleMessageId) return null;
    const msg = messages.find((m) => m.id === lastFullyVisibleMessageId);
    return msg?.createdAt ?? null;
  }, [lastFullyVisibleMessageId, messages]);
  const { visible: floatingDateVisible, fading: floatingDateFading } = useFloatingDateVisibility(
    !!topVisibleMessageDate,
    messageListScrolling,
  );

  const floatingDateLabel = useMemo(() => {
    if (!topVisibleMessageDate || floatingDateColliding) return null;
    if (messageListScrolling || floatingDateVisible || floatingDateFading)
      return formatDateSeparator(topVisibleMessageDate);
    return null;
  }, [
    formatDateSeparator,
    messageListScrolling,
    topVisibleMessageDate,
    floatingDateVisible,
    floatingDateFading,
    floatingDateColliding,
  ]);

  const chatRows = useChatRows(messages, formatDateSeparator);
  const [presentAlert] = useIonAlert();

  const handleFirstVisibleMessageChange = useCallback((messageId: string | null) => {
    setFirstVisibleMessageId(messageId);

    const comparableId = messageId ? parseComparableMessageId(messageId) : null;
    const previousComparableId = previousFirstVisibleComparableIdRef.current;
    if (comparableId == null) return;

    if (previousComparableId != null && comparableId !== previousComparableId) {
      setIsScrollingTowardNewerMessages(comparableId > previousComparableId);
    }
    previousFirstVisibleComparableIdRef.current = comparableId;
  }, []);

  useEffect(() => {
    previousFirstVisibleComparableIdRef.current = null;
    setIsScrollingTowardNewerMessages(false);
  }, [storeChatId]);

  // Thread subscription state
  const [threadSubscribed, setThreadSubscribed] = useState<boolean | null>(null);
  const [threadArchived, setThreadArchived] = useState<boolean>(false);
  const [threadSubLoading, setThreadSubLoading] = useState(false);
  const syncedThreadSubscribed = useSelector((state: RootState) =>
    threadId ? selectThreadSubscriptionStatus(state, threadId) : null,
  );
  const syncedThreadArchived = useSelector((state: RootState) =>
    threadId ? selectThreadArchivedStatus(state, threadId) : null,
  );

  useEffect(() => {
    if (!threadId || !chatId) return;
    setThreadSubscribed(null);
    getThreadSubscriptionStatus(chatId, threadId)
      .then((res) => {
        setThreadSubscribed(res.data.subscribed);
        setThreadArchived(res.data.archived);
        dispatch(
          setThreadSubscriptionStatus({
            threadRootId: threadId,
            subscribed: res.data.subscribed,
            archived: res.data.archived,
          }),
        );
      })
      .catch(() => setThreadSubscribed(null));
  }, [chatId, threadId, dispatch]);

  useEffect(() => {
    if (syncedThreadSubscribed != null) {
      setThreadSubscribed(syncedThreadSubscribed);
    }
  }, [syncedThreadSubscribed]);

  useEffect(() => {
    if (syncedThreadArchived != null) {
      setThreadArchived(syncedThreadArchived);
    }
  }, [syncedThreadArchived]);

  const handleToggleThreadSubscription = useCallback(async () => {
    if (!threadId || !chatId || threadSubscribed == null) return;

    if (threadArchived) {
      presentAlert({
        header: t`Unarchive thread?`,
        message: t`This thread will move back to Threads. Continue?`,
        buttons: [
          { text: t`Cancel`, role: 'cancel' },
          {
            text: t`Continue`,
            handler: () => {
              setThreadSubLoading(true);
              void unarchiveThread(chatId, threadId)
                .then(() => {
                  setThreadSubscribed(true);
                  setThreadArchived(false);
                  dispatch(setThreadSubscriptionStatus({ threadRootId: threadId, subscribed: true, archived: false }));
                })
                .catch((err) => console.error('Failed to unarchive thread', err))
                .finally(() => setThreadSubLoading(false));
            },
          },
        ],
      });
      return;
    }

    setThreadSubLoading(true);
    try {
      if (threadSubscribed) {
        await archiveThread(chatId, threadId);
        setThreadSubscribed(true);
        setThreadArchived(true);
        dispatch(setThreadSubscriptionStatus({ threadRootId: threadId, subscribed: true, archived: true }));
      } else {
        await subscribeToThread(chatId, threadId);
        setThreadSubscribed(true);
        setThreadArchived(false);
        dispatch(setThreadSubscriptionStatus({ threadRootId: threadId, subscribed: true, archived: false }));
        // Refresh threads list so the newly subscribed thread appears
        getThreads()
          .then((res) =>
            dispatch(setThreadsList({ threads: res.data.threads, nextCursor: res.data.nextCursor, archived: false })),
          )
          .catch(() => {});
      }
    } catch (err) {
      console.error('Failed to toggle thread archive state', err);
    } finally {
      setThreadSubLoading(false);
    }
  }, [chatId, threadArchived, threadId, threadSubscribed, dispatch, presentAlert]);

  // Pinned messages state (main chat only)
  const pins = useSelector((state: RootState) => selectPinsForChat(state, chatId));
  const pinsLoaded = useSelector((state: RootState) => selectPinsLoaded(state, chatId));
  const [pinListOpen, setPinListOpen] = useState(false);

  useEffect(() => {
    if (threadId || pinsLoaded) return;
    listPins(chatId)
      .then((res) => dispatch(setPins({ chatId, pins: res.data.pins })))
      .catch(() => {});
  }, [chatId, threadId, pinsLoaded, dispatch]);

  const [atBottom, setAtBottom] = useState(() => {
    if (threadId) return false;
    if (initialResumeMessageId) return false;
    return true;
  });
  const [replyingTo, setReplyingTo] = useState<MessageResponse | null>(null);
  const [profileSender, setProfileSender] = useState<User | null>(null);
  const [reactionDetail, setReactionDetail] = useState<{ messageId: string; emoji?: string } | null>(null);
  const [stickerPreviewId, setStickerPreviewId] = useState<string | null>(null);
  const [editingSession, setEditingSession] = useState<EditSession | null>(null);
  const [composeFocused, setComposeFocused] = useState(false);
  const [baselineViewportHeight, setBaselineViewportHeight] = useState<number>(
    () => window.visualViewport?.height ?? window.innerHeight,
  );
  const [viewportHeight, setViewportHeight] = useState<number>(
    () => window.visualViewport?.height ?? window.innerHeight,
  );

  const [presentToast] = useIonToast();
  const [overlayMessage, setOverlayMessage] = useState<{
    message: MessageResponse;
    sourceRect: DOMRect;
    interactionPos?: { x: number; y: number };
  } | null>(null);

  // When a long-press happens while the keyboard is open we defer showing the
  // overlay until the keyboard has fully closed, while preserving the press-time
  // rect so the menu stays anchored to the originally pressed message.
  const deferredOverlayRef = useRef<{
    message: MessageResponse;
    sourceRect: DOMRect;
    interactionPos?: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[ChatThread] view-mounted', {
      chatId,
      storeChatId,
      threadId: threadId ?? null,
      locationState: location.state ?? null,
    });
    return () => {
      console.log('[ChatThread] view-unmounted', {
        chatId,
        storeChatId,
        threadId: threadId ?? null,
      });
    };
  }, [chatId, storeChatId, threadId, location.state]);

  useEffect(() => {
    if (isDesktop) return;

    const visualViewport = window.visualViewport;
    const getViewportHeight = () => visualViewport?.height ?? window.innerHeight;
    const updateViewportMetrics = () => {
      const nextViewportHeight = getViewportHeight();
      setViewportHeight(nextViewportHeight);
      if (!composeFocused) {
        setBaselineViewportHeight((prev) => Math.max(prev, nextViewportHeight));
      }
    };

    const target = visualViewport ?? window;
    target.addEventListener('resize', updateViewportMetrics);
    // Also listen for scroll events on visualViewport (iOS fires these when keyboard pushes viewport)
    if (visualViewport) {
      visualViewport.addEventListener('scroll', updateViewportMetrics);
    }

    return () => {
      target.removeEventListener('resize', updateViewportMetrics);
      if (visualViewport) {
        visualViewport.removeEventListener('scroll', updateViewportMetrics);
      }
    };
  }, [composeFocused, isDesktop]);

  const handleComposeFocusChange = useCallback((focused: boolean) => {
    setComposeFocused(focused);
  }, []);

  // Threshold in CSS pixels: when the visible viewport is this much shorter than
  // the keyboard-closed baseline we consider the on-screen keyboard to be open.
  const KEYBOARD_OPEN_HEIGHT_DIFF = 120;
  // When the gap shrinks below this value the keyboard animation is considered finished.
  const KEYBOARD_CLOSED_HEIGHT_DIFF = 20;

  const isKeyboardOpen =
    !isDesktop && composeFocused && baselineViewportHeight - viewportHeight > KEYBOARD_OPEN_HEIGHT_DIFF;
  const keyboardFullyClosed =
    !isDesktop && !composeFocused && baselineViewportHeight - viewportHeight < KEYBOARD_CLOSED_HEIGHT_DIFF;

  // When the keyboard finishes closing after a deferred long-press, show the overlay.
  useEffect(() => {
    if (!keyboardFullyClosed || !deferredOverlayRef.current) return;
    const { message, sourceRect, interactionPos } = deferredOverlayRef.current;
    deferredOverlayRef.current = null;
    setOverlayMessage({ message, sourceRect, interactionPos });
  }, [keyboardFullyClosed]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[ChatThread] rows-changed', {
      chatId,
      storeChatId,
      messageCount: messages.length,
      firstMessageId: messages[0]?.id ?? null,
      lastMessageId: messages[messages.length - 1]?.id ?? null,
      rowCount: chatRows.length,
      initialAnchor,
    });
  }, [chatId, storeChatId, messages, chatRows.length, initialAnchor]);

  const startEditingMessage = useCallback((message: MessageResponse) => {
    setReplyingTo(null);
    setEditingSession({
      messageId: message.id,
      text: message.message ?? '',
      attachments: message.attachments,
      originalMessage: { ...message },
    });
  }, []);

  const requestEditLastOwnMessage = useCallback(() => {
    if (editingSession || replyingTo) return false;

    const recentMessages = messages.slice(-30);
    const lastOwnMessage = [...recentMessages]
      .reverse()
      .find((message) => message.sender.uid === currentUserId && !message.isDeleted);

    if (!lastOwnMessage) {
      return false;
    }

    startEditingMessage(lastOwnMessage);
    return true;
  }, [currentUserId, editingSession, messages, replyingTo, startEditingMessage]);

  // Auto-focus compose input when entering reply or edit mode
  useEffect(() => {
    if (replyingTo || editingSession) {
      requestAnimationFrame(() => {
        composeBarRef.current?.focusInput();
      });
    }
  }, [replyingTo, editingSession]);

  const showToast = useCallback(
    (
      text: string,
      duration = 3000,
      options?: {
        positionAnchor?: string;
      },
    ) => {
      presentToast({
        message: text,
        duration,
        position: 'bottom',
        positionAnchor: options?.positionAnchor,
        cssClass: 'toast-center',
      });
    },
    [presentToast],
  );

  const lastReportedReadId = useRef<string | null>(null);
  const initialLoadCompletedRef = useRef(false);
  const readRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReadTargetIdRef = useRef<string | null>(null);
  const lastReadRequestAtRef = useRef(0);

  useEffect(() => {
    lastReportedReadId.current = null;
    initialLoadCompletedRef.current = false;
    pendingReadTargetIdRef.current = null;
    lastReadRequestAtRef.current = 0;
    if (readRequestTimerRef.current) {
      clearTimeout(readRequestTimerRef.current);
      readRequestTimerRef.current = null;
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

  // Flush pending read targets when the user returns to the app.
  usePageVisible(() => {
    if (!chatId) return;
    if (threadId) {
      flushPendingThreadRead();
    } else {
      flushPendingReadTarget();
    }
  });

  // Thread-specific mark-as-read: fires when viewing a thread and messages become visible.
  // Unlike chat read tracking (which is purely scroll-based), this also fires on mount
  // once the initial messages are rendered and the last visible message is known.
  const threadReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastThreadReadIdRef = useRef<string | null>(null);
  const pendingThreadReadIdRef = useRef<string | null>(null);

  const flushPendingThreadRead = useCallback(() => {
    if (!threadId || !chatId) return;
    const targetId = pendingThreadReadIdRef.current;
    if (!targetId || isPageHidden()) return;
    pendingThreadReadIdRef.current = null;
    threadReadTimerRef.current = null;
    lastThreadReadIdRef.current = targetId;
    apiMarkThreadAsRead(threadId, targetId)
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

  // Reset thread read state when switching threads
  useEffect(() => {
    lastThreadReadIdRef.current = null;
    pendingThreadReadIdRef.current = null;
    if (threadReadTimerRef.current) {
      clearTimeout(threadReadTimerRef.current);
      threadReadTimerRef.current = null;
    }
  }, [storeChatId]);

  // Strip the #msg= hash after it has been captured into initialResumeMessageId
  // so it doesn't linger in the URL bar or get re-consumed on re-render.
  useEffect(() => {
    if (initialResumeMessageId && location.hash) {
      history.replace({ pathname: location.pathname, search: location.search });
    }
    // Only run once on mount — initialResumeMessageId is captured at construction time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchLatestWindow = useCallback(
    (options?: { forceReopen?: boolean }) => {
      const forceReopen = options?.forceReopen ?? false;
      if (!chatId) return;
      if (import.meta.env.DEV) {
        console.log('[ChatThread] fetchLatestWindow:start', {
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
          let nextAnchor: VirtualScrollAnchor;
          if (effectiveAnchorType === 'message' && currentAnchor.type === 'message') {
            nextAnchor = { type: 'message', messageId: currentAnchor.messageId, token: currentAnchor.token + 1 };
          } else if (effectiveAnchorType === 'message' && resumeMessageId) {
            nextAnchor = { type: 'message', messageId: resumeMessageId, token: currentAnchor.token + 1 };
          } else {
            nextAnchor = { type: effectiveAnchorType, token: currentAnchor.token + 1 } as VirtualScrollAnchor;
          }
          return nextAnchor;
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
            console.log('[ChatThread] fetchLatestWindow:resolved', {
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
          dispatch(
            refreshLatest({
              chatId: storeChatId,
              messages: list,
              nextCursor,
              prevCursor,
            }),
          );
          dispatch(setTimelineMode({ chatId: storeChatId, mode: { type: 'latest' } }));

          if (shouldResetAnchor) {
            const resumeId: string | null | undefined =
              initialResumeMessageId ?? (threadId ? threadLastReadMessageIdRef.current : lastReadMessageId);
            resetAnchor(resumeId);
          } else if (import.meta.env.DEV) {
            console.log('[ChatThread] initialAnchor-preserved', {
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
    [chatId, dispatch, initialResumeMessageId, showToast, storeChatId, threadId],
  );

  // Initial load — open at an explicitly requested resume point when navigated from chat list
  useEffect(() => {
    if (!chatId) return;

    if (pendingResumeMessageId != null) {
      initialLoadCompletedRef.current = true;
      getMessages(chatId, { around: pendingResumeMessageId, max: 50, threadId })
        .then((res) => {
          const list = res.data.messages ?? [];
          dispatch(
            insertAround({
              chatId: storeChatId,
              targetMessageId: pendingResumeMessageId,
              messages: list,
              nextCursor: res.data.nextCursor ?? null,
              prevCursor: res.data.prevCursor ?? null,
            }),
          );
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
            console.debug('[ChatThread] getThreadReadState failed, falling back', err);
          })
          .finally(() => {
            fetchLatestWindow();
          });
      } else {
        fetchLatestWindow();
      }
    }
  }, [chatId, fetchLatestWindow, dispatch, pendingResumeMessageId, storeChatId, threadId]);

  // Auto-focus compose input after initial messages load (only on devices with a
  // physical keyboard — on touch-only devices this would pop up the virtual keyboard)
  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    if (hasPointerDevice && messages.length > 0 && !didAutoFocusRef.current) {
      didAutoFocusRef.current = true;
      requestAnimationFrame(() => {
        composeBarRef.current?.focusInput();
      });
    }
  }, [hasPointerDevice, messages.length]);

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
          console.log('[ChatThread] loadMore resolved', {
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

  const handleReactionToggle = useCallback(
    (msg: MessageResponse, emoji: string, currentlyReacted: boolean) => {
      // Optimistically update reactions locally
      const existing = msg.reactions ?? [];
      let optimistic: typeof existing;
      if (currentlyReacted) {
        optimistic = existing
          .map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, reactedByMe: false } : r))
          .filter((r) => r.count > 0);
        deleteReaction(chatId, msg.id, emoji).catch(() => {});
      } else {
        const myReactionsCount = existing.filter((r) => r.reactedByMe).length;
        if (myReactionsCount >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
          showToast(t`You can only add up to ${MAX_REACTIONS_PER_USER_PER_MESSAGE} reactions`, 2000);
          return;
        }
        const found = existing.find((r) => r.emoji === emoji);
        if (found) {
          optimistic = existing.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, reactedByMe: true } : r));
        } else {
          optimistic = [...existing, { emoji, count: 1, reactedByMe: true }];
        }
        dispatch(addRecentReaction(emoji));
        putReaction(chatId, msg.id, emoji).catch(() => {});
      }
      dispatch(reactionsUpdated({ chatId, messageId: msg.id, reactions: optimistic }));
    },
    [chatId, dispatch, showToast],
  );

  const jumpToMessage = useCallback(
    (messageId: string, options?: { silent?: boolean }): Promise<boolean> => {
      const state = store.getState();
      const currentMessages = selectActiveTimelineMessages(state, storeChatId);
      const idx = currentMessages.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        scrollApiRef.current?.scrollToMessageId(messageId, 'smooth');
        return Promise.resolve(true);
      }
      // Message not in current window — fetch centered window
      return getMessages(chatId, { around: messageId, max: 50, threadId })
        .then((res) => {
          const list = res.data.messages ?? [];
          const targetMessage = list.find((message) => message.id === messageId) ?? null;

          if (import.meta.env.DEV) {
            console.log('[ChatThread] jumpToMessage fetched-window', {
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

  useEffect(() => {
    const messageId = parseResumeHash(location.hash);
    if (!messageId) {
      lastHandledResumeKeyRef.current = null;
      return;
    }

    const resumeKey = `${storeChatId}:${messageId}`;
    if (lastHandledResumeKeyRef.current === resumeKey) {
      return;
    }

    lastHandledResumeKeyRef.current = resumeKey;
    void jumpToMessage(messageId).finally(() => {
      if (parseResumeHash(history.location.hash) === messageId) {
        history.replace({
          pathname: history.location.pathname,
          search: history.location.search,
          hash: '',
        });
      }
    });
  }, [history, jumpToMessage, location.hash, storeChatId]);

  const canLoadOlder = useSelector((state: RootState) => selectCanLoadOlder(state, storeChatId));
  const canLoadNewer = useSelector((state: RootState) => selectCanLoadNewer(state, storeChatId));
  const pendingLiveCount = useSelector((state: RootState) => selectPendingLiveCount(state, storeChatId));

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
  const pendingJumpCount = scrollToBottomUnreadCount + pendingLiveCount;
  const showScrollToBottomButton = pendingJumpCount > 0 || (!atBottom && isScrollingTowardNewerMessages);

  const uploadAttachment = useCallback(async ({ file, dimensions, onProgress, signal, order }: ComposeUploadInput) => {
    const res = await requestUploadUrl({
      filename: file.name,
      contentType: getUploadMimeType(file),
      size: file.size,
      order,
      ...dimensions,
    });

    const { uploadUrl, attachmentId, uploadHeaders } = res.data;
    await uploadFileToS3(uploadUrl, file, uploadHeaders, { onProgress, signal });

    return { attachmentId };
  }, []);

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

  const handleSend = useCallback(
    (payload: ComposeSendPayload) => {
      if (!chatId) return;
      // Optimistically mark as subscribed — backend auto-subscribes on reply
      if (threadId && !threadSubscribed) {
        setThreadSubscribed(true);
      }
      if (payload.kind === 'text') {
        const { text, attachmentIds, existingAttachments, uploadedAttachments } = payload;
        const { attachments: optimisticUploadedAttachments, revoke } =
          buildOptimisticUploadedAttachments(uploadedAttachments);

        if (!text.trim() && attachmentIds.length === 0) {
          revoke();
          return;
        }

        // Edit flow
        if (editingSession) {
          const originalAttachmentIds = (editingSession.attachments ?? []).map((attachment) => attachment.id);
          if (!text.trim() && attachmentIds.length === 0) {
            revoke();
            showToast(t`Message cannot be empty`);
            return;
          }
          if (
            text.trim() === editingSession.text.trim() &&
            areAttachmentIdsEqual(attachmentIds, originalAttachmentIds)
          ) {
            revoke();
            return;
          }

          const messageId = editingSession.messageId;
          const currentMessage = messageLookup.get(messageId) ?? editingSession.originalMessage;
          const optimisticMsg = {
            ...currentMessage,
            message: text,
            attachments: [...existingAttachments, ...optimisticUploadedAttachments],
            hasAttachments: attachmentIds.length > 0,
            isEdited: true,
          };

          dispatch(messagePatched({ chatId, messageId, message: optimisticMsg }));
          setEditingSession(null);

          updateMessage(chatId, messageId, { message: text, attachmentIds })
            .then((res) => {
              dispatch(messagePatched({ chatId, messageId, message: res.data }));
            })
            .catch((err: Error) => {
              dispatch(messagePatched({ chatId, messageId, message: editingSession.originalMessage }));
              showToast(err.message || t`Failed to edit message`);
            })
            .finally(() => {
              revoke();
            });
          return;
        }

        const clientGeneratedId = generateClientId();

        const optimistic: MessageResponse = {
          id: clientGeneratedId,
          message: text,
          messageType: 'text',
          replyRootId: threadId ?? null,
          replyToMessage: replyingTo
            ? {
                id: replyingTo.id,
                message: replyingTo.message,
                messageType: replyingTo.messageType,
                sticker: replyingTo.sticker,
                sender: replyingTo.sender,
                isDeleted: replyingTo.isDeleted,
                attachments: replyingTo.attachments,
                mentions: replyingTo.mentions,
              }
            : undefined,
          clientGeneratedId,
          sender: {
            uid: currentUserId || 0,
            gender: 0,
            name: currentUserName,
            avatarUrl: currentUserAvatarUrl || undefined,
          },
          chatId,
          createdAt: new Date().toISOString(),
          isEdited: false,
          isDeleted: false,
          hasAttachments: attachmentIds.length > 0,
          attachments: optimisticUploadedAttachments,
          threadInfo: undefined,
        };
        console.debug('[msg-trace] handleSend:optimistic', {
          cgId: clientGeneratedId,
          chatId,
          storeChatId,
          threadId: threadId ?? null,
        });
        dispatch(
          messageAdded({
            chatId,
            storeChatId,
            message: optimistic,
            origin: 'optimistic',
            scope: threadId ? 'thread' : 'main',
          }),
        );
        setReplyingTo(null);
        revealLatestAfterSend();

        const messagePayload = {
          message: text,
          messageType: 'text' as const,
          clientGeneratedId,
          replyToId: replyingTo?.id,
          attachmentIds,
        };

        const sendPromise = threadId
          ? sendThreadMessage(chatId, threadId, messagePayload)
          : sendMessage(chatId, messagePayload);

        sendPromise
          .then((res) => {
            const postResponse = res.data;
            const confirmed: MessageResponse = {
              ...postResponse,
              replyToMessage: postResponse.replyToMessage
                ? {
                    ...optimistic.replyToMessage,
                    ...postResponse.replyToMessage,
                    attachments: postResponse.replyToMessage.attachments ?? optimistic.replyToMessage?.attachments,
                  }
                : optimistic.replyToMessage,
            };
            console.debug('[msg-trace] handleSend:apiConfirm', {
              cgId: clientGeneratedId,
              confirmedId: confirmed.id,
              storeChatId,
            });
            dispatch(
              messageConfirmed({
                chatId,
                storeChatId,
                clientGeneratedId,
                message: confirmed,
                origin: 'api_confirm',
                scope: threadId ? 'thread' : 'main',
              }),
            );

            // Mark as read up to the message we just sent
            if (threadId) {
              void apiMarkThreadAsRead(threadId, confirmed.id).then((res) => {
                dispatch(
                  setThreadReadState({
                    threadRootId: threadId,
                    lastReadMessageId: res.data.lastReadMessageId,
                    unreadCount: res.data.unreadCount,
                  }),
                );
              });
            } else {
              dispatch(setChatUnreadCount({ chatId, unreadCount: 0 }));
              dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: confirmed.id }));
              void markMessagesAsRead(chatId, confirmed.id).then((res) => {
                dispatch(setChatUnreadCount({ chatId, unreadCount: res.data.unreadCount }));
                dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: res.data.lastReadMessageId }));
              });
              void syncAppBadgeCount();
            }
          })
          .catch((err: Error) => {
            showToast(err.message || t`Failed to send`);
            dispatch(
              messagePatched({
                chatId,
                messageId: clientGeneratedId,
                message: { ...optimistic, isDeleted: true },
              }),
            );
          })
          .finally(() => {
            revoke();
          });
        return;
      }

      if (payload.kind === 'sticker') {
        const clientGeneratedId = generateClientId();
        const optimistic: MessageResponse = {
          id: clientGeneratedId,
          message: null,
          messageType: 'sticker',
          sticker: payload.sticker,
          replyRootId: threadId ?? null,
          replyToMessage: replyingTo
            ? {
                id: replyingTo.id,
                message: replyingTo.message,
                messageType: replyingTo.messageType,
                sticker: replyingTo.sticker,
                sender: replyingTo.sender,
                isDeleted: replyingTo.isDeleted,
                attachments: replyingTo.attachments,
                mentions: replyingTo.mentions,
              }
            : undefined,
          clientGeneratedId,
          sender: {
            uid: currentUserId || 0,
            gender: 0,
            name: currentUserName,
            avatarUrl: currentUserAvatarUrl || undefined,
          },
          chatId,
          createdAt: new Date().toISOString(),
          isEdited: false,
          isDeleted: false,
          hasAttachments: false,
          attachments: [],
          threadInfo: undefined,
        };
        dispatch(
          messageAdded({
            chatId,
            storeChatId,
            message: optimistic,
            origin: 'optimistic',
            scope: threadId ? 'thread' : 'main',
          }),
        );
        setReplyingTo(null);
        revealLatestAfterSend();

        const messagePayload = {
          messageType: 'sticker' as const,
          stickerId: payload.sticker.id,
          clientGeneratedId,
          replyToId: replyingTo?.id,
          attachmentIds: [],
        };

        const sendPromise = threadId
          ? sendThreadMessage(chatId, threadId, messagePayload)
          : sendMessage(chatId, messagePayload);

        sendPromise
          .then((res) => {
            const postResponse = res.data;
            const confirmed: MessageResponse = {
              ...postResponse,
              sticker: postResponse.sticker ?? payload.sticker,
              replyToMessage: postResponse.replyToMessage
                ? {
                    ...optimistic.replyToMessage,
                    ...postResponse.replyToMessage,
                    attachments: postResponse.replyToMessage.attachments ?? optimistic.replyToMessage?.attachments,
                  }
                : optimistic.replyToMessage,
            };
            dispatch(
              messageConfirmed({
                chatId,
                storeChatId,
                clientGeneratedId,
                message: confirmed,
                origin: 'api_confirm',
                scope: threadId ? 'thread' : 'main',
              }),
            );

            // Mark as read up to the message we just sent
            if (threadId) {
              void apiMarkThreadAsRead(threadId, confirmed.id).then((res) => {
                dispatch(
                  setThreadReadState({
                    threadRootId: threadId,
                    lastReadMessageId: res.data.lastReadMessageId,
                    unreadCount: res.data.unreadCount,
                  }),
                );
              });
            } else {
              dispatch(setChatUnreadCount({ chatId, unreadCount: 0 }));
              dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: confirmed.id }));
              void markMessagesAsRead(chatId, confirmed.id).then((res) => {
                dispatch(setChatUnreadCount({ chatId, unreadCount: res.data.unreadCount }));
                dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: res.data.lastReadMessageId }));
              });
              void syncAppBadgeCount();
            }
          })
          .catch((err: Error) => {
            showToast(err.message || t`Failed to send`);
            dispatch(
              messagePatched({
                chatId,
                messageId: clientGeneratedId,
                message: { ...optimistic, isDeleted: true },
              }),
            );
          });
        return;
      }

      const { attachmentId, uploadedAttachment } = payload;
      const { attachments: optimisticAudioAttachments, revoke } = buildOptimisticUploadedAttachments([
        uploadedAttachment,
      ]);
      const clientGeneratedId = generateClientId();
      const optimistic: MessageResponse = {
        id: clientGeneratedId,
        message: '',
        messageType: 'audio',
        replyRootId: threadId ?? null,
        replyToMessage: replyingTo
          ? {
              id: replyingTo.id,
              message: replyingTo.message,
              messageType: replyingTo.messageType,
              sticker: replyingTo.sticker,
              sender: replyingTo.sender,
              isDeleted: replyingTo.isDeleted,
              attachments: replyingTo.attachments,
              mentions: replyingTo.mentions,
            }
          : undefined,
        clientGeneratedId,
        sender: {
          uid: currentUserId || 0,
          gender: 0,
          name: currentUserName,
          avatarUrl: currentUserAvatarUrl || undefined,
        },
        chatId,
        createdAt: new Date().toISOString(),
        isEdited: false,
        isDeleted: false,
        hasAttachments: true,
        attachments: optimisticAudioAttachments,
        threadInfo: undefined,
      };
      dispatch(
        messageAdded({
          chatId,
          storeChatId,
          message: optimistic,
          origin: 'optimistic',
          scope: threadId ? 'thread' : 'main',
        }),
      );
      setReplyingTo(null);
      revealLatestAfterSend();

      const messagePayload = {
        message: '',
        messageType: 'audio' as const,
        clientGeneratedId,
        replyToId: replyingTo?.id,
        attachmentIds: [attachmentId],
      };

      const sendPromise = threadId
        ? sendThreadMessage(chatId, threadId, messagePayload)
        : sendMessage(chatId, messagePayload);

      sendPromise
        .then((res) => {
          const postResponse = res.data;
          const confirmed: MessageResponse = {
            ...postResponse,
            replyToMessage: postResponse.replyToMessage
              ? {
                  ...optimistic.replyToMessage,
                  ...postResponse.replyToMessage,
                  attachments: postResponse.replyToMessage.attachments ?? optimistic.replyToMessage?.attachments,
                }
              : optimistic.replyToMessage,
          };
          dispatch(
            messageConfirmed({
              chatId,
              storeChatId,
              clientGeneratedId,
              message: confirmed,
              origin: 'api_confirm',
              scope: threadId ? 'thread' : 'main',
            }),
          );

          // Mark as read up to the message we just sent
          if (threadId) {
            void apiMarkThreadAsRead(threadId, confirmed.id).then((res) => {
              dispatch(
                setThreadReadState({
                  threadRootId: threadId,
                  lastReadMessageId: res.data.lastReadMessageId,
                  unreadCount: res.data.unreadCount,
                }),
              );
            });
          } else {
            dispatch(setChatUnreadCount({ chatId, unreadCount: 0 }));
            dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: confirmed.id }));
            void markMessagesAsRead(chatId, confirmed.id).then((res) => {
              dispatch(setChatUnreadCount({ chatId, unreadCount: res.data.unreadCount }));
              dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: res.data.lastReadMessageId }));
            });
            void syncAppBadgeCount();
          }
        })
        .catch((err: Error) => {
          showToast(err.message || t`Failed to send`);
          dispatch(
            messagePatched({
              chatId,
              messageId: clientGeneratedId,
              message: { ...optimistic, isDeleted: true },
            }),
          );
        })
        .finally(() => {
          revoke();
        });
    },
    [
      chatId,
      storeChatId,
      threadId,
      threadSubscribed,
      dispatch,
      showToast,
      replyingTo,
      editingSession,
      currentUserId,
      currentUserName,
      currentUserAvatarUrl,
      messageLookup,
      revealLatestAfterSend,
    ],
  );

  const onClickChatItem = useCallback(
    (msg: MessageResponse, sourceRect: DOMRect, interactionPos?: { x: number; y: number }) => {
      if (isKeyboardOpen) {
        // Defer: dismiss keyboard now, then show the overlay after close while
        // preserving the original press-time source rect.
        deferredOverlayRef.current = { message: msg, sourceRect, interactionPos };
        composeBarRef.current?.blurInput();
        return;
      }

      deferredOverlayRef.current = null;
      setOverlayMessage({ message: msg, sourceRect, interactionPos });
    },
    [isKeyboardOpen],
  );

  const overlayActions = useMemo((): MessageOverlayAction[] => {
    if (!overlayMessage) return [];
    const msg = overlayMessage.message;
    const audioMessage = isAudioMessage(msg);
    const stickerMessage = msg.messageType === 'sticker';
    const isOwn = msg.sender.uid === currentUserId;
    const isDeletableAction = !msg.isDeleted && !msg.id.startsWith('cg_');
    const canSaveMessage = savedMessagesEnabled && isDeletableAction && msg.messageType !== 'system';
    const canFavoriteSticker = isDeletableAction;
    const actions: MessageOverlayAction[] = [];

    if (!audioMessage && !stickerMessage) {
      const hasText = !!msg.message?.trim();
      const hasAttachments = msg.attachments && msg.attachments.length > 0;

      if (hasText) {
        actions.push({
          key: 'copy',
          label: hasAttachments ? t`Copy text` : t`Copy`,
          icon: copyOutline,
          handler: () => {
            const textToCopy = msg.message ?? '';
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(textToCopy).catch(console.error);
            } else {
              // Fallback for environments lacking navigator.clipboard.writeText (e.g. insecure contexts or some WebViews)
              const textArea = document.createElement('textarea');
              textArea.value = textToCopy;
              textArea.style.position = 'fixed';
              textArea.style.left = '-9999px';
              document.body.appendChild(textArea);
              textArea.focus();
              textArea.select();
              try {
                document.execCommand('copy');
              } catch (err) {
                console.error('Fallback copy failed', err);
              }
              document.body.removeChild(textArea);
            }
          },
        });
      }
    }

    actions.push({
      key: 'copy-link',
      label: t`Copy Link`,
      icon: linkOutline,
      handler: () => {
        navigator.clipboard.writeText(buildPermalinkUrl(chatId, msg.id));
      },
    });

    if (stickerMessage && canFavoriteSticker) {
      actions.push({
        key: 'favorite',
        label: t`Favorite Sticker`,
        icon: heartOutline,
        handler: () => {
          favoriteSticker(msg.sticker!.id)
            .then(() => {
              showToast(t`Sticker added to favorites`, 2000);
            })
            .catch((e: Error) => {
              showToast(e.message || t`Failed to add sticker to favorites`);
            });
        },
      });
    } else if (!stickerMessage && canSaveMessage) {
      actions.push({
        key: 'save',
        label: t({ message: 'Save', context: 'bookmark a message' }),
        icon: bookmarkOutline,
        handler: () => {
          saveMessage(msg.id)
            .then(() => {
              showToast(t`Message saved`, 2000);
            })
            .catch(() => {
              showToast(t`Failed to save message`);
            });
        },
      });
    }

    actions.push({
      key: 'reply',
      label: t`Reply`,
      icon: arrowUndo,
      handler: () => {
        setReplyingTo(msg);
      },
    });
    if (!threadId && !msg.threadInfo) {
      actions.push({
        key: 'thread',
        label: t`Start Thread`,
        icon: chatbubbles,
        handler: () => {
          history.push(`/chats/chat/${chatId}/thread/${msg.id}`);
        },
      });
    }
    if (isOwn && !audioMessage && !stickerMessage) {
      actions.push({
        key: 'edit',
        label: t`Edit`,
        icon: createOutline,
        handler: () => startEditingMessage(msg),
      });
    }
    if (isOwn || isAdmin) {
      actions.push({
        key: 'delete',
        label: t`Delete`,
        icon: trashOutline,
        role: 'destructive',
        handler: () => {
          presentAlert({
            header: t`Delete Message`,
            message: isOwn
              ? t`Are you sure you want to delete this message?`
              : t`Are you sure you want to delete this message from ${msg.sender.name ?? 'this user'}?`,
            buttons: [
              { text: t`Cancel`, role: 'cancel' as const },
              {
                text: t`Delete`,
                role: 'destructive' as const,
                handler: () => {
                  const deletedOptimistic = { ...msg, isDeleted: true };
                  dispatch(messagePatched({ chatId, messageId: msg.id, message: deletedOptimistic }));
                  deleteMessage(chatId, msg.id).catch((e: any) => {
                    dispatch(messagePatched({ chatId, messageId: msg.id, message: msg }));
                    showToast(e.message || t`Failed to delete message`);
                  });
                },
              },
            ],
          });
        },
      });
    }
    if (!threadId && !msg.isDeleted && isAdmin) {
      const existingPin = pins.find((p) => p.message.id === msg.id);
      actions.push({
        key: 'pin',
        label: existingPin ? t`Unpin` : t`Pin`,
        icon: existingPin ? pinIcon : pinOutline,
        handler: () => {
          presentAlert({
            header: existingPin ? t`Unpin Message` : t`Pin Message`,
            message: existingPin ? t`Would you like to unpin this message?` : t`Pin this message in the group?`,
            buttons: [
              { text: t`Cancel`, role: 'cancel' },
              {
                text: existingPin ? t`Unpin` : t`Pin`,
                role: existingPin ? 'destructive' : undefined,
                handler: () => {
                  if (existingPin) {
                    deletePin(chatId, existingPin.id).catch((e: any) => {
                      showToast(e.message || t`Failed to unpin message`);
                    });
                  } else {
                    createPin(chatId, msg.id).catch((e: any) => {
                      showToast(e.message || t`Failed to pin message`);
                    });
                  }
                },
              },
            ],
          });
        },
      });
    }
    if (msg.reactions?.length) {
      actions.push({
        key: 'reaction-details',
        icon: informationCircleOutline,
        label: t`Reaction Details`,
        handler: () => {
          setReactionDetail({ messageId: msg.id });
        },
      });
    }
    if (stickerMessage) {
      return actions.filter(
        (a) => a.key === 'reply' || a.key === 'delete' || a.key === 'copy-link' || a.key === 'favorite',
      );
    }
    return actions;
  }, [
    overlayMessage,
    currentUserId,
    isAdmin,
    threadId,
    chatId,
    pins,
    history,
    dispatch,
    showToast,
    presentAlert,
    startEditingMessage,
    savedMessagesEnabled,
  ]);

  const renderRow = useCallback(
    (row: ChatRow) => {
      return (
        <ChatMessageRow
          row={row}
          currentUserId={currentUserId}
          threadId={threadId}
          onReply={setReplyingTo}
          onJumpToReply={jumpToMessage}
          onLongPress={onClickChatItem}
          onAvatarClick={setProfileSender}
          onThreadClick={(message) => history.push(`/chats/chat/${chatId}/thread/${message.id}`)}
          onReactionToggle={handleReactionToggle}
          onStickerTap={setStickerPreviewId}
        />
      );
    },
    [currentUserId, threadId, chatId, history, jumpToMessage, onClickChatItem, handleReactionToggle],
  );

  const chatCtx = useMemo(() => ({ chatId, threadId, jumpToMessage }), [chatId, threadId, jumpToMessage]);

  return (
    <ChatContext.Provider value={chatCtx}>
      <div
        className="ion-page chat-thread-page"
        style={
          isKeyboardOpen
            ? {
                height: `${viewportHeight}px`,
                top: `${window.visualViewport?.offsetTop ?? 0}px`,
              }
            : undefined
        }
      >
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">{backAction && <BackButton action={backAction} />}</IonButtons>
            <IonTitle>
              <span className="chat-thread-title">
                <span>{chatName}</span>
                {isMuted && !threadId ? (
                  <IonIcon aria-hidden="true" icon={notificationsOffOutline} className="chat-thread-title__icon" />
                ) : null}
              </span>
            </IonTitle>
            <IonButtons slot="end">
              {threadId ? (
                threadSubscribed != null && (
                  <IonButton
                    onClick={handleToggleThreadSubscription}
                    disabled={threadSubLoading}
                    color={threadSubscribed && !threadArchived ? undefined : 'medium'}
                  >
                    <IonIcon
                      slot="icon-only"
                      icon={threadSubscribed && !threadArchived ? notifications : notificationsOffOutline}
                    />
                  </IonButton>
                )
              ) : (
                <>
                  <IonButton onClick={() => history.push(`/chats/chat/${chatId}/members`)}>
                    <IonIcon slot="icon-only" icon={people} />
                  </IonButton>
                  <IonButton onClick={() => history.push(`/chats/chat/${chatId}/group-info`)}>
                    <IonIcon slot="icon-only" icon={informationCircleOutline} />
                  </IonButton>
                </>
              )}
            </IonButtons>
            {!wsConnected && <IonProgressBar type="indeterminate" />}
          </IonToolbar>
        </IonHeader>

        {!threadId && (
          <PinBanner
            chatId={chatId}
            bottomVisibleMessageDate={bottomVisibleMessageDate}
            onClickPin={jumpToMessage}
            onClickThread={(messageId) => history.push(`/chats/chat/${chatId}/thread/${messageId}`)}
            onClickCounter={() => setPinListOpen(true)}
          />
        )}
        <IonContent className="chat-thread-content" scrollX={false} scrollY={false}>
          <ChatVirtualScroll
            key={storeChatId}
            rows={chatRows}
            renderRow={renderRow}
            initialAnchor={initialAnchor}
            topOverlay={
              floatingDateLabel ? (
                <div
                  className={`chat-thread-floating-date ${floatingDateFading ? 'chat-thread-floating-date--fading' : ''}`}
                >
                  <span className="chat-thread-floating-date__label">{floatingDateLabel}</span>
                </div>
              ) : null
            }
            loadOlder={{ hasMore: canLoadOlder, loading: loadingMore, onLoad: loadMore }}
            loadNewer={canLoadNewer ? { hasMore: true, loading: loadingNewer, onLoad: loadNewer } : undefined}
            scrollApiRef={scrollApiRef}
            bottomPadding={16}
            onAtBottomChange={setAtBottom}
            onLastFullyVisibleMessageChange={setLastFullyVisibleMessageId}
            onFirstVisibleMessageChange={handleFirstVisibleMessageChange}
            onScrollActivityChange={setMessageListScrolling}
            onTopDateCollidingChange={setFloatingDateColliding}
          />
          <IonFab
            vertical="bottom"
            horizontal="end"
            className={`scroll-to-bottom-fab ${showScrollToBottomButton ? '' : 'scroll-to-bottom-fab--hidden'}`}
          >
            {pendingJumpCount > 0 && (
              <span className="scroll-to-bottom-fab__badge">{pendingJumpCount > 99 ? '99+' : pendingJumpCount}</span>
            )}
            <IonFabButton size="small" onClick={handleScrollToBottomClick}>
              <IonIcon icon={chevronDown} />
            </IonFabButton>
          </IonFab>
        </IonContent>

        <IonFooter className={`chat-thread-footer${isKeyboardOpen ? ' keyboard-open' : ''}`}>
          <MessageComposeBar
            ref={composeBarRef}
            chatId={chatId}
            draftKey={storeChatId}
            onRestoreReply={async (replyToMessageId, replyToUsername) => {
              const message = messageLookup.get(replyToMessageId);
              if (message) {
                setReplyingTo(message);
                return;
              }
              try {
                const res = await getMessage(chatId, replyToMessageId);
                setReplyingTo(res.data);
              } catch (e: any) {
                if (e?.response?.status !== 404) return;
                // Message hard-deleted — show [Deleted] in reply banner, preserving username
                setReplyingTo({
                  id: replyToMessageId,
                  message: null,
                  messageType: 'text',
                  replyRootId: null,
                  clientGeneratedId: '',
                  sender: { uid: 0, name: replyToUsername ?? null, gender: 0 },
                  chatId,
                  createdAt: '',
                  isEdited: false,
                  isDeleted: true,
                  hasAttachments: false,
                });
              }
            }}
            onSend={handleSend}
            uploadAttachment={uploadAttachment}
            onError={(message) => showToast(message, 3000)}
            onFocusChange={handleComposeFocusChange}
            replyTo={
              replyingTo
                ? {
                    messageId: replyingTo.id,
                    username: replyingTo.sender.name ?? `User ${replyingTo.sender.uid}`,
                    messageType: replyingTo.messageType,
                    text: replyingTo.message,
                    attachments: replyingTo.attachments,
                    firstAttachmentKind: replyingTo.attachments?.[0]?.kind,
                    isDeleted: replyingTo.isDeleted,
                    mentions: replyingTo.mentions,
                  }
                : undefined
            }
            onCancelReply={() => setReplyingTo(null)}
            editing={editingSession ?? undefined}
            onCancelEdit={() => setEditingSession(null)}
            onRequestEditLastMessage={requestEditLastOwnMessage}
          />
        </IonFooter>
        <UserProfileModal
          sender={profileSender}
          onDismiss={() => setProfileSender(null)}
          chatId={chatId}
          canManage={isAdmin}
        />
        <ReactionDetailsModal
          chatId={chatId}
          messageId={reactionDetail?.messageId ?? null}
          initialEmoji={reactionDetail?.emoji}
          onDismiss={() => setReactionDetail(null)}
          onAvatarClick={setProfileSender}
        />
        <StickerPreviewModal stickerId={stickerPreviewId} onDismiss={() => setStickerPreviewId(null)} />
        <PinListModal
          chatId={chatId}
          isOpen={pinListOpen}
          onDismiss={() => setPinListOpen(false)}
          onSelectPin={jumpToMessage}
          onSelectThread={(messageId) => history.push(`/chats/chat/${chatId}/thread/${messageId}`)}
        />
        {overlayMessage &&
          (() => {
            const msg = overlayMessage.message;
            const sharedOverlayProps = {
              senderName: msg.sender.name ?? `User ${msg.sender.uid}`,
              isSent: msg.sender.uid === currentUserId,
              showName: true,
              timestamp: msg.createdAt,
              edited: msg.isEdited,
              isConfirmed: !msg.id.startsWith('cg_'),
              messageId: msg.id,
              replyTo: msg.replyToMessage
                ? {
                    senderName: msg.replyToMessage.sender.name ?? `User ${msg.replyToMessage.sender.uid}`,
                    preview: msg.replyToMessage,
                  }
                : undefined,
              sourceRect: overlayMessage.sourceRect,
              interactionPos: overlayMessage.interactionPos,
              actions: overlayActions,
              reactions: {
                emojis: QUICK_REACTION_EMOJIS,
                currentMessageReactions: msg.reactions?.map((r) => r.emoji) ?? [],
                onReact: (emoji: string) => {
                  handleReactionToggle(msg, emoji, !!msg.reactions?.some((r) => r.emoji === emoji && r.reactedByMe));
                },
              },
              onClose: () => {
                deferredOverlayRef.current = null;
                setOverlayMessage(null);
              },
              mentions: msg.mentions ?? undefined,
              currentUserUid: currentUserId,
              onMentionClick: (uid: number) => setProfileSender(mentionToUser(msg.mentions, uid)),
            } as const;

            if (msg.messageType === 'sticker') {
              return (
                <MessageOverlay
                  messageType="sticker"
                  stickerUrl={msg.sticker?.media.url ?? ''}
                  {...sharedOverlayProps}
                />
              );
            }

            return (
              <MessageOverlay
                messageType={msg.messageType as 'text' | 'audio'}
                message={msg.isDeleted ? t`[Deleted]` : (msg.message ?? '')}
                attachments={msg.attachments}
                {...sharedOverlayProps}
              />
            );
          })()}
      </div>
    </ChatContext.Provider>
  );
}

export function ChatThreadPage() {
  const { id: chatId, threadId } = useParams<{ id: string; threadId?: string }>();
  const renderKey = threadId ?? chatId;
  const backAction: BackAction = threadId
    ? { type: 'back', defaultHref: `/chats/chat/${chatId}` }
    : { type: 'back', defaultHref: '/chats' };
  return (
    <IonPage>
      <ChatThreadCore key={renderKey} chatId={chatId} threadId={threadId} backAction={backAction} />
    </IonPage>
  );
}

export default ChatThreadCore;
