import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import { chatbubbleOutline } from 'ionicons/icons';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { getChats, type ChatListEntry } from '@/api/chats';
import { UserAvatar } from '@/components/UserAvatar';
import { OverlayAvatar } from '@/components/OverlayAvatar';
import { getChatDisplayName } from '@/utils/chatDisplay';
import { forwardMessage, type MessageResponse } from '@/api/messages';
import { getThreads, type ThreadListItem } from '@/api/threads';
import { useIsDesktop } from '@/hooks/platformHooks';
import styles from './ForwardMessageModal.module.scss';

interface ForwardMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  message: MessageResponse;
  sourceChatId: string;
}

type UnifiedItem =
  | { type: 'group'; item: ChatListEntry; sortTime: number }
  | { type: 'thread'; item: ThreadListItem; sortTime: number };

export function ForwardMessageModal({ isOpen, onClose, message, sourceChatId }: ForwardMessageModalProps) {
  const [presentToast] = useIonToast();
  const [forwarding, setForwarding] = useState(false);
  const [chats, setChats] = useState<ChatListEntry[]>([]);
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const isDesktop = useIsDesktop();

  const showToast = useCallback(
    (msg: string, duration = 3000) => {
      presentToast({ message: msg, duration, position: 'bottom', cssClass: 'toast-center' });
    },
    [presentToast],
  );

  // Fetch non-archived chats and subscribed threads when modal opens.
  useEffect(() => {
    if (!isOpen) {
      setChats([]);
      setThreads([]);
      setSearchText('');
      return;
    }

    let cancelled = false;
    setLoading(true);

    Promise.all([getChats({ archived: false }), getThreads({ limit: 50, archived: false })])
      .then(([chatRes, threadRes]) => {
        if (!cancelled) {
          setChats(chatRes.data.chats);
          setThreads(threadRes.data.threads);
        }
      })
      .catch((err) => {
        console.warn('Failed to load chats for forward modal', err);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Merge chats and threads into a single sorted list.
  const mergedItems = useMemo((): UnifiedItem[] => {
    const items: UnifiedItem[] = [];

    for (const chat of chats) {
      items.push({
        type: 'group',
        item: chat,
        sortTime: chat.lastMessageAt ? new Date(chat.lastMessageAt).getTime() : 0,
      });
    }

    for (const thread of threads) {
      items.push({
        type: 'thread',
        item: thread,
        sortTime: thread.lastReplyAt ? new Date(thread.lastReplyAt).getTime() : 0,
      });
    }

    // Sort all items by most recent activity.
    items.sort((a, b) => b.sortTime - a.sortTime);

    return items;
  }, [chats, threads]);

  // Filter by search text.
  const filteredItems = useMemo(() => {
    if (!searchText.trim()) return mergedItems;
    const q = searchText.toLowerCase();

    return mergedItems.filter((item) => {
      if (item.type === 'group') {
        return (item.item.name ?? '').toLowerCase().includes(q);
      }
      return (
        item.item.chatName.toLowerCase().includes(q) ||
        (item.item.threadRootMessage.message ?? '').toLowerCase().includes(q)
      );
    });
  }, [mergedItems, searchText]);

  const handleSelect = useCallback(
    async (chatId: string, threadId?: string) => {
      if (forwarding) return;
      setForwarding(true);
      try {
        await forwardMessage(chatId, message.id, {
          sourceChatId,
          clientGeneratedId: `cg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          ...(threadId !== undefined ? { threadId } : {}),
        });
        showToast(t`Message forwarded`, 2000);
        onClose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : t`Failed to forward message`;
        showToast(msg);
      } finally {
        setForwarding(false);
      }
    },
    [forwarding, message.id, onClose, showToast, sourceChatId],
  );

  return (
    <IonModal
      isOpen={isOpen}
      onDidDismiss={onClose}
      {...(!isDesktop ? { initialBreakpoint: 0.5, breakpoints: [0, 0.5, 0.9] } : {})}
    >
      <IonHeader>
        <IonToolbar>
          <IonTitle>
            <Trans>Forward to</Trans>
          </IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onClose}>{t`Cancel`}</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light">
        <IonSearchbar
          placeholder={t`Search chats`}
          value={searchText}
          onIonInput={(e) => setSearchText(e.detail.value ?? '')}
          debounce={200}
        />

        {loading ? (
          <div className={styles.spinnerContainer}>
            <IonSpinner />
          </div>
        ) : filteredItems.length === 0 ? (
          <IonList>
            <IonItem>
              <IonLabel>
                <Trans>No chats available</Trans>
              </IonLabel>
            </IonItem>
          </IonList>
        ) : (
          <IonList>
            {filteredItems.map((unified) => {
              if (unified.type === 'group') {
                const chat = unified.item;
                return (
                  <IonItem key={`group-${chat.id}`} button disabled={forwarding} onClick={() => handleSelect(chat.id)}>
                    <span slot="start">
                      <UserAvatar name={getChatDisplayName(chat.id, chat.name)} avatarUrl={chat.avatar} size={40} />
                    </span>
                    <IonLabel>
                      <h3>{getChatDisplayName(chat.id, chat.name)}</h3>
                    </IonLabel>
                  </IonItem>
                );
              }

              const thread = unified.item;
              return (
                <IonItem
                  key={`thread-${thread.threadRootMessage.id}`}
                  button
                  disabled={forwarding}
                  onClick={() => handleSelect(thread.chatId, thread.threadRootMessage.id)}
                >
                  <span slot="start">
                    <OverlayAvatar
                      primaryName={thread.chatName}
                      primaryAvatarUrl={thread.chatAvatar}
                      secondaryName={thread.threadRootMessage.sender.name ?? null}
                      secondaryAvatarUrl={thread.threadRootMessage.sender.avatarUrl ?? null}
                      size={40}
                    />
                  </span>
                  <IonLabel>
                    <h3>{thread.chatName}</h3>
                    <p>{thread.threadRootMessage.message?.slice(0, 60) ?? t`Sticker`}</p>
                    <p className={styles.threadReplyCount}>
                      <IonIcon icon={chatbubbleOutline} className={styles.threadReplyIcon} />
                      {t`${thread.replyCount} replies`}
                    </p>
                  </IonLabel>
                </IonItem>
              );
            })}
          </IonList>
        )}
      </IonContent>
    </IonModal>
  );
}
