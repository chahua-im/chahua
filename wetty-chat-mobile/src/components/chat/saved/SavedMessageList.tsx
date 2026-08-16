import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IonButton, IonIcon, IonList, IonNote, IonSpinner, IonText, useIonAlert, useIonToast } from '@ionic/react';
import { bookmark, bookmarkOutline, chatbubbleOutline, documentAttachOutline, locationOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useSelector } from 'react-redux';
import {
  deleteSavedMessage,
  listChatSavedMessages,
  listSavedMessages,
  type SavedMessageResponse,
} from '@/api/savedMessages';
import { UserAvatar } from '@/components/UserAvatar';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import styles from './SavedMessageList.module.scss';

const PAGE_SIZE = 25;
const GLOBAL_SAVED_MESSAGES_KEY = 'global';

export interface SavedMessageListProps {
  chatId?: string;
  onOpenMessage: (saved: SavedMessageResponse) => void;
}

interface SavedMessagesState {
  requestKey: string;
  savedMessages: SavedMessageResponse[];
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
}

function renderMentionsAsText(text: string, mentions: SavedMessageResponse['mentions']): string {
  const mentionMap = new Map<number, string>();
  for (const mention of mentions) {
    if (mention.username) {
      mentionMap.set(mention.uid, mention.username);
    }
  }

  return text.replace(/@\[uid:(\d+)\]/g, (_, idStr) => {
    const uid = parseInt(idStr, 10);
    return `@${mentionMap.get(uid) ?? `User ${uid}`}`;
  });
}

function formatTimestamp(isoString: string, locale: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return t`Unknown`;
  }

  return Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function getSenderName(saved: SavedMessageResponse): string {
  return saved.sender.name?.trim() || t`User ${saved.sender.uid}`;
}

function getChatLabel(saved: SavedMessageResponse): string {
  return saved.chat.name?.trim() || t`Chat`;
}

function getAttachmentSummary(saved: SavedMessageResponse): string | null {
  const count = saved.attachments.length;
  if (count === 0) {
    return null;
  }

  const countLabel = count === 1 ? t`1 attachment` : t`${count} attachments`;
  const firstFileName = saved.attachments[0]?.fileName?.trim();
  return firstFileName ? `${firstFileName} · ${countLabel}` : countLabel;
}

function getStickerSummary(saved: SavedMessageResponse): string | null {
  if (!saved.sticker) {
    return null;
  }

  const parts = [t`Sticker`];
  if (saved.sticker.emoji) {
    parts.push(saved.sticker.emoji);
  }
  if (saved.sticker.name) {
    parts.push(saved.sticker.name);
  }
  return parts.join(' · ');
}

function getMessagePreview(saved: SavedMessageResponse): string {
  const text = saved.message?.trim();

  if (saved.messageType === 'invite') {
    return text ? renderMentionsAsText(text, saved.mentions) : t`Invite`;
  }

  if (saved.messageType === 'sticker') {
    return saved.sticker?.emoji ? `${t`Sticker`} ${saved.sticker.emoji}` : t`Sticker`;
  }

  if (saved.messageType === 'audio') {
    return t`Voice message`;
  }

  if (saved.messageType === 'file') {
    return saved.attachments[0]?.fileName?.trim() || t`Attachment`;
  }

  if (text) {
    return renderMentionsAsText(text, saved.mentions);
  }

  return t`Message`;
}

function SavedMessageCard({
  saved,
  locale,
  unsaving,
  onOpenMessage,
  onUnsave,
}: {
  saved: SavedMessageResponse;
  locale: string;
  unsaving: boolean;
  onOpenMessage: (saved: SavedMessageResponse) => void;
  onUnsave: (saved: SavedMessageResponse) => void;
}) {
  const senderName = getSenderName(saved);
  const attachmentSummary = getAttachmentSummary(saved);
  const stickerSummary = getStickerSummary(saved);
  const originalTimestamp = formatTimestamp(saved.originalCreatedAt, locale);
  const savedTimestamp = formatTimestamp(saved.savedAt, locale);
  const canOpen = saved.canLocateContext;
  const openLabel = canOpen ? t`Open original message` : t`Original message is no longer available`;

  const handleOpen = () => {
    if (!canOpen) {
      return;
    }
    onOpenMessage(saved);
  };

  return (
    <article className={`${styles.card} ${canOpen ? '' : styles.cardDisabled}`}>
      <div className={styles.cardHeader}>
        <UserAvatar name={senderName} avatarUrl={saved.sender.avatarUrl} size={40} />
        <div className={styles.headerText}>
          <div className={styles.senderRow}>
            <span className={styles.senderName}>{senderName}</span>
            <IonNote className={styles.originalAt}>{originalTimestamp}</IonNote>
          </div>
          <div className={styles.chatRow}>
            <IonIcon icon={chatbubbleOutline} aria-hidden="true" />
            <span>{getChatLabel(saved)}</span>
          </div>
        </div>
      </div>

      <p className={styles.messageText}>{getMessagePreview(saved)}</p>

      {attachmentSummary ? (
        <div className={styles.summaryRow}>
          <IonIcon icon={documentAttachOutline} aria-hidden="true" />
          <span>{attachmentSummary}</span>
        </div>
      ) : null}

      {stickerSummary ? (
        <div className={styles.summaryRow}>
          <IonIcon icon={bookmarkOutline} aria-hidden="true" />
          <span>{stickerSummary}</span>
        </div>
      ) : null}

      <div className={styles.footer}>
        <IonNote className={styles.savedMeta}>{t`Saved on ${savedTimestamp}`}</IonNote>
        <div className={styles.actions}>
          <IonButton
            aria-label={openLabel}
            className={styles.iconButton}
            fill="clear"
            size="small"
            disabled={!canOpen}
            onClick={handleOpen}
          >
            <IonIcon icon={locationOutline} slot="icon-only" />
          </IonButton>
          <IonButton
            aria-label={t`Unsave`}
            className={styles.iconButton}
            fill="clear"
            size="small"
            color="primary"
            disabled={unsaving}
            onClick={() => onUnsave(saved)}
          >
            <IonIcon icon={bookmark} slot="icon-only" />
          </IonButton>
        </div>
      </div>
    </article>
  );
}

export function SavedMessageList({ chatId, onOpenMessage }: SavedMessageListProps) {
  const locale = useSelector(selectEffectiveLocale);
  const [presentToast] = useIonToast();
  const [presentAlert] = useIonAlert();
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<SavedMessagesState>({
    requestKey: '',
    savedMessages: [],
    nextCursor: null,
    loadingMore: false,
    error: null,
  });
  const [unsavingIds, setUnsavingIds] = useState<Set<string>>(() => new Set());
  const requestSequenceRef = useRef(0);
  const unsavingIdsRef = useRef<Set<string>>(new Set());
  const listKey = chatId ? `chat:${chatId}` : GLOBAL_SAVED_MESSAGES_KEY;
  const requestKey = `${listKey}:${reloadToken}`;
  const isCurrentRequest = state.requestKey === requestKey;
  const savedMessages = isCurrentRequest ? state.savedMessages : [];
  const nextCursor = isCurrentRequest ? state.nextCursor : null;
  const loading = !isCurrentRequest;
  const loadingMore = isCurrentRequest && state.loadingMore;
  const error = isCurrentRequest ? state.error : null;

  useEffect(() => {
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;

    const request = chatId
      ? listChatSavedMessages(chatId, { limit: PAGE_SIZE, before: null })
      : listSavedMessages({ limit: PAGE_SIZE, before: null });

    request
      .then((response) => {
        if (requestSequenceRef.current !== sequence) {
          return;
        }

        setState({
          requestKey,
          savedMessages: response.data.savedMessages ?? [],
          nextCursor: response.data.nextCursor ?? null,
          loadingMore: false,
          error: null,
        });
        const emptyUnsavingIds = new Set<string>();
        unsavingIdsRef.current = emptyUnsavingIds;
        setUnsavingIds(emptyUnsavingIds);
      })
      .catch(() => {
        if (requestSequenceRef.current !== sequence) {
          return;
        }

        setState({
          requestKey,
          savedMessages: [],
          nextCursor: null,
          loadingMore: false,
          error: t`Failed to load saved messages`,
        });
      });
  }, [chatId, requestKey]);

  useEffect(() => {
    return () => {
      requestSequenceRef.current += 1;
    };
  }, []);

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || loading || loadingMore) {
      return;
    }

    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    setState((current) => ({ ...current, loadingMore: true, error: null }));

    const request = chatId
      ? listChatSavedMessages(chatId, { limit: PAGE_SIZE, before: nextCursor })
      : listSavedMessages({ limit: PAGE_SIZE, before: nextCursor });

    request
      .then((response) => {
        if (requestSequenceRef.current !== sequence) {
          return;
        }

        setState((current) => ({
          requestKey,
          savedMessages: [...current.savedMessages, ...(response.data.savedMessages ?? [])],
          nextCursor: response.data.nextCursor ?? null,
          loadingMore: false,
          error: null,
        }));
      })
      .catch(() => {
        if (requestSequenceRef.current !== sequence) {
          return;
        }

        setState((current) => ({
          ...current,
          loadingMore: false,
          error: t`Failed to load saved messages`,
        }));
      });
  }, [chatId, loading, loadingMore, nextCursor, requestKey]);

  const handleUnsave = useCallback(
    (saved: SavedMessageResponse) => {
      if (unsavingIdsRef.current.has(saved.id)) {
        return;
      }

      presentAlert({
        header: t`Unsave Message`,
        message: t`Remove this message from saved messages?`,
        buttons: [
          { text: t`Cancel`, role: 'cancel' },
          {
            text: t`Unsave`,
            role: 'destructive',
            handler: () => {
              const nextUnsavingIds = new Set(unsavingIdsRef.current);
              nextUnsavingIds.add(saved.id);
              unsavingIdsRef.current = nextUnsavingIds;
              setUnsavingIds(nextUnsavingIds);

              deleteSavedMessage(saved.id)
                .then(() => {
                  setState((current) => ({
                    ...current,
                    savedMessages: current.savedMessages.filter((row) => row.id !== saved.id),
                  }));
                })
                .catch(() => {
                  presentToast({ message: t`Failed to unsave message`, duration: 3000, position: 'bottom' });
                })
                .finally(() => {
                  const next = new Set(unsavingIdsRef.current);
                  next.delete(saved.id);
                  unsavingIdsRef.current = next;
                  setUnsavingIds(next);
                });
            },
          },
        ],
      });
    },
    [presentAlert, presentToast],
  );

  const hasRows = savedMessages.length > 0;
  const stateContent = useMemo(() => {
    if (loading) {
      return <IonSpinner />;
    }

    if (error) {
      return (
        <div className={styles.errorState}>
          <IonText color="danger">{error}</IonText>
          <IonButton fill="clear" size="small" onClick={() => setReloadToken((current) => current + 1)}>
            <Trans>Try Again</Trans>
          </IonButton>
        </div>
      );
    }

    if (!hasRows) {
      return <Trans>No saved messages yet</Trans>;
    }

    return null;
  }, [error, hasRows, loading]);

  return (
    <div className={styles.layout}>
      {stateContent ? <div className={styles.state}>{stateContent}</div> : null}

      {hasRows ? (
        <IonList inset className={styles.list}>
          {savedMessages.map((saved) => (
            <SavedMessageCard
              key={saved.id}
              saved={saved}
              locale={locale}
              unsaving={unsavingIds.has(saved.id)}
              onOpenMessage={onOpenMessage}
              onUnsave={handleUnsave}
            />
          ))}
        </IonList>
      ) : null}

      {nextCursor ? (
        <div className={styles.loadMoreWrap}>
          <IonButton expand="block" fill="clear" disabled={loadingMore} onClick={handleLoadMore}>
            {loadingMore ? <IonSpinner name="crescent" /> : <Trans>Load More</Trans>}
          </IonButton>
        </div>
      ) : null}
    </div>
  );
}
