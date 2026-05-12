import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  IonBadge,
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
} from 'ionicons/icons';
import { useHistory } from 'react-router-dom';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { type ChatListEntry, archiveChat, getChats, unarchiveChat } from '@/api/chats';
import { archiveThread, getThreads, unarchiveThread } from '@/api/threads';
import {
  selectAllChats,
  selectArchivedChats,
  selectTotalArchivedUnreadChatCount,
  selectTotalUnreadChatCount,
  setChatArchived,
  setChatLastReadMessageId,
  setChatMutedUntil,
  setChatsList,
  setChatUnreadCount,
} from '@/store/chatsSlice';
import {
  selectActiveThreads,
  selectArchivedThreads,
  selectTotalArchivedUnreadThreadCount,
  selectTotalUnreadThreadCount,
  setThreadSubscriptionStatus,
  setThreadsList,
} from '@/store/threadsSlice';
import { selectEffectiveLocale, selectShowAllTab } from '@/store/settingsSlice';
import { markChatAsUnread, markMessagesAsRead, type MessagePreview, type MessageResponse } from '@/api/messages';
import { syncAppBadgeCount } from '@/utils/badges';
import { getChatDisplayName } from '@/utils/chatDisplay';
import { UserAvatar } from '@/components/UserAvatar';
import { formatMessagePreview, getNotificationPreviewLabels, truncatePreview } from '@/utils/messagePreview';
import { getAllDrafts } from '@/utils/draftSync';
import { onDraftChange } from '@/utils/draftEvents';
import { loadDraft } from '@/hooks/useChatDraft';
import { buildResumeHash } from '@/types/chatThreadNavigation';
import { CHAT_LIST_REFRESH_MIN_DURATION_MS } from '@/constants/chatTiming';
import { type ChatListTab, ChatListSegment } from '@/components/chat/lists/ChatListSegment';
import { ThreadListRow } from '@/components/chat/lists/ThreadListRow';
import type { RootState } from '@/store';
import { compareMessageOrder, isOptimisticMessageId } from '@/store/messageProjection';
import type { StoredThreadListItem } from '@/api/threads';
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

function isChatMuted(chat: ChatListEntry): boolean {
  if (!chat.mutedUntil) return false;
  return new Date(chat.mutedUntil) > new Date();
}

function getMessagePreview(message: MessagePreview | null, locale: string): ReactNode {
  if (!message) return t`No messages yet`;

  const senderName = message.sender?.name || 'User';
  const previewText = formatMessagePreview(message, getNotificationPreviewLabels(locale));

  return (
    <>
      <span className={styles.chatsListPreviewSender}>{senderName}: </span>
      {previewText || t`New message`}
    </>
  );
}

function getLatestConfirmedRootMessageId(
  chat: ChatListEntry,
  windows: RootState['messages']['chats'][string]['windows'] | undefined,
): string | null {
  if (chat.lastMessage && !isOptimisticMessageId(chat.lastMessage.id)) {
    return chat.lastMessage.id;
  }

  let latestConfirmed: MessageResponse | null = null;
  for (const window of windows ?? []) {
    for (const message of window.messages) {
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
  onThreadSelect?: (chatId: string, threadRootId: string) => void;
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
  const dispatch = useDispatch();
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
  const showAllTab = useSelector(selectShowAllTab);
  const messageChats = useSelector((state: RootState) => state.messages.chats);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<ChatListTab>(initialTab ?? (showAllTab ? 'all' : 'groups'));
  const effectiveTab = activeTab === 'all' && !showAllTab ? 'groups' : activeTab;
  const chats = archivedMode ? archivedChats : activeChats;
  const threads = archivedMode ? archivedThreads : activeThreads;

  const updateAppBadge = useCallback(async () => {
    if (!archivedMode) {
      await syncAppBadgeCount();
    }
  }, [archivedMode]);

  const loadLists = useCallback(async () => {
    const [activeChatRes, activeThreadRes, archivedChatRes, archivedThreadRes] = await Promise.all([
      getChats({ archived: false }),
      getThreads({ archived: false }),
      getChats({ archived: true }),
      getThreads({ archived: true }),
    ]);

    dispatch(setChatsList({ chats: activeChatRes.data.chats || [], archived: false }));
    dispatch(
      setThreadsList({
        threads: activeThreadRes.data.threads,
        nextCursor: activeThreadRes.data.nextCursor,
        archived: false,
      }),
    );
    dispatch(setChatsList({ chats: archivedChatRes.data.chats || [], archived: true }));
    dispatch(
      setThreadsList({
        threads: archivedThreadRes.data.threads,
        nextCursor: archivedThreadRes.data.nextCursor,
        archived: true,
      }),
    );
  }, [dispatch]);

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
    const unsubscribe = onDraftChange((draftKey) => {
      loadDraft(draftKey)
        .then((draft) => {
          setDrafts((prev) => {
            if (draft) {
              return { ...prev, [draftKey]: draft.text };
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
      const targetMessageId = getLatestConfirmedRootMessageId(chat, messageChats[chat.id]?.windows);
      if (!targetMessageId) return;

      try {
        const res = await markMessagesAsRead(chat.id, targetMessageId);
        dispatch(setChatLastReadMessageId({ chatId: chat.id, lastReadMessageId: res.data.lastReadMessageId }));
        dispatch(setChatUnreadCount({ chatId: chat.id, unreadCount: res.data.unreadCount }));
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

  const mergedItems = useMemo((): MergedItem[] => {
    const items: MergedItem[] = [];
    for (const chat of chats) {
      items.push({
        type: 'group',
        chat,
        sortTime: chat.lastMessageAt ? new Date(chat.lastMessageAt).getTime() : 0,
      });
    }
    for (const thread of threads) {
      items.push({
        type: 'thread',
        thread,
        sortTime: thread.lastReplyAt ? new Date(thread.lastReplyAt).getTime() : 0,
      });
    }
    items.sort((a, b) => b.sortTime - a.sortTime);
    return items;
  }, [chats, threads]);

  const handleThreadSelect = useCallback(
    (chatId: string, threadRootId: string) => {
      onThreadSelect?.(chatId, threadRootId);
    },
    [onThreadSelect],
  );

  const archivedGroupsVisible = archivedChats.length > 0;
  const archivedThreadsVisible = archivedThreads.length > 0;
  const archivedAllVisible = archivedGroupsVisible || archivedThreadsVisible;

  const openArchived = useCallback(
    (tab: ChatListTab) => {
      if (onOpenArchived) {
        onOpenArchived(tab);
        return;
      }
      history.push(`/chats/archived/${tab}`);
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
              {count > 99 ? '99+' : count}
            </IonBadge>
          ) : null}
        </div>
      </div>
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
              unreadCount: chat.unreadCount,
              lastReadMessageId: chat.lastReadMessageId,
            }) || undefined,
          )
        }
      >
        <span slot="start">
          <UserAvatar
            name={getChatDisplayName(chat.id, chat.name)}
            avatarUrl={chat.avatar}
            size={48}
            className={styles.chatsListAvatar}
          />
        </span>
        <IonLabel className={styles.chatsListLabel}>
          <h3 className={styles.chatsListTitle}>
            <span className={styles.chatsListTitleText}>{getChatDisplayName(chat.id, chat.name)}</span>
            {isChatMuted(chat) ? (
              <IonIcon aria-hidden="true" icon={notificationsOffOutline} className={styles.chatsListMutedIcon} />
            ) : null}
          </h3>
          <p className={styles.chatsListPreview}>
            {chat.id in drafts ? (
              <>
                <span className={styles.chatsListDraftLabel}>{t`Draft: `}</span>
                {truncatePreview(drafts[chat.id])}
              </>
            ) : (
              getMessagePreview(chat.lastMessage, locale)
            )}
          </p>
        </IonLabel>
        <div slot="end" className={styles.chatsListEndSlot}>
          <div className={styles.chatsListTime}>{formatLastActivity(chat.lastMessageAt, locale)}</div>
          <div className={styles.chatsListBadge}>
            {chat.unreadCount > 0 && (
              <IonBadge mode="ios" color={isChatMuted(chat) ? 'medium' : 'primary'}>
                {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
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
        draftText={drafts[threadDraftKey]}
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
            {threads.length === 0 ? (
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

      if (threads.length === 0) {
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

    if (effectiveTab === 'groups') {
      if (chats.length === 0 && (!archivedGroupsVisible || archivedMode)) {
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
          {!archivedMode && archivedGroupsVisible ? renderArchivedEntry(archivedUnreadChats) : null}
          {chats.map(renderChatItem)}
        </IonList>
      );
    }

    if (mergedItems.length === 0 && (!archivedAllVisible || archivedMode)) {
      return (
        <IonList>
          <IonItem>
            <IonLabel>{archivedMode ? <Trans>No archived conversations</Trans> : <Trans>No chats yet</Trans>}</IonLabel>
          </IonItem>
        </IonList>
      );
    }

    return (
      <IonList>
        {!archivedMode && archivedAllVisible ? renderArchivedEntry(archivedUnreadChats + archivedUnreadThreads) : null}
        {mergedItems.map((item) => {
          if (item.type === 'group') {
            return renderChatItem(item.chat);
          }
          return renderThreadItem(item.thread);
        })}
      </IonList>
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
        allUnreadCount={
          (archivedMode ? archivedUnreadChats : unreadChats) + (archivedMode ? archivedUnreadThreads : unreadThreads)
        }
        groupsUnreadCount={archivedMode ? archivedUnreadChats : unreadChats}
        threadsUnreadCount={archivedMode ? archivedUnreadThreads : unreadThreads}
        showAllTab={showAllTab}
      />
      {renderContent()}
    </IonContent>
  );
}
