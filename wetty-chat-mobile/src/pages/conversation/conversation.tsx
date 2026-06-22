import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IonContent, IonFab, IonFabButton, IonIcon, IonPage, useIonAlert, useIonToast } from '@ionic/react';
import { useHistory, useLocation, useParams } from 'react-router-dom';
import { chevronDown } from 'ionicons/icons';
import { useSelector } from 'react-redux';
import { getMessage, type MessageResponse, type User } from '@/api/messages';
import { selectCurrentUser } from '@/store/userSlice';
import { ChatVirtualScroll } from '@/components/chat/virtualScroll/ChatVirtualScroll';
import type { ChatRow } from '@/components/chat/virtualScroll/types';
import { type MessageComposeBarHandle } from '@/components/chat/compose/MessageComposeBar';
import './conversation.scss';
import { t } from '@lingui/core/macro';
import type { BackAction } from '@/types/back-action';
import { ChatContext } from '@/components/chat/messages/ChatContext';
import { useIsDesktop, useMouseDetected } from '@/hooks/platformHooks';
import { ChatMessageRow } from '@/components/chat/messages/ChatMessageRow';
import { parseResumeHash } from '@/types/conversationNavigation';
import { PinBanner } from '@/components/chat/pins/PinBanner';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { ConversationFooter } from './ConversationFooter';
import { ConversationHeader } from './ConversationHeader';
import { ConversationOverlayHost } from './ConversationOverlayHost';
import { useChatMetadata } from './hooks/useChatMetadata';
import { useChatPins } from './hooks/useChatPins';
import { type ChatMessageEditSession, useChatMessageSender } from './hooks/useChatMessageSender';
import { useChatReadTracking } from './hooks/useChatReadTracking';
import { useConversationTimeline } from './hooks/useConversationTimeline';
import { useKeyboardViewport } from './hooks/useKeyboardViewport';
import { formatUnreadBadge } from '@/utils/unreadBadge';
import { useMessageOverlayActions } from './hooks/useMessageOverlayActions';
import { useMessageReactions } from './hooks/useMessageReactions';
import { useThreadSubscription } from './hooks/useThreadSubscription';
import { formatDateSeparator } from './utils/conversationUtils';

interface ConversationPaneProps {
  chatId: string;
  threadId?: string;
  backAction?: BackAction;
}

function ConversationPane({ chatId, threadId, backAction }: ConversationPaneProps) {
  const history = useHistory();
  const location = useLocation();

  // Platform info
  const isDesktop = useIsDesktop();
  const hasPointerDevice = useMouseDetected();

  // Feature Gates
  const savedMessagesEnabled = useFeatureGate('savedMessages');

  // Global states
  const locale = useSelector(selectEffectiveLocale);
  const currentUser = useSelector(selectCurrentUser);
  const storeChatId = threadId ? `${chatId}_thread_${threadId}` : chatId;

  // Parsed from #msg=, read only, parsed once on mount
  const [initialResumeMessageId] = useState(() => parseResumeHash(location.hash));
  const lastHandledResumeKeyRef = useRef<string | null>(
    initialResumeMessageId ? `${storeChatId}:${initialResumeMessageId}` : null,
  );

  const { name, isAdmin, isMuted, lastReadMessageId, unreadCount } = useChatMetadata({ chatId, threadId });
  const chatName = threadId ? t`Thread` : (name ?? t`Loading...`);
  const formatDateSeparatorForLocale = useCallback(
    (iso: string) => formatDateSeparator(iso, locale, { today: t`Today`, yesterday: t`Yesterday` }),
    [locale],
  );

  const [presentAlert] = useIonAlert();
  const [presentToast] = useIonToast();
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

  const composeBarRef = useRef<MessageComposeBarHandle | null>(null);
  const threadLastReadMessageIdRef = useRef<string | null>(null);

  const {
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
    loadOlder,
    loadNewer,
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
  } = useConversationTimeline({
    chatId,
    storeChatId,
    threadId,
    initialResumeMessageId,
    lastReadMessageId,
    scrollToBottomUnreadCount: unreadCount,
    threadLastReadMessageIdRef,
    formatDateSeparator: formatDateSeparatorForLocale,
    showToast,
  });

  useChatReadTracking({
    chatId,
    storeChatId,
    threadId,
    lastFullyVisibleMessageId,
    lastReadMessageId,
    initialResumeMessageId,
    atBottom,
    threadLastReadMessageIdRef,
  });

  const {
    threadSubscribed,
    threadArchived,
    threadSubLoading,
    handleToggleThreadSubscription,
    markThreadSubscribedOptimistically,
  } = useThreadSubscription({ chatId, threadId });

  const { pins, pinListOpen, openPinList, closePinList } = useChatPins({ chatId, threadId });

  const [replyingTo, setReplyingTo] = useState<MessageResponse | null>(null);
  const [profileSender, setProfileSender] = useState<User | null>(null);
  const [reactionDetail, setReactionDetail] = useState<{ messageId: string; emoji?: string } | null>(null);
  const [stickerPreviewId, setStickerPreviewId] = useState<string | null>(null);
  const [editingSession, setEditingSession] = useState<ChatMessageEditSession | null>(null);
  const { handleComposeFocusChange, isKeyboardOpen, keyboardFullyClosed, pageStyle } = useKeyboardViewport(isDesktop);

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
    console.log('[Conversation] view-mounted', {
      chatId,
      storeChatId,
      threadId: threadId ?? null,
      locationState: location.state ?? null,
    });
    return () => {
      console.log('[Conversation] view-unmounted', {
        chatId,
        storeChatId,
        threadId: threadId ?? null,
      });
    };
  }, [chatId, storeChatId, threadId, location.state]);

  // When the keyboard finishes closing after a deferred long-press, show the overlay.
  useEffect(() => {
    if (!keyboardFullyClosed || !deferredOverlayRef.current) return;
    const { message, sourceRect, interactionPos } = deferredOverlayRef.current;
    deferredOverlayRef.current = null;
    setOverlayMessage({ message, sourceRect, interactionPos });
  }, [keyboardFullyClosed]);

  // Auto-redirect from thread view when the root message and all replies are deleted.
  // When a deleted root loses its last reply, threadInfo is cleared → the message is
  // removed from the timeline entirely. Track whether we've seen the root at least once
  // to avoid redirecting during initial load before the API response arrives.
  const hasSeenRootRef = useRef(false);
  useEffect(() => {
    if (!threadId) return;
    const rootMessage = messageLookup.get(threadId);
    if (rootMessage) {
      hasSeenRootRef.current = true;
    } else if (hasSeenRootRef.current) {
      // Root was present before but is now gone — discussion terminated.
      history.replace(`/chats/chat/${chatId}`);
    }
  }, [threadId, messageLookup, chatId, history]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[Conversation] rows-changed', {
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
      .find((message) => message.sender.uid === currentUser.uid && !message.isDeleted);

    if (!lastOwnMessage) {
      return false;
    }

    startEditingMessage(lastOwnMessage);
    return true;
  }, [currentUser.uid, editingSession, messages, replyingTo, startEditingMessage]);

  // Auto-focus compose input when entering reply or edit mode
  useEffect(() => {
    if (replyingTo || editingSession) {
      requestAnimationFrame(() => {
        composeBarRef.current?.focusInput();
      });
    }
  }, [replyingTo, editingSession]);

  const { quickReactionEmojis, handleReactionToggle } = useMessageReactions({ chatId, showToast });

  // Strip the #msg= hash after it has been captured into initialResumeMessageId
  // so it doesn't linger in the URL bar or get re-consumed on re-render.
  useEffect(() => {
    if (initialResumeMessageId && location.hash) {
      history.replace({ pathname: location.pathname, search: location.search });
    }
    // Only run once on mount — initialResumeMessageId is captured at construction time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const { handleSend, uploadAttachment } = useChatMessageSender({
    chatId,
    storeChatId,
    threadId,
    currentUserId: currentUser.uid,
    currentUserName: currentUser.username,
    currentUserAvatarUrl: currentUser.avatarUrl,
    threadSubscribed,
    replyingTo,
    editingSession,
    messageLookup,
    setReplyingTo,
    setEditingSession,
    revealLatestAfterSend,
    markThreadSubscribedOptimistically,
    showToast,
  });

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

  const handleSelectThread = useCallback(
    (messageId: string) => {
      history.push(`/chats/chat/${chatId}/thread/${messageId}`);
    },
    [chatId, history],
  );

  const handleOpenReactionDetails = useCallback((messageId: string) => {
    setReactionDetail({ messageId });
  }, []);

  const overlayActions = useMessageOverlayActions({
    chatId,
    message: overlayMessage?.message ?? null,
    currentUserId: currentUser.uid,
    isAdmin,
    threadId,
    pins,
    savedMessagesEnabled,
    presentAlert,
    showToast,
    onReply: setReplyingTo,
    onStartThread: handleSelectThread,
    onEdit: startEditingMessage,
    onOpenReactionDetails: handleOpenReactionDetails,
  });

  const handleOpenMembers = useCallback(() => {
    history.push(`/chats/chat/${chatId}/members`);
  }, [chatId, history]);

  const handleOpenGroupInfo = useCallback(() => {
    history.push(`/chats/chat/${chatId}/group-info`);
  }, [chatId, history]);

  const handleRestoreReply = useCallback(
    async (replyToMessageId: string, replyToUsername?: string) => {
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
        // Message hard-deleted — show [Deleted] in reply banner, preserving username.
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
    },
    [chatId, messageLookup],
  );

  const handleCloseOverlay = useCallback(() => {
    deferredOverlayRef.current = null;
    setOverlayMessage(null);
  }, []);

  const renderRow = useCallback(
    (row: ChatRow) => {
      return (
        <ChatMessageRow
          row={row}
          currentUserId={currentUser.uid}
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
    [currentUser.uid, threadId, chatId, history, jumpToMessage, onClickChatItem, handleReactionToggle],
  );

  const chatCtx = useMemo(() => ({ chatId, threadId, jumpToMessage }), [chatId, threadId, jumpToMessage]);

  return (
    <ChatContext.Provider value={chatCtx}>
      <div className="ion-page conversation-page" style={pageStyle}>
        <ConversationHeader
          backAction={backAction}
          chatName={chatName}
          isMuted={isMuted}
          threadId={threadId}
          threadSubscribed={threadSubscribed}
          threadArchived={threadArchived}
          threadSubLoading={threadSubLoading}
          onOpenMembers={handleOpenMembers}
          onOpenGroupInfo={handleOpenGroupInfo}
          onToggleThreadSubscription={handleToggleThreadSubscription}
        />

        {!threadId && (
          <PinBanner
            chatId={chatId}
            bottomVisibleMessageDate={bottomVisibleMessageDate}
            onClickPin={jumpToMessage}
            onClickThread={handleSelectThread}
            onClickCounter={openPinList}
          />
        )}
        <IonContent className="conversation-content" scrollX={false} scrollY={false}>
          <ChatVirtualScroll
            key={storeChatId}
            rows={chatRows}
            renderRow={renderRow}
            initialAnchor={initialAnchor}
            topOverlay={
              floatingDateLabel ? (
                <div
                  className={`conversation-floating-date ${floatingDateFading ? 'conversation-floating-date--fading' : ''}`}
                >
                  <span className="conversation-floating-date__label">{floatingDateLabel}</span>
                </div>
              ) : null
            }
            loadOlder={loadOlder}
            loadNewer={loadNewer}
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
              <span className="scroll-to-bottom-fab__badge">{formatUnreadBadge(pendingJumpCount)}</span>
            )}
            <IonFabButton size="small" onClick={handleScrollToBottomClick}>
              <IonIcon icon={chevronDown} />
            </IonFabButton>
          </IonFab>
        </IonContent>

        <ConversationFooter
          composeBarRef={composeBarRef}
          chatId={chatId}
          draftKey={storeChatId}
          isKeyboardOpen={isKeyboardOpen}
          onRestoreReply={handleRestoreReply}
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
        <ConversationOverlayHost
          chatId={chatId}
          currentUserId={currentUser.uid}
          isAdmin={isAdmin}
          profileSender={profileSender}
          onDismissProfile={() => setProfileSender(null)}
          onProfileSenderChange={setProfileSender}
          reactionDetail={reactionDetail}
          onDismissReactionDetail={() => setReactionDetail(null)}
          stickerPreviewId={stickerPreviewId}
          onDismissStickerPreview={() => setStickerPreviewId(null)}
          pinListOpen={pinListOpen}
          onDismissPinList={closePinList}
          onSelectPin={jumpToMessage}
          onSelectThread={handleSelectThread}
          overlayMessage={overlayMessage}
          overlayActions={overlayActions}
          quickReactionEmojis={quickReactionEmojis}
          onReactionToggle={handleReactionToggle}
          onCloseOverlay={handleCloseOverlay}
        />
      </div>
    </ChatContext.Provider>
  );
}

export function ConversationPage() {
  const { id: chatId, threadId } = useParams<{ id: string; threadId?: string }>();
  const renderKey = threadId ?? chatId;
  const backAction: BackAction = threadId
    ? { type: 'back', defaultHref: `/chats/chat/${chatId}` }
    : { type: 'back', defaultHref: '/chats' };
  return (
    <IonPage>
      <ConversationPane key={renderKey} chatId={chatId} threadId={threadId} backAction={backAction} />
    </IonPage>
  );
}

export default ConversationPane;
