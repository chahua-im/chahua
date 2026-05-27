import { IonIcon, useIonAlert } from '@ionic/react';
import { chatbubbles, close, listOutline, pin } from 'ionicons/icons';
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { t } from '@lingui/core/macro';
import type { RootState } from '@/store/index';
import { useChatRole } from '@/components/chat/permissions/useChatRole';
import { selectPinsForChat } from '@/store/pinsSlice';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { deletePin } from '@/api/pins';
import { formatMessagePreview, getNotificationPreviewLabels } from '@/utils/messagePreview';
import styles from './PinBanner.module.scss';

interface PinBannerProps {
  chatId: string;
  bottomVisibleMessageDate?: string | null;
  onClickPin: (messageId: string) => void;
  onClickThread: (messageId: string) => void;
  onClickCounter: () => void;
}

export function PinBanner({
  chatId,
  bottomVisibleMessageDate,
  onClickPin,
  onClickThread,
  onClickCounter,
}: PinBannerProps) {
  const [presentAlert] = useIonAlert();
  const { role } = useChatRole(chatId);
  const isAdmin = role === 'admin';
  const pins = useSelector((state: RootState) => selectPinsForChat(state, chatId));
  const locale = useSelector(selectEffectiveLocale);

  const activePin = useMemo(() => {
    if (pins.length === 0) return null;
    if (!bottomVisibleMessageDate) return pins[0];

    const visibleTime = new Date(bottomVisibleMessageDate).getTime();
    // Assuming pins are already sorted descending by message.createdAt in Redux (newest at index 0)
    for (const p of pins) {
      // Find the most recent pin that is at or above the bottom of the visible viewport
      if (new Date(p.message.createdAt).getTime() <= visibleTime) {
        return p;
      }
    }
    // If all pins are newer than our current viewport, maybe just show the oldest one
    return pins[pins.length - 1];
  }, [pins, bottomVisibleMessageDate]);

  const handleUnpin = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!activePin) return;
      presentAlert({
        header: t`Unpin Message`,
        message: t`Would you like to unpin this message?`,
        buttons: [
          { text: t`Cancel`, role: 'cancel' },
          {
            text: t`Unpin`,
            role: 'destructive',
            handler: () => {
              deletePin(chatId, activePin.id).catch(() => {});
            },
          },
        ],
      });
    },
    [chatId, activePin, presentAlert],
  );

  const handleThreadClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (activePin) {
        onClickThread(activePin.message.id);
      }
    },
    [activePin, onClickThread],
  );

  const handleCounterClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClickCounter();
    },
    [onClickCounter],
  );

  if (!activePin) return null;

  const msg = activePin.message;
  const previewText = formatMessagePreview(msg, getNotificationPreviewLabels(locale)) || t`Message`;

  return (
    <div className={styles.banner}>
      <div
        className={styles.pinContent}
        onClick={() => onClickPin(msg.id)}
        role="button"
        tabIndex={0}
        aria-label={t`Pinned message`}
      >
        <IonIcon icon={pin} className={styles.pinIcon} />
        <div className={styles.text}>
          <span className={styles.senderName}>{msg.sender.name ?? `User ${msg.sender.uid}`}</span>
          <span className={styles.messageText}>{previewText}</span>
        </div>
      </div>

      {msg.threadInfo && (
        <button className={styles.threadBtn} onClick={handleThreadClick} aria-label={t`Open thread`}>
          <IonIcon icon={chatbubbles} />
        </button>
      )}

      {pins.length > 1 && (
        <button className={styles.listBtn} onClick={handleCounterClick} aria-label={t`View all pinned messages`}>
          <IonIcon icon={listOutline} />
          <span className={styles.listCount}>{pins.length}</span>
        </button>
      )}

      {isAdmin && (
        <button className={styles.closeBtn} onClick={handleUnpin} aria-label={t`Unpin`}>
          <IonIcon icon={close} />
        </button>
      )}
    </div>
  );
}
