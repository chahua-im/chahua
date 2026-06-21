import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import { useMemo } from 'react';
import { useHistory } from 'react-router-dom';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { clipboardOutline } from 'ionicons/icons';
import { useDeviceToken } from '@/hooks/useDeviceToken';
import { getLongPressPresets, useAdvancedSettingsUnlocked, useLongPressDelayMs } from '@/store/advancedSettingsStore';
import type { BackAction } from '@/types/back-action';
import { BackButton } from '@/components/BackButton';

interface AdvancedSettingsCoreProps {
  backAction?: BackAction;
  onOpenLongPressDelay?: () => void;
}

export function AdvancedSettingsCore({ backAction, onOpenLongPressDelay }: AdvancedSettingsCoreProps) {
  const jwtToken = useDeviceToken();
  const longPressDelay = useLongPressDelayMs();
  const history = useHistory();
  const currentPresetLabel = useMemo(() => {
    return getLongPressPresets().find((p) => p.value === longPressDelay)?.label ?? `${longPressDelay}ms`;
  }, [longPressDelay]);
  const [presentToast] = useIonToast();

  const handleCopyToken = async () => {
    if (!jwtToken) {
      presentToast({ message: t`No JWT token available`, duration: 2000, position: 'bottom' });
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(jwtToken);
      } else {
        // Fallback for non-secure contexts (e.g. desktop browser without HTTPS)
        const textarea = document.createElement('textarea');
        textarea.value = jwtToken;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      presentToast({ message: t`JWT token copied`, duration: 2000, position: 'bottom' });
    } catch {
      presentToast({ message: t`Failed to copy token`, duration: 2500, position: 'bottom' });
    }
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {backAction ? <BackButton action={backAction} /> : <IonBackButton text={t`Back`} defaultHref="/settings" />}
          </IonButtons>
          <IonTitle>
            <Trans>Advanced Settings</Trans>
          </IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light" className="ion-no-padding">
        <IonListHeader>
          <IonLabel>
            <Trans>Message Actions</Trans>
          </IonLabel>
        </IonListHeader>
        <IonList inset>
          <IonItem
            button
            detail={true}
            onClick={onOpenLongPressDelay ?? (() => history.push('/settings/advanced/long-press-delay'))}
          >
            <IonLabel>
              <Trans>Long Press Delay</Trans>
              <p>{currentPresetLabel}</p>
            </IonLabel>
          </IonItem>
        </IonList>

        <IonListHeader>
          <IonLabel>
            <Trans>Developer</Trans>
          </IonLabel>
        </IonListHeader>
        <IonList inset>
          <IonItem button detail={false} onClick={handleCopyToken}>
            <IonIcon aria-hidden="true" icon={clipboardOutline} slot="start" color="medium" />
            <IonLabel>
              <Trans>Copy JWT Token</Trans>
            </IonLabel>
          </IonItem>
        </IonList>
      </IonContent>
    </IonPage>
  );
}

export default function AdvancedSettingsPage() {
  const history = useHistory();
  const unlocked = useAdvancedSettingsUnlocked();
  if (!unlocked) {
    history.replace('/settings');
    return null;
  }
  return <AdvancedSettingsCore />;
}
