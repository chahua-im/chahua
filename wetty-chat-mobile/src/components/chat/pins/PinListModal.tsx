import { IonButton, IonContent, IonIcon, IonItem, IonList, IonModal, useIonAlert } from '@ionic/react';
import { chatbubbles } from 'ionicons/icons';
import { useCallback } from 'react';
import { useSelector } from 'react-redux';
import { t } from '@lingui/core/macro';
import type { RootState } from '@/store/index';
import { useChatRole } from '@/components/chat/permissions/useChatRole';
import { selectPinsForChat } from '@/store/pinsSlice';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import type { PinResponse } from '@/api/pins';
import { deletePin } from '@/api/pins';
import { formatMessagePreview, getNotificationPreviewLabels } from '@/utils/messagePreview';
import styles from './PinListModal.module.scss';
import { useIsDesktop } from '@/hooks/platformHooks';

interface PinListModalProps {
  chatId: string;
  isOpen: boolean;
  onDismiss: () => void;
  onSelectPin: (messageId: string) => void;
  onSelectThread: (messageId: string) => void;
}

export function PinListModal({ chatId, isOpen, onDismiss, onSelectPin, onSelectThread }: PinListModalProps) {
  const [presentAlert] = useIonAlert();
  const isDesktop = useIsDesktop();
  const { role } = useChatRole(chatId);
  const isAdmin = role === 'admin';
  const pins = useSelector((state: RootState) => selectPinsForChat(state, chatId));
  const locale = useSelector(selectEffectiveLocale);

  const handleItemClick = useCallback(
    (pin: PinResponse) => {
      onDismiss();
      onSelectPin(pin.message.id);
    },
    [onDismiss, onSelectPin],
  );

  const handleUnpin = useCallback(
    (e: React.MouseEvent, pin: PinResponse) => {
      e.preventDefault();
      e.stopPropagation();
      presentAlert({
        header: t`Unpin Message`,
        message: t`Would you like to unpin this message?`,
        buttons: [
          { text: t`Cancel`, role: 'cancel' },
          {
            text: t`Unpin`,
            role: 'destructive',
            handler: () => {
              deletePin(chatId, pin.id).catch(() => {});
            },
          },
        ],
      });
    },
    [chatId, presentAlert],
  );

  const handleThreadClick = useCallback(
    (e: React.MouseEvent, pin: PinResponse) => {
      e.stopPropagation();
      onDismiss();
      onSelectThread(pin.message.id);
    },
    [onDismiss, onSelectThread],
  );

  return (
    <IonModal
      isOpen={isOpen}
      onDidDismiss={onDismiss}
      {...(!isDesktop ? { initialBreakpoint: 0.5, breakpoints: [0, 0.5, 0.75] } : {})}
    >
      <IonContent>
        <div className={styles.header}>
          <span className={styles.title}>{t`Pinned Messages`}</span>
          <IonButton fill="clear" size="small" onClick={onDismiss}>
            {t`Done`}
          </IonButton>
        </div>
        {pins.length === 0 ? (
          <div className={styles.emptyState}>{t`No pinned messages`}</div>
        ) : (
          <IonList className={styles.list}>
            {pins.map((pin) => {
              const msg = pin.message;
              const previewText = formatMessagePreview(msg, getNotificationPreviewLabels(locale)) || t`Message`;
              const senderName = msg.sender.name ?? `User ${msg.sender.uid}`;
              return (
                <IonItem
                  key={pin.id}
                  className={styles.pinItem}
                  button
                  detail={false}
                  onClick={() => handleItemClick(pin)}
                >
                  <div className={styles.pinItemContent}>
                    {msg.sender.avatarUrl ? (
                      <img src={msg.sender.avatarUrl} alt="" className={styles.avatar} />
                    ) : (
                      <div className={styles.avatarPlaceholder}>{senderName.charAt(0).toUpperCase()}</div>
                    )}
                    <div className={styles.pinBody}>
                      <span className={styles.pinSender}>{senderName}</span>
                      <span className={styles.pinMessage}>{previewText}</span>
                    </div>
                    <div className={styles.actions}>
                      {msg.threadInfo && (
                        <IonButton fill="clear" size="small" onClick={(e) => handleThreadClick(e, pin)}>
                          <IonIcon icon={chatbubbles} slot="icon-only" className={styles.threadBadge} />
                        </IonButton>
                      )}
                      {isAdmin && (
                        <IonButton
                          fill="clear"
                          size="small"
                          color="danger"
                          className={styles.unpinBtn}
                          onClick={(e) => handleUnpin(e, pin)}
                        >
                          {t`Unpin`}
                        </IonButton>
                      )}
                    </div>
                  </div>
                </IonItem>
              );
            })}
          </IonList>
        )}
      </IonContent>
    </IonModal>
  );
}
