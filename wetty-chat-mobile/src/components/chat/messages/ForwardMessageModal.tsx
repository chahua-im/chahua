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
import { listGroups, type GroupSelectorItem } from '@/api/group';
import { UserAvatar } from '@/components/UserAvatar';
import { getChatDisplayName } from '@/utils/chatDisplay';
import { forwardMessage, type MessageResponse } from '@/api/messages';
import { getThreads, type ThreadListItem } from '@/api/threads';
import { useIsDesktop } from '@/hooks/platformHooks';

interface ForwardMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  message: MessageResponse;
  sourceChatId: string;
}

type UnifiedItem =
  | { type: 'group'; item: GroupSelectorItem; sortTime: number }
  | { type: 'thread'; item: ThreadListItem; sortTime: number };
export function ForwardMessageModal({ isOpen, onClose, message, sourceChatId }: ForwardMessageModalProps) {
  const [presentToast] = useIonToast();
  const [forwarding, setForwarding] = useState(false);
  const [groups, setGroups] = useState<GroupSelectorItem[]>([]);
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

  // Fetch joined chats and subscribed threads when modal opens.
  useEffect(() => {
    if (!isOpen) {
      setGroups([]);
      setThreads([]);
      setSearchText('');
      return;
    }

    let cancelled = false;
    setLoading(true);

    Promise.all([listGroups({ scope: 'joined', limit: 100 }), getThreads({ limit: 50, archived: false })])
      .then(([groupRes, threadRes]) => {
        if (!cancelled) {
          setGroups(groupRes.data.groups);
          setThreads(threadRes.data.threads);
        }
      })
      .catch(() => {
        // Silently fail — empty list will be shown.
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

    for (const group of groups) {
      items.push({
        type: 'group',
        item: group,
        sortTime: 0, // Groups don't have lastMessageAt in this context
      });
    }

    for (const thread of threads) {
      items.push({
        type: 'thread',
        item: thread,
        sortTime: thread.lastReplyAt ? new Date(thread.lastReplyAt).getTime() : 0,
      });
    }

    // Sort threads by most recent activity, groups stay at top
    items.sort((a, b) => {
      if (a.type === 'group' && b.type === 'group') return 0;
      if (a.type === 'group') return -1;
      if (b.type === 'group') return 1;
      return b.sortTime - a.sortTime;
    });

    return items;
  }, [groups, threads]);

  // Filter by search text.
  const filteredItems = useMemo(() => {
    if (!searchText.trim()) return mergedItems;
    const q = searchText.toLowerCase();

    return mergedItems.filter((item) => {
      if (item.type === 'group') {
        return item.item.name.toLowerCase().includes(q) || (item.item.description ?? '').toLowerCase().includes(q);
      }
      return (
        item.item.chatName.toLowerCase().includes(q) ||
        (item.item.threadRootMessage.message ?? '').toLowerCase().includes(q)
      );
    });
  }, [mergedItems, searchText]);

  const handleGroupSelect = useCallback(
    async (group: GroupSelectorItem) => {
      if (forwarding) return;
      setForwarding(true);
      try {
        await forwardMessage(group.id, message.id, {
          sourceChatId,
          clientGeneratedId: `cg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
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

  const handleThreadSelect = useCallback(
    async (thread: ThreadListItem) => {
      if (forwarding) return;
      setForwarding(true);
      try {
        await forwardMessage(thread.chatId, message.id, {
          sourceChatId,
          clientGeneratedId: `cg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          threadId: thread.threadRootMessage.id,
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
          placeholder={t`Search chats and threads`}
          value={searchText}
          onIonInput={(e) => setSearchText(e.detail.value ?? '')}
          debounce={200}
        />

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
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
                const group = unified.item;
                return (
                  <IonItem
                    key={`group-${group.id}`}
                    button
                    disabled={forwarding}
                    onClick={() => handleGroupSelect(group)}
                  >
                    <span slot="start">
                      <UserAvatar name={getChatDisplayName(group.id, group.name)} avatarUrl={group.avatar} size={40} />
                    </span>
                    <IonLabel>
                      <h3>{getChatDisplayName(group.id, group.name)}</h3>
                      {group.description && <p>{group.description}</p>}
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
                  onClick={() => handleThreadSelect(thread)}
                >
                  <span slot="start">
                    <UserAvatar
                      name={getChatDisplayName(thread.chatId, thread.chatName)}
                      avatarUrl={thread.chatAvatar}
                      size={40}
                    />
                  </span>
                  <IonLabel>
                    <h3>{thread.chatName}</h3>
                    <p>{thread.threadRootMessage.message?.slice(0, 60) ?? t`Sticker`}</p>
                    <p style={{ fontSize: '0.85em', opacity: 0.7 }}>
                      <IonIcon icon={chatbubbleOutline} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
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
