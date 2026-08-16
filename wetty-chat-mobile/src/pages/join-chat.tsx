import { useState } from 'react';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonPage,
  IonText,
  IonTitle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import axios from 'axios';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useHistory } from 'react-router-dom';
import { getInvitePreview } from '@/api/invites';
import { BackButton } from '@/components/BackButton';
import { InsetContent } from '@/components/shared/InsetContent';
import { useIsDesktop } from '@/hooks/platformHooks';
import type { BackAction } from '@/types/back-action';
import styles from './join-chat.module.scss';

interface JoinChatCoreProps {
  backAction?: BackAction;
}

export function JoinChatCore({ backAction }: JoinChatCoreProps) {
  const history = useHistory();
  const isDesktop = useIsDesktop();
  const [presentToast] = useIonToast();
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmedCode = inviteCodeInput.trim();

    if (!trimmedCode) {
      presentToast({ message: t`Enter an invite code`, duration: 2000, position: 'bottom' });
      return;
    }

    setSubmitting(true);
    setValidationError(null);

    try {
      await getInvitePreview(trimmedCode);
      history.replace(`/chats/join/${encodeURIComponent(trimmedCode)}`);
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        setValidationError(t`The invite code entered is not valid.`);
        return;
      }

      presentToast({ message: t`Could not validate invite code`, duration: 2500, position: 'bottom' });
    } finally {
      setSubmitting(false);
    }
  };

  const continueDisabled = inviteCodeInput.trim().length === 0 || submitting;

  return (
    <div className="ion-page">
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">{backAction && <BackButton action={backAction} />}</IonButtons>
          <IonTitle>
            <Trans>Join Group</Trans>
          </IonTitle>
          <IonButtons slot="end">
            <IonButton disabled={continueDisabled} onClick={handleSubmit}>
              {submitting ? t`Loading…` : t`Continue`}
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light" className="ion-no-padding">
        <IonListHeader>
          <IonLabel>
            <Trans>Invite Code</Trans>
          </IonLabel>
        </IonListHeader>
        <IonList inset>
          <IonItem className={styles.codeInputRow}>
            <IonLabel className={styles.codeInputLabel}>
              <Trans>Code</Trans>
            </IonLabel>
            <IonInput
              placeholder={t`Paste code`}
              value={inviteCodeInput}
              onIonInput={(event) => {
                setInviteCodeInput(event.detail.value ?? '');
                if (validationError) {
                  setValidationError(null);
                }
              }}
              clearInput
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              enterkeyhint="go"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </IonItem>
        </IonList>
        {validationError ? (
          <InsetContent className={styles.validationError}>
            <IonText color="danger">{validationError}</IonText>
          </InsetContent>
        ) : null}

        {isDesktop ? (
          <InsetContent className={styles.desktopActions}>
            <IonButton expand="block" disabled={continueDisabled} onClick={handleSubmit}>
              {submitting ? t`Loading…` : t`Continue`}
            </IonButton>
          </InsetContent>
        ) : null}
      </IonContent>
    </div>
  );
}

export default function JoinChatPage() {
  return (
    <IonPage>
      <JoinChatCore backAction={{ type: 'back', defaultHref: '/chats' }} />
    </IonPage>
  );
}
