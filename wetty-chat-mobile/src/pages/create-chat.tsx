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
  useIonAlert,
} from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useDispatch } from 'react-redux';
import { Redirect, useHistory } from 'react-router-dom';
import { createChat } from '@/api/chats';
import { BackButton } from '@/components/BackButton';
import { PermissionGate } from '@/components/permissions/PermissionGate';
import { InsetContent } from '@/components/shared/InsetContent';
import { useIsDesktop } from '@/hooks/platformHooks';
import type { AppDispatch } from '@/store';
import { setChatInList, setChatMeta } from '@/store/chatsSlice';
import { refreshChatList } from '@/store/listPagination';
import type { BackAction } from '@/types/back-action';
import styles from './create-chat.module.scss';

interface CreateChatCoreProps {
  backAction?: BackAction;
}

export default function CreateChatCore({ backAction }: CreateChatCoreProps) {
  const dispatch = useDispatch<AppDispatch>();
  const history = useHistory();
  const isDesktop = useIsDesktop();
  const [presentAlert] = useIonAlert();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [hasTouchedName, setHasTouchedName] = useState(false);

  const trimmedName = name.trim();
  const validationError = hasTouchedName && trimmedName.length === 0 ? t`Chat name is required.` : null;
  const createDisabled = trimmedName.length === 0 || submitting;

  const handleSubmit = async () => {
    if (trimmedName.length === 0 || submitting) {
      setHasTouchedName(true);
      return;
    }

    setSubmitting(true);

    try {
      const response = await createChat({ name: trimmedName });
      const createdChat = response.data;

      dispatch(
        setChatMeta({
          chatId: createdChat.id,
          meta: {
            name: createdChat.name,
            createdAt: createdChat.createdAt,
          },
        }),
      );
      dispatch(setChatInList({ chatId: createdChat.id, inList: true }));

      try {
        await dispatch(refreshChatList(false));
      } catch (refreshError) {
        console.warn('Failed to refresh chats after creation', refreshError);
      }

      history.replace(`/chats/chat/${createdChat.id}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t`Failed to create chat`;
      presentAlert({
        header: t`Error`,
        message,
        buttons: [t`OK`],
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PermissionGate allow="chat.create" fallback={<Redirect to="/chats" />}>
      <div className="ion-page">
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">{backAction && <BackButton action={backAction} />}</IonButtons>
            <IonTitle>
              <Trans>New Chat</Trans>
            </IonTitle>
            <IonButtons slot="end">
              <IonButton disabled={createDisabled} onClick={handleSubmit}>
                {submitting ? t`Creating…` : t`Create`}
              </IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <IonContent color="light" className="ion-no-padding">
          <IonListHeader>
            <IonLabel>
              <Trans>Chat Details</Trans>
            </IonLabel>
          </IonListHeader>
          <IonList inset>
            <IonItem className={styles.nameInputRow}>
              <IonLabel className={styles.nameInputLabel}>
                <Trans>Name</Trans>
              </IonLabel>
              <IonInput
                placeholder={t`Enter chat name`}
                value={name}
                onIonInput={(event) => setName(event.detail.value ?? '')}
                onIonBlur={() => setHasTouchedName(true)}
                clearInput
                enterkeyhint="done"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
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
              <IonButton expand="block" disabled={createDisabled} onClick={handleSubmit}>
                {submitting ? t`Creating…` : t`Create`}
              </IonButton>
            </InsetContent>
          ) : null}
        </IonContent>
      </div>
    </PermissionGate>
  );
}

export function CreateChatPage() {
  return (
    <IonPage>
      <CreateChatCore backAction={{ type: 'back', defaultHref: '/chats' }} />
    </IonPage>
  );
}
