import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IonBadge,
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  type RefresherEventDetail,
} from '@ionic/react';
import { useDispatch, useSelector } from 'react-redux';
import {
  archiveOutline,
  arrowUndoOutline,
  checkmarkDone,
  folderOpenOutline,
  mailUnreadOutline,
  notificationsOffOutline,
  personAddOutline,
} from 'ionicons/icons';
import { useHistory } from 'react-router-dom';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { isFeatureEnabled } from '@/features';
import { MentionBadge } from './MentionBadge';
import { type ChatListEntry, archiveChat, unarchiveChat } from '@/api/chats';
import { archiveThread, unarchiveThread } from '@/api/threads';
import { formatUnreadBadge } from '@/utils/unreadBadge';
import {
  selectAllChats,
  selectArchivedChats,
  selectArchivedChatsWithUnreadCount,
  selectChatsLoading,
  selectChatsNextCursor,
  selectChatsWithUnreadCount,
  selectTotalArchivedUnreadChatCount,
  selectTotalUnreadChatCount,
  setChatArchived,
  setChatLastReadMessageId,
  setChatMutedUntil,
  setChatUnreadCount,
  setChatUnreadMentions,
} from '@/store/chatsSlice';
import {
  selectActiveThreads,
  selectArchivedThreadsWithUnreadCount,
  selectArchivedThreads,
  selectThreadsLoading,
  selectThreadsNextCursor,
  selectThreadsWithUnreadCount,
  selectTotalArchivedUnreadThreadCount,
  selectTotalUnreadThreadCount,
  setThreadSubscriptionStatus,
} from '@/store/threadsSlice';
import {
  selectEffectiveLocale,
  selectChatListTab,
  selectShowThreadsInMessages,
  setChatListTab,
} from '@/store/settingsSlice';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { fetchPendingRequests } from '@/store/socialSlice';
import { loadMoreChatList, loadMoreThreadList, refreshChatList, refreshThreadList } from '@/store/listPagination';
import { markChatAsUnread, markMessagesAsRead, type MessagePreview, type MessageResponse } from '@/api/messages';
import { syncAppBadgeCount } from '@/utils/badges';
import { getChatDisplayName } from '@/utils/chatDisplay';
import { UserAvatar } from '@/components/UserAvatar';
import { formatMessagePreview, getNotificationPreviewLabels, truncatePreview } from '@/utils/messagePreview';
import { getAllDrafts } from '@/utils/draftSync';
import { onDraftChange } from '@/utils/draftEvents';
import type { AppDispatch, RootState } from '@/store';
import { loadDraft } from '@/hooks/useChatDraft';
import { buildResumeHash } from '@/types/conversationNavigation';
import { CHAT_LIST_REFRESH_MIN_DURATION_MS } from '@/constants/chatTiming';
import { ChatListSegment } from '@/components/chat/lists/ChatListSegment';
import { ARCHIVED_FRIEND_REQUESTS_PATH, type ChatListTab } from '@/components/chat/lists/chatListTabs';
import { hasUnreadTabBadge, isChatMuted } from '@/components/chat/lists/chatListBadges';
import { ThreadListRow } from '@/components/chat/lists/ThreadListRow';
import { compareMessageOrder, isOptimisticMessageId } from '@/store/messageProjection';
import type { ChatTimelineState } from '@/store/messages/types';
import type { StoredThreadListItem } from '@/api/threads';
import { PendingFriendRequests } from '@/components/social/PendingFriendRequests';
import styles from './ChatList.module.scss';

const INDEFINITE_MUTE_UNTIL = '9999-12-31T23:59:59Z';

function formatLastActivity(isoString: string | null, locale: string): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();

  const isSameDay =
    date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();

  if (isSameDay) {
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });

    if (diffMins < 60) {
      return rtf.format(-Math.max(1, diffMins), 'minute');
    }

    return rtf.format(-Math.floor(diffMins / 60), 'hour');
  }

  if (date.getFullYear() === now.getFullYear()) {
    return Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  }

  return Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function getMessagePreview(message: MessagePreview | null, locale: string, showSender: boolean): ReactNode {
  if (!message) return t`No messages yet`;

  const previewText = formatMessagePreview(message, getNotificationPreviewLabels(locale));

  // DM rows omit the sender name — the row title already names the peer.
  if (!showSender) {
    return previewText || t`New message`;
  }

  const senderName = message.sender?.name || 'User';

  return (
    <>
      <span className={styles.chatsListPreviewSender}>{senderName}: </span>
      {previewText || t`New message`}
    </>
  );
}

function getLatestConfirmedRootMessageId(chat: ChatListEntry, timeline: ChatTimelineState | undefined): string | null {
  if (chat.lastMessage && !isOptimisticMessageId(chat.lastMessage.id)) {
    return chat.lastMessage.id;
  }

  let latestConfirmed: MessageResponse | null = null;
  for (const segment of timeline?.segments ?? []) {
    for (const message of segment.messages) {
      if (message.replyRootId != null || message.isDeleted || isOptimisticMessageId(message.id)) continue;
      if (!latestConfirmed || compareMessageOrder(message, latestConfirmed) > 0) {
        latestConfirmed = message;
      }
    }
  }

  return latestConfirmed?.id ?? null;
}

type MergedItem =
  | { type: 'group'; chat: ChatListEntry; sortTime: number }
  | { type: 'thread'; thread: StoredThreadListItem; sortTime: number };

interface ChatListProps {
  activeChatId?: string;
  activeThreadId?: string;
  archivedMode?: boolean;
  initialTab?: ChatListTab;
  onOpenArchived?: (tab: ChatListTab) => void;
  onChatSelect: (chatId: string, resumeHash?: string) => void;
  onThreadSelect?: (chatId: string, threadRootId: string, resumeHash?: string) => void;
}

export function ChatList({
  activeChatId,
  activeThreadId,
  archivedMode = false,
  initialTab,
  onOpenArchived,
  onChatSelect,
  onThreadSelect,
}: ChatListProps) {
  const dispatch = useDispatch<AppDispatch>();
  const history = useHistory();
  const locale = useSelector(selectEffectiveLocale);
  const activeChats = useSelector(selectAllChats);
  const archivedChats = useSelector(selectArchivedChats);
  const activeThreads = useSelector(selectActiveThreads);
  const archivedThreads = useSelector(selectArchivedThreads);
  const unreadChats = useSelector(selectTotalUnreadChatCount);
  const archivedUnreadChats = useSelector(selectTotalArchivedUnreadChatCount);
  const unreadThreads = useSelector(selectTotalUnreadThreadCount);
  const archivedUnreadThreads = useSelector(selectTotalArchivedUnreadThreadCount);
  const chatsWithUnread = useSelector(selectChatsWithUnreadCount);
  const archivedChatsWithUnread = useSelector(selectArchivedChatsWithUnreadCount);
  const threadsWithUnread = useSelector(selectThreadsWithUnreadCount);
  const archivedThreadsWithUnread = useSelector(selectArchivedThreadsWithUnreadCount);
  const showThreadsInMessages = useSelector(selectShowThreadsInMessages);
  const friendsEnabled = useFeatureGate('friends');
  const globalTab = useSelector(selectChatListTab);
  const messageChats = useSelector((state: RootState) => state.messages.chats);
  const chatsNextCursor = useSelector((state: RootState) => selectChatsNextCursor(state, archivedMode));
  const archivedChatsNextCursor = useSelector((state: RootState) => selectChatsNextCursor(state, true));
  const threadsNextCursor = useSelector((state: RootState) => selectThreadsNextCursor(state, archivedMode));
  const archivedThreadsNextCursor = useSelector((state: RootState) => selectThreadsNextCursor(state, true));
  const chatsLoading = useSelector((state: RootState) => selectChatsLoading(state, archivedMode));
  const threadsLoading = useSelector((state: RootState) => selectThreadsLoading(state, archivedMode));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { text: string; savedAt: number }>>({});
  const [loadMoreFailure, setLoadMoreFailure] = useState<{ key: string; message: string } | null>(null);
  // /chats uses the persisted tab; direct and archived routes use a local tab.
  const [localTab, setLocalTab] = useState<ChatListTab>(initialTab ?? 'messages');
  const activeTab = initialTab != null ? localTab : globalTab;
  const setActiveTab = useCallback(
    (tab: ChatListTab) => {
      setLoadMoreFailure(null);
      if (initialTab != null) {
        setLocalTab(tab);
      } else {
        dispatch(setChatListTab(tab));
      }
    },
    [dispatch, initialTab],
  );
  const effectiveTab = activeTab === 'friends' && !friendsEnabled ? 'messages' : activeTab;
  const paginationKey = `${archivedMode}:${effectiveTab}:${showThreadsInMessages}`;
  const loadMoreError = loadMoreFailure?.key === paginationKey ? loadMoreFailure.message : null;
  const paginationKeyRef = useRef(paginationKey);
  const chats = archivedMode ? archivedChats : activeChats;
  const threads = archivedMode ? archivedThreads : activeThreads;
  const groupChats = useMemo(() => chats.filter((c) => c.kind !== 'dm'), [chats]);
  const friendChats = useMemo(() => chats.filter((c) => c.kind === 'dm'), [chats]);
  // Muted chats keep their grey inline badge but don't light up the blue
  // category tab badge; archived lists keep counting muted unreads.
  const countsTowardTabBadge = useCallback(
    (chat: ChatListEntry) => hasUnreadTabBadge(chat, { includeMuted: archivedMode }),
    [archivedMode],
  );
  const groupChatsWithUnread = groupChats.filter(countsTowardTabBadge).length;
  const friendChatsWithUnread = friendChats.filter(countsTowardTabBadge).length;

  const updateAppBadge = useCallback(async () => {
    if (!archivedMode) {
      await syncAppBadgeCount();
    }
  }, [archivedMode]);

  const loadLists = useCallback(
    () =>
      Promise.all([
        dispatch(refreshChatList(false)),
        dispatch(refreshThreadList(false)),
        dispatch(refreshChatList(true)),
        dispatch(refreshThreadList(true)),
        dispatch(fetchPendingRequests()).unwrap(),
      ]).then(() => {}),
    [dispatch],
  );

  useEffect(() => {
    loadLists()
      .then(() => setError(null))
      .catch((err: Error) => setError(err.message || t`Failed to load chats`))
      .finally(() => setLoading(false));
    void updateAppBadge();

    getAllDrafts()
      .then((draftsMap) => setDrafts(draftsMap))
      .catch(() => {});
  }, [loadLists, updateAppBadge]);

  useEffect(() => {
    void updateAppBadge();
  }, [unreadChats, unreadThreads, updateAppBadge]);

  useEffect(() => {
    paginationKeyRef.current = paginationKey;
  }, [paginationKey]);

  useEffect(() => {
    const unsubscribe = onDraftChange((draftKey) => {
      loadDraft(draftKey)
        .then((draft) => {
          setDrafts((prev) => {
            if (draft) {
              return { ...prev, [draftKey]: { text: draft.text, savedAt: draft.savedAt ?? 0 } };
            }
            // Draft was cleared — remove from map
            const next = { ...prev };
            delete next[draftKey];
            return next;
          });
        })
        .catch(() => {});
    });

    return unsubscribe;
  }, []);

  const handleToggleRead = async (chat: ChatListEntry, slidingItem: HTMLIonItemSlidingElement | null) => {
    slidingItem?.close();

    if (chat.unreadCount > 0) {
      const targetMessageId = getLatestConfirmedRootMessageId(chat, messageChats[chat.id]);
      if (!targetMessageId) return;

      try {
        const res = await markMessagesAsRead(chat.id, targetMessageId);
        dispatch(setChatLastReadMessageId({ chatId: chat.id, lastReadMessageId: res.data.lastReadMessageId }));
        dispatch(setChatUnreadCount({ chatId: chat.id, unreadCount: res.data.unreadCount }));
        dispatch(setChatUnreadMentions({ chatId: chat.id, unreadMentions: res.data.unreadMentions ?? 0 }));
        await updateAppBadge();
      } catch (err) {
        console.error('Failed to mark as read', err);
      }
      return;
    }

    if (!chat.lastMessage) return;

    try {
      dispatch(setChatUnreadCount({ chatId: chat.id, unreadCount: 1 }));
      const res = await markChatAsUnread(chat.id);
      dispatch(setChatLastReadMessageId({ chatId: chat.id, lastReadMessageId: res.data.lastReadMessageId }));
      dispatch(setChatUnreadCount({ chatId: chat.id, unreadCount: res.data.unreadCount }));
      dispatch(setChatUnreadMentions({ chatId: chat.id, unreadMentions: res.data.unreadMentions ?? 0 }));
      await updateAppBadge();
    } catch (err) {
      console.error('Failed to mark as unread', err);
    }
  };

  const handleArchiveChat = useCallback(
    async (chat: ChatListEntry, archived: boolean, slidingItem: HTMLIonItemSlidingElement | null) => {
      slidingItem?.close();
      try {
        if (archived) {
          await unarchiveChat(chat.id);
          dispatch(setChatArchived({ chatId: chat.id, archived: false }));
          dispatch(setChatMutedUntil({ chatId: chat.id, mutedUntil: null }));
        } else {
          await archiveChat(chat.id);
          dispatch(setChatArchived({ chatId: chat.id, archived: true }));
          dispatch(setChatMutedUntil({ chatId: chat.id, mutedUntil: INDEFINITE_MUTE_UNTIL }));
        }
        await updateAppBadge();
      } catch (err) {
        console.error('Failed to toggle chat archive state', err);
      }
    },
    [dispatch, updateAppBadge],
  );

  const handleArchiveThread = useCallback(
    async (thread: StoredThreadListItem, archived: boolean) => {
      try {
        if (archived) {
          await unarchiveThread(thread.chatId, thread.threadRootMessage.id);
        } else {
          await archiveThread(thread.chatId, thread.threadRootMessage.id);
        }
        dispatch(
          setThreadSubscriptionStatus({
            threadRootId: thread.threadRootMessage.id,
            subscribed: true,
            archived: !archived,
          }),
        );
      } catch (err) {
        console.error('Failed to toggle thread archive state', err);
      }
    },
    [dispatch],
  );

  const handleRefresh = (event: CustomEvent<RefresherEventDetail>) => {
    const startTime = Date.now();

    loadLists()
      .then(() => setError(null))
      .catch((err: Error) => {
        setError(err.message || t`Failed to refresh chats`);
      })
      .finally(() => {
        const elapsed = Date.now() - startTime;
        const delay = Math.max(0, CHAT_LIST_REFRESH_MIN_DURATION_MS - elapsed);
        setTimeout(() => {
          event.detail.complete();
        }, delay);
      });

    // Refresh drafts independently
    getAllDrafts()
      .then((draftsMap) => setDrafts(draftsMap))
      .catch(() => {});

    void updateAppBadge();
  };
  const loadsChats = effectiveTab !== 'threads';
  const loadsThreads = effectiveTab === 'threads' || (effectiveTab === 'messages' && showThreadsInMessages);
  const hasMoreChats = chatsNextCursor !== null;
  const hasMoreThreads = threadsNextCursor !== null;
  const hasMoreRelevant = (loadsChats && hasMoreChats) || (loadsThreads && hasMoreThreads);
  const loadingMore = (loadsChats && chatsLoading) || (loadsThreads && threadsLoading);

  const handleLoadMore = useCallback(async () => {
    const requestKey = paginationKey;
    setLoadMoreFailure(null);

    try {
      await Promise.all([
        ...(loadsChats && hasMoreChats ? [dispatch(loadMoreChatList(archivedMode))] : []),
        ...(loadsThreads && hasMoreThreads ? [dispatch(loadMoreThreadList(archivedMode))] : []),
      ]);
    } catch (err) {
      if (paginationKeyRef.current === requestKey) {
        setLoadMoreFailure({
          key: requestKey,
          message: err instanceof Error ? err.message || t`Failed to load chats` : t`Failed to load chats`,
        });
      }
    }
  }, [archivedMode, dispatch, hasMoreChats, hasMoreThreads, loadsChats, loadsThreads, paginationKey, paginationKeyRef]);

  const mergedItems = useMemo((): MergedItem[] => {
    const items: MergedItem[] = [];
    for (const chat of chats) {
      items.push({
        type: 'group',
        chat,
        sortTime: Math.max(
          chat.lastMessageAt ? new Date(chat.lastMessageAt).getTime() : 0,
          drafts[chat.id]?.savedAt ?? 0,
        ),
      });
    }
    if (showThreadsInMessages) {
      for (const thread of threads) {
        items.push({
          type: 'thread',
          thread,
          sortTime: Math.max(
            thread.lastReplyAt ? new Date(thread.lastReplyAt).getTime() : 0,
            drafts[`${thread.chatId}_thread_${thread.threadRootMessage.id}`]?.savedAt ?? 0,
          ),
        });
      }
    }
    items.sort((a, b) => b.sortTime - a.sortTime);
    return items;
  }, [chats, threads, drafts, showThreadsInMessages]);

  // Chats shown by the Groups/Friends filter tabs; Messages merges chats and,
  // when enabled, threads via mergedItems instead.
  const tabListChats = effectiveTab === 'friends' ? friendChats : groupChats;
  const sortedChats = useMemo(() => {
    if (Object.keys(drafts).length === 0) return tabListChats;
    return [...tabListChats].sort((a, b) => {
      const aTime = Math.max(a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0, drafts[a.id]?.savedAt ?? 0);
      const bTime = Math.max(b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0, drafts[b.id]?.savedAt ?? 0);
      return bTime - aTime;
    });
  }, [tabListChats, drafts]);

  const handleThreadSelect = useCallback(
    (chatId: string, threadRootId: string, thread: StoredThreadListItem) => {
      const resumeHash = buildResumeHash({
        lastReadMessageId: thread.lastReadMessageId,
      });
      onThreadSelect?.(chatId, threadRootId, resumeHash || undefined);
    },
    [onThreadSelect],
  );

  const archivedGroupChats = useMemo(() => archivedChats.filter((c) => c.kind !== 'dm'), [archivedChats]);
  const archivedFriendChats = useMemo(() => archivedChats.filter((c) => c.kind === 'dm'), [archivedChats]);
  const archivedGroupsVisible = archivedGroupChats.length > 0 || archivedChatsNextCursor !== null;
  const archivedFriendsVisible = archivedFriendChats.length > 0 || archivedChatsNextCursor !== null;
  const archivedGroupsUnread = archivedGroupChats.filter((c) => (c.unreadCount ?? 0) > 0).length;
  const archivedFriendsUnread = archivedFriendChats.filter((c) => (c.unreadCount ?? 0) > 0).length;
  const archivedThreadsVisible = archivedThreads.length > 0 || archivedThreadsNextCursor !== null;
  const archivedMessagesVisible =
    archivedChats.length > 0 || archivedChatsNextCursor !== null || (showThreadsInMessages && archivedThreadsVisible);

  const openArchived = useCallback(
    (tab: ChatListTab) => {
      if (onOpenArchived) {
        onOpenArchived(tab);
        return;
      }
      history.push(`/chats/${tab}/archived`);
    },
    [history, onOpenArchived],
  );

  const renderArchivedEntry = (count: number) => (
    <IonItem button detail={false} className={styles.chatListItem} onClick={() => openArchived(effectiveTab)}>
      <span slot="start" className={styles.threadsRowIcon}>
        <IonIcon icon={folderOpenOutline} />
      </span>
      <IonLabel className={styles.chatsListLabel}>
        <h3 className={styles.chatsListTitle}>
          <span className={styles.chatsListTitleText}>
            <Trans>Archived</Trans>
          </span>
        </h3>
        <p className={styles.chatsListPreview}>
          <Trans>View archived chats and threads</Trans>
        </p>
      </IonLabel>
      <div slot="end" className={styles.chatsListEndSlot}>
        <div className={styles.chatsListTime} />
        <div className={styles.chatsListBadge}>
          {count > 0 ? (
            <IonBadge mode="ios" color="medium">
              {formatUnreadBadge(count)}
            </IonBadge>
          ) : null}
        </div>
      </div>
    </IonItem>
  );

  const renderFriendRequestsEntry = () => (
    <IonItem
      button
      detail={false}
      className={styles.chatListItem}
      onClick={() => history.push(ARCHIVED_FRIEND_REQUESTS_PATH)}
    >
      <span slot="start" className={styles.threadsRowIcon}>
        <IonIcon icon={personAddOutline} />
      </span>
      <IonLabel className={styles.chatsListLabel}>
        <h3 className={styles.chatsListTitle}>
          <span className={styles.chatsListTitleText}>
            <Trans>Friend Requests</Trans>
          </span>
        </h3>
        <p className={styles.chatsListPreview}>
          <Trans>View archived friend requests</Trans>
        </p>
      </IonLabel>
    </IonItem>
  );

  const renderChatItem = (chat: ChatListEntry) => (
    <IonItemSliding key={chat.id}>
      <IonItemOptions
        side="start"
        onIonSwipe={(e) => {
          const slidingItem = (e.target as HTMLElement).closest('ion-item-sliding');
          handleToggleRead(chat, slidingItem as HTMLIonItemSlidingElement | null);
        }}
      >
        <IonItemOption
          color="primary"
          expandable
          onClick={(e) => {
            const slidingItem = (e.target as HTMLElement).closest('ion-item-sliding');
            handleToggleRead(chat, slidingItem as HTMLIonItemSlidingElement | null);
          }}
        >
          <IonIcon slot="top" icon={chat.unreadCount > 0 ? checkmarkDone : mailUnreadOutline} />
          {chat.unreadCount > 0 ? <Trans>Read</Trans> : <Trans>Unread</Trans>}
        </IonItemOption>
      </IonItemOptions>
      <IonItemOptions side="end">
        <IonItemOption
          color={archivedMode ? 'success' : 'medium'}
          expandable
          onClick={(e) => {
            const slidingItem = (e.target as HTMLElement).closest('ion-item-sliding');
            void handleArchiveChat(chat, archivedMode, slidingItem as HTMLIonItemSlidingElement | null);
          }}
        >
          <IonIcon slot="top" icon={archivedMode ? arrowUndoOutline : archiveOutline} />
          {archivedMode ? <Trans>Unarchive</Trans> : <Trans>Archive</Trans>}
        </IonItemOption>
      </IonItemOptions>
      <IonItem
        id={chat.id}
        button
        detail={false}
        className={`${styles.chatListItem} ${activeChatId === chat.id && !activeThreadId ? styles.active : ''}`}
        onClick={() =>
          onChatSelect(
            chat.id,
            buildResumeHash({
              lastReadMessageId: chat.lastReadMessageId,
            }) || undefined,
          )
        }
      >
        <span slot="start">
          <UserAvatar
            name={getChatDisplayName(chat.id, chat.name, chat.peer)}
            avatarUrl={chat.kind === 'dm' ? (chat.peer?.avatarUrl ?? null) : chat.avatar}
            size={48}
            className={styles.chatsListAvatar}
          />
        </span>
        <IonLabel className={styles.chatsListLabel}>
          <h3 className={styles.chatsListTitle}>
            <span className={styles.chatsListTitleText}>{getChatDisplayName(chat.id, chat.name, chat.peer)}</span>
            {isChatMuted(chat) ? (
              <IonIcon aria-hidden="true" icon={notificationsOffOutline} className={styles.chatsListMutedIcon} />
            ) : null}
          </h3>
          <p className={styles.chatsListPreview}>
            {chat.id in drafts ? (
              <>
                <span className={styles.chatsListDraftLabel}>{t`Draft: `}</span>
                {truncatePreview(drafts[chat.id].text)}
              </>
            ) : (
              getMessagePreview(chat.lastMessage, locale, chat.kind !== 'dm')
            )}
          </p>
        </IonLabel>
        <div slot="end" className={styles.chatsListEndSlot}>
          <div className={styles.chatsListTime}>{formatLastActivity(chat.lastMessageAt, locale)}</div>
          <div className={styles.chatsListBadge}>
            {isFeatureEnabled('mentionNotifications') && chat.unreadMentions > 0 && (
              <MentionBadge muted={isChatMuted(chat)} />
            )}
            {chat.unreadCount > 0 && (
              <IonBadge mode="ios" color={isChatMuted(chat) ? 'medium' : 'primary'}>
                {formatUnreadBadge(chat.unreadCount)}
              </IonBadge>
            )}
          </div>
        </div>
      </IonItem>
    </IonItemSliding>
  );

  const renderThreadItem = (thread: StoredThreadListItem) => {
    const threadDraftKey = `${thread.chatId}_thread_${thread.threadRootMessage.id}`;
    return (
      <ThreadListRow
        key={`thread-${thread.threadRootMessage.id}`}
        thread={thread}
        locale={locale}
        isActive={activeThreadId === thread.threadRootMessage.id}
        onSelect={handleThreadSelect}
        draftText={drafts[threadDraftKey]?.text}
        endAction={{
          color: archivedMode ? 'success' : 'medium',
          icon: archivedMode ? arrowUndoOutline : archiveOutline,
          label: archivedMode ? t`Unarchive` : t`Archive`,
          onAction: () => {
            void handleArchiveThread(thread, archivedMode);
          },
        }}
      />
    );
  };

  const renderContent = () => {
    if (error) {
      return (
        <IonList>
          <IonItem>
            <IonLabel>
              <h3>
                <Trans>Error</Trans>
              </h3>
              <p>{error}</p>
            </IonLabel>
          </IonItem>
        </IonList>
      );
    }

    if (loading) {
      return (
        <IonList>
          <IonItem>
            <IonLabel>
              <Trans>Loading…</Trans>
            </IonLabel>
          </IonItem>
        </IonList>
      );
    }

    if (effectiveTab === 'threads') {
      if (!archivedMode && archivedThreadsVisible) {
        return (
          <IonList>
            {renderArchivedEntry(archivedUnreadThreads)}
            {threads.length === 0 && !hasMoreThreads ? (
              <IonItem>
                <IonLabel>
                  <Trans>No threads yet</Trans>
                </IonLabel>
              </IonItem>
            ) : (
              threads.map(renderThreadItem)
            )}
          </IonList>
        );
      }

      if (threads.length === 0 && !hasMoreThreads) {
        return (
          <IonList>
            <IonItem>
              <IonLabel>{archivedMode ? <Trans>No archived threads</Trans> : <Trans>No threads yet</Trans>}</IonLabel>
            </IonItem>
          </IonList>
        );
      }

      return <IonList>{threads.map(renderThreadItem)}</IonList>;
    }

    if (effectiveTab === 'friends') {
      const archivedEntry = !archivedMode && archivedFriendsVisible ? renderArchivedEntry(archivedFriendsUnread) : null;

      return (
        <IonList>
          {!archivedMode && renderFriendRequestsEntry()}
          {archivedEntry}
          {!archivedMode && <PendingFriendRequests />}
          {sortedChats.length === 0 && !hasMoreChats ? (
            <IonItem lines="none">
              <IonLabel color="medium" className="ion-text-wrap">
                {archivedMode ? <Trans>No archived chats</Trans> : <Trans>No friend chats yet</Trans>}
              </IonLabel>
            </IonItem>
          ) : (
            sortedChats.map(renderChatItem)
          )}
        </IonList>
      );
    }

    if (effectiveTab === 'groups') {
      if (groupChats.length === 0 && !hasMoreChats && (!archivedGroupsVisible || archivedMode)) {
        return (
          <IonList>
            <IonItem>
              <IonLabel>{archivedMode ? <Trans>No archived chats</Trans> : <Trans>No chats yet</Trans>}</IonLabel>
            </IonItem>
          </IonList>
        );
      }

      return (
        <IonList>
          {!archivedMode && archivedGroupsVisible ? renderArchivedEntry(archivedGroupsUnread) : null}
          {sortedChats.map(renderChatItem)}
        </IonList>
      );
    }

    const showEmptyMessages =
      mergedItems.length === 0 && !hasMoreRelevant && (!archivedMessagesVisible || archivedMode);

    return (
      <IonList>
        {!archivedMode && friendsEnabled && <PendingFriendRequests />}
        {!archivedMode && archivedMessagesVisible
          ? renderArchivedEntry(archivedUnreadChats + (showThreadsInMessages ? archivedUnreadThreads : 0))
          : null}
        {showEmptyMessages ? (
          <IonItem>
            <IonLabel>{archivedMode ? <Trans>No archived conversations</Trans> : <Trans>No chats yet</Trans>}</IonLabel>
          </IonItem>
        ) : (
          mergedItems.map((item) => {
            if (item.type === 'group') {
              return renderChatItem(item.chat);
            }
            return renderThreadItem(item.thread);
          })
        )}
      </IonList>
    );
  };

  const renderLoadMore = () => {
    if (error || loading || !hasMoreRelevant) return null;

    return (
      <div className={styles.loadMore}>
        {loadMoreError ? (
          <p className={styles.loadMoreError} role="alert">
            {loadMoreError}
          </p>
        ) : null}
        <IonButton expand="block" fill="clear" disabled={loadingMore} onClick={handleLoadMore}>
          {loadingMore ? <IonSpinner name="crescent" /> : <Trans>Load More</Trans>}
        </IonButton>
      </div>
    );
  };

  return (
    <IonContent fullscreen>
      <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
        <IonRefresherContent />
      </IonRefresher>
      <ChatListSegment
        value={effectiveTab}
        onChange={setActiveTab}
        messagesUnreadCount={
          (archivedMode ? archivedChatsWithUnread : chatsWithUnread) +
          (showThreadsInMessages ? (archivedMode ? archivedThreadsWithUnread : threadsWithUnread) : 0)
        }
        groupsUnreadCount={groupChatsWithUnread}
        friendsUnreadCount={friendChatsWithUnread}
        threadsUnreadCount={archivedMode ? archivedThreadsWithUnread : threadsWithUnread}
        archivedMode={archivedMode}
        friendsEnabled={friendsEnabled}
      />
      {renderContent()}
      {renderLoadMore()}
    </IonContent>
  );
}
