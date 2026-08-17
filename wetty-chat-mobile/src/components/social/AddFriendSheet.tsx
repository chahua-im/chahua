import { useEffect, useState } from 'react';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonNote,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
  IonModal,
  useIonToast,
} from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { friendsApi, type FriendAddInfoResponse } from '@/api/friends';
import styles from './AddFriendSheet.module.scss';

interface AddFriendSheetProps {
  targetUid: number;
  targetName: string;
  isOpen: boolean;
  onDismiss: () => void;
  onSent?: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; info: FriendAddInfoResponse };

export function AddFriendSheet({ targetUid, targetName, isOpen, onDismiss, onSent }: AddFriendSheetProps) {
  const [presentToast] = useIonToast();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  // Fetch the target's verification settings each time the sheet opens, and
  // reset transient state on close so it reopens fresh.
  useEffect(() => {
    if (!isOpen) {
      setText('');
      setSending(false);
      setLoad({ status: 'loading' });
      return;
    }
    let cancelled = false;
    setLoad({ status: 'loading' });
    friendsApi
      .getAddInfo(targetUid)
      .then((info) => {
        if (!cancelled) setLoad({ status: 'ready', info });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoad({ status: 'error', message: err.message || t`Failed to load` });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, targetUid]);

  const info = load.status === 'ready' ? load.info : null;
  const mode = info?.mode ?? null;

  const trimmed = text.trim();
  const canSend = !sending && mode !== null && mode !== 'forbid' && (mode === 'direct' ? true : trimmed.length > 0);

  const handleSend = async () => {
    if (!canSend || mode === null) return;
    setSending(true);
    try {
      await friendsApi.createRequest(targetUid, mode === 'direct' ? undefined : trimmed);
      presentToast({ message: t`Friend request sent`, duration: 2000, position: 'bottom' });
      onSent?.();
      onDismiss();
    } catch (err) {
      const message = err instanceof Error ? err.message : t`Failed to send request`;
      presentToast({ message, duration: 2000, position: 'bottom' });
    } finally {
      setSending(false);
    }
  };

  const sendDisabled = !canSend;

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onDismiss}>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonButton onClick={onDismiss}>
              <Trans>Cancel</Trans>
            </IonButton>
          </IonButtons>
          <IonTitle>
            <Trans>Add Friend</Trans>
          </IonTitle>
          <IonButtons slot="end">
            {mode === 'forbid' ? (
              <IonButton onClick={onDismiss}>
                <Trans>Done</Trans>
              </IonButton>
            ) : (
              <IonButton strong type="button" onClick={handleSend} disabled={sendDisabled}>
                <Trans>Send</Trans>
              </IonButton>
            )}
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light">
        <div className={styles.body}>
          <p className={styles.target}>
            <Trans>Send a friend request to {targetName}</Trans>
          </p>

          {load.status === 'loading' ? (
            <div className={styles.center}>
              <IonSpinner />
            </div>
          ) : null}

          {load.status === 'error' ? (
            <IonNote color="danger" className={styles.note}>
              {load.message}
            </IonNote>
          ) : null}

          {load.status === 'ready' ? (
            <>
              {mode === 'forbid' ? (
                <IonNote color="medium" className={styles.note}>
                  <Trans>This user has set their account to decline all friend requests.</Trans>
                </IonNote>
              ) : null}

              {mode === 'direct' ? (
                <IonNote color="medium" className={styles.note}>
                  <Trans>{targetName} will need to confirm your request.</Trans>
                </IonNote>
              ) : null}

              {mode === 'need_message' ? (
                <>
                  <IonNote color="medium" className={styles.note}>
                    <Trans>This user requires a verification message.</Trans>
                  </IonNote>
                  <IonTextarea
                    className={styles.field}
                    labelPlacement="stacked"
                    autoGrow
                    maxlength={200}
                    value={text}
                    onIonInput={(e) => setText(e.detail.value ?? '')}
                    placeholder={t`Enter a verification message`}
                  />
                </>
              ) : null}

              {mode === 'question' ? (
                <>
                  <div className={styles.question}>
                    <IonNote color="medium">
                      <Trans>Question</Trans>
                    </IonNote>
                    <p className={styles.questionText}>{info?.question ?? ''}</p>
                  </div>
                  <IonTextarea
                    className={styles.field}
                    labelPlacement="stacked"
                    autoGrow
                    maxlength={200}
                    value={text}
                    onIonInput={(e) => setText(e.detail.value ?? '')}
                    placeholder={t`Your answer`}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </IonContent>
    </IonModal>
  );
}
