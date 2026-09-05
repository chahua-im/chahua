import { useState } from 'react';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonPage,
  IonTitle,
  IonToggle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import { useHistory } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { getCurrentUserId, normalizeCurrentUserId, setCurrentUserId } from '@/utils/current-user';
import type { RootState } from '@/store/index';
import { Trans } from '@lingui/react/macro';
import { FeatureGate } from '@/components/FeatureGate';
import { CheckForUpdateItem } from '@/components/settings/CheckForUpdateItem';
import { AppVersionItem } from '@/components/settings/AppVersionItem';
import { SettingsProfileHero } from '@/components/settings/SettingsProfileHero';

import { getPushNotificationErrorMessage, usePushNotifications } from '@/hooks/usePushNotifications';
import { t } from '@lingui/core/macro';
import { bookmarkOutline, codeWorking, cog, happyOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { BackButton } from '@/components/BackButton';
import type { BackAction } from '@/types/back-action';

interface SettingsCoreProps {
  backAction?: BackAction;
  onOpenGeneral?: () => void;
  onOpenSavedMessages?: () => void;
  onOpenStickers?: () => void;
  onOpenFriendVerification?: () => void;
}

export function SettingsCore({
  backAction,
  onOpenGeneral,
  onOpenSavedMessages,
  onOpenStickers,
  onOpenFriendVerification,
}: SettingsCoreProps) {
  const {
    uid: currentUid,
    username,
    avatarUrl,
    loading: currentUserLoading,
  } = useSelector((state: RootState) => state.user);
  // The developer field edits the stored development UID, which is available synchronously
  // and is what the auth bootstrap used to mint this session — not the fetched profile UID.
  const [uidInput, setUidInput] = useState(() => String(getCurrentUserId()));
  const [presentToast] = useIonToast();
  const history = useHistory();
  const { isSubscribed, loading, isCheckingSubscription, subscribeToPush, unsubscribeFromPush } =
    usePushNotifications();

  const handleSave = () => {
    const uid = normalizeCurrentUserId(uidInput);
    if (uid === null) {
      presentToast({ message: t`Enter a valid User ID (integer from 1 to 2,147,483,647)`, duration: 3000 });
      return;
    }
    setCurrentUserId(uid);
    window.location.reload();
  };

  const handleOpenGeneral = () => {
    if (onOpenGeneral) {
      onOpenGeneral();
      return;
    }
    history.push('/settings/general');
  };

  const handleOpenStickers = () => {
    if (onOpenStickers) {
      onOpenStickers();
      return;
    }
    history.push('/settings/stickers');
  };

  const handleOpenSavedMessages = () => {
    if (onOpenSavedMessages) {
      onOpenSavedMessages();
      return;
    }
    history.push('/settings/saved-messages');
  };

  const handleOpenFriendVerification = () => {
    if (onOpenFriendVerification) {
      onOpenFriendVerification();
      return;
    }
    history.push('/settings/friend-verification');
  };

  const handlePushToggle = async (enabled: boolean) => {
    const result = enabled ? await subscribeToPush() : await unsubscribeFromPush();
    if (result.ok) {
      presentToast({
        message: enabled ? t`Push notifications enabled` : t`Push notifications turned off`,
        duration: 2000,
        position: 'bottom',
      });
      return;
    }

    presentToast({ message: getPushNotificationErrorMessage(result.code), duration: 3000, position: 'bottom' });
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">{backAction && <BackButton action={backAction} />}</IonButtons>
          <IonTitle>
            <Trans>Settings</Trans>
          </IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light" className="ion-no-padding">
        <SettingsProfileHero uid={currentUid} username={username} avatarUrl={avatarUrl} loading={currentUserLoading} />
        <IonListHeader>
          <IonLabel>
            <Trans>General</Trans>
          </IonLabel>
        </IonListHeader>
        <IonList inset>
          <IonItem button detail={true} onClick={handleOpenGeneral}>
            <IonIcon aria-hidden="true" icon={cog} slot="start" color="medium" />
            <IonLabel>
              <Trans>General</Trans>
            </IonLabel>
          </IonItem>
          <FeatureGate feature="savedMessages">
            <IonItem button detail={true} onClick={handleOpenSavedMessages}>
              <IonIcon aria-hidden="true" icon={bookmarkOutline} slot="start" color="medium" />
              <IonLabel>
                <Trans>Saved Messages</Trans>
              </IonLabel>
            </IonItem>
          </FeatureGate>
          <FeatureGate feature="friends">
            <IonItem button detail={true} onClick={handleOpenFriendVerification}>
              <IonIcon aria-hidden="true" icon={shieldCheckmarkOutline} slot="start" color="medium" />
              <IonLabel>
                <Trans>Friend Verification</Trans>
              </IonLabel>
            </IonItem>
          </FeatureGate>
          <IonItem button detail={true} onClick={handleOpenStickers}>
            <IonIcon aria-hidden="true" icon={happyOutline} slot="start" color="medium" />
            <IonLabel>
              <Trans>Emojis & Stickers</Trans>
            </IonLabel>
          </IonItem>
        </IonList>

        <FeatureGate feature="developerSettings">
          <IonListHeader>
            <IonLabel>Developer</IonLabel>
          </IonListHeader>
          <IonList inset={true}>
            <FeatureGate feature="developerSettings" devOnly>
              <IonItem>
                <IonIcon aria-hidden="true" icon={codeWorking} slot="start" color="medium" />
                <IonInput
                  label="User ID"
                  type="number"
                  placeholder="e.g. 1"
                  value={uidInput}
                  onIonInput={(e) => setUidInput(e.detail.value ?? '')}
                  className="ion-text-right"
                />
              </IonItem>
              <IonItem button onClick={handleSave} detail={false}>
                <IonLabel color="primary">
                  <Trans>Save</Trans>
                </IonLabel>
              </IonItem>
            </FeatureGate>
          </IonList>
        </FeatureGate>

        <IonList inset={true}>
          <IonItem lines="none">
            <IonLabel>
              <Trans>Message notifications</Trans>
            </IonLabel>
            <IonToggle
              slot="end"
              checked={isSubscribed}
              disabled={loading || isCheckingSubscription}
              onIonChange={(event) => void handlePushToggle(event.detail.checked)}
            />
          </IonItem>
        </IonList>

        <IonListHeader>
          <IonLabel>
            <Trans>About</Trans>
          </IonLabel>
        </IonListHeader>
        <IonList inset={true}>
          <CheckForUpdateItem />
        </IonList>
        <AppVersionItem />
      </IonContent>
    </IonPage>
  );
}

export default function Settings() {
  return <SettingsCore />;
}
