import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { checkmark } from 'ionicons/icons';
import type { ReactNode } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useHistory } from 'react-router-dom';
import { BackButton } from '@/components/BackButton';
import { selectColorMode, setColorMode } from '@/store/settingsSlice';
import type { BackAction } from '@/types/back-action';
import type { ColorMode } from '@/utils/colorMode';

interface ColorModePageCoreProps {
  backAction?: BackAction;
}

const colorModeOptions: Array<{ value: ColorMode; label: ReactNode }> = [
  { value: 'system', label: <Trans>Follow System</Trans> },
  { value: 'light', label: <Trans>Light</Trans> },
  { value: 'dark', label: <Trans>Dark</Trans> },
];

export function ColorModePageCore({ backAction }: ColorModePageCoreProps) {
  const dispatch = useDispatch();
  const history = useHistory();
  const colorMode = useSelector(selectColorMode);

  const handleSelect = (nextColorMode: ColorMode) => {
    dispatch(setColorMode(nextColorMode));
    history.goBack();
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {backAction ? (
              <BackButton action={backAction} />
            ) : (
              <IonBackButton text={t`Back`} defaultHref="/settings/general" />
            )}
          </IonButtons>
          <IonTitle>
            <Trans>Appearance</Trans>
          </IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light">
        <IonList>
          {colorModeOptions.map(({ value, label }) => (
            <IonItem key={value} button detail={false} onClick={() => handleSelect(value)}>
              <IonLabel>{label}</IonLabel>
              {colorMode === value && <IonIcon icon={checkmark} slot="end" color="primary" />}
            </IonItem>
          ))}
        </IonList>
      </IonContent>
    </IonPage>
  );
}

export default function ColorModePage() {
  return <ColorModePageCore />;
}
