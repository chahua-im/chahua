import { useEffect, useState, type ReactNode } from 'react';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonPage,
  IonRadio,
  IonRadioGroup,
  IonTextarea,
  IonTitle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { BackButton } from '@/components/BackButton';
import { friendsApi, type FriendAddVerificationMode } from '@/api/friends';
import type { BackAction } from '@/types/back-action';
import styles from './FriendVerificationSettings.module.scss';

interface FriendVerificationCoreProps {
  backAction?: BackAction;
}

const MODE_OPTIONS: FriendAddVerificationMode[] = ['direct', 'need_message', 'question', 'forbid'];

function modeLabel(mode: FriendAddVerificationMode): ReactNode {
  switch (mode) {
    case 'direct':
      return <Trans>Allow anyone to add me</Trans>;
    case 'need_message':
      return <Trans>Require a verification message</Trans>;
    case 'question':
      return <Trans>Require an answer to a question</Trans>;
    case 'forbid':
      return <Trans>Decline all friend requests</Trans>;
  }
}

function describe(mode: FriendAddVerificationMode): string {
  switch (mode) {
    case 'direct':
      return t`Anyone can send you a friend request. No verification message is needed; you just accept or decline.`;
    case 'need_message':
      return t`Requesters must attach a verification message. You review it before accepting.`;
    case 'question':
      return t`Requesters must answer your question. You review the answer before accepting.`;
    case 'forbid':
      return t`No one can send you a friend request.`;
  }
}

export function FriendVerificationCore({ backAction }: FriendVerificationCoreProps) {
  const [presentToast] = useIonToast();
  const [mode, setMode] = useState<FriendAddVerificationMode>('direct');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    friendsApi
      .getMySettings()
      .then((settings) => {
        if (cancelled) return;
        setMode(settings.mode);
        setQuestion(settings.question ?? '');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        presentToast({
          message: err instanceof Error ? err.message : t`Failed to load`,
          duration: 2000,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [presentToast]);

  const questionInvalid = mode === 'question' && question.trim().length === 0;
  const canSave = !loading && !saving && !questionInvalid;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await friendsApi.updateMySettings({
        mode,
        question: mode === 'question' ? question.trim() : null,
      });
      presentToast({ message: t`Saved`, duration: 2000, position: 'bottom' });
    } catch (err) {
      presentToast({
        message: err instanceof Error ? err.message : t`Failed to save`,
        duration: 2000,
        position: 'bottom',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {backAction ? (
              <BackButton action={backAction} />
            ) : (
              <IonBackButton text={t`Back`} defaultHref="/settings" />
            )}
          </IonButtons>
          <IonTitle>
            <Trans>Friend Verification</Trans>
          </IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={handleSave} disabled={!canSave}>
              <Trans>Save</Trans>
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light">
        <IonList inset>
          <IonRadioGroup
            value={mode}
            onIonChange={(e) => setMode(e.detail.value as FriendAddVerificationMode)}
          >
            {MODE_OPTIONS.map((option) => (
              <IonItem key={option}>
                <IonRadio value={option} labelPlacement="end" justify="start" disabled={loading || saving}>
                  {modeLabel(option)}
                </IonRadio>
              </IonItem>
            ))}
          </IonRadioGroup>
        </IonList>

        <div className={styles.description}>
          <IonNote color="medium">{describe(mode)}</IonNote>
        </div>

        {mode === 'question' ? (
          <>
            <IonListHeader>
              <IonLabel>
                <Trans>Your Question</Trans>
              </IonLabel>
            </IonListHeader>
            <IonList inset>
              <IonItem>
                <IonTextarea
                  className={styles.field}
                  labelPlacement="stacked"
                  autoGrow
                  maxlength={100}
                  value={question}
                  onIonInput={(e) => setQuestion(e.detail.value ?? '')}
                  placeholder={t`Enter the question requesters must answer`}
                  disabled={loading || saving}
                />
              </IonItem>
              {questionInvalid ? (
                <IonNote color="danger" className={styles.error}>
                  <Trans>A question is required.</Trans>
                </IonNote>
              ) : null}
            </IonList>
          </>
        ) : null}
      </IonContent>
    </IonPage>
  );
}

export default function FriendVerificationPage() {
  return <FriendVerificationCore />;
}
