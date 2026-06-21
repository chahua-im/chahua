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
  IonRange,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { t } from '@lingui/core/macro';
import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { checkmark } from 'ionicons/icons';
import {
  LONG_PRESS_CUSTOM_MAX,
  LONG_PRESS_CUSTOM_MIN,
  getLongPressPresets,
  isCustomLongPressValue,
  setLongPressDelayMs,
  useLongPressDelayMs,
} from '@/store/advancedSettingsStore';
import type { BackAction } from '@/types/back-action';
import { BackButton } from '@/components/BackButton';

interface LongPressDelayCoreProps {
  backAction?: BackAction;
}

export function LongPressDelayCore({ backAction }: LongPressDelayCoreProps) {
  const delayMs = useLongPressDelayMs();
  const presets = getLongPressPresets();
  const hasCustomValue = isCustomLongPressValue(delayMs);
  const [customSelected, setCustomSelected] = useState(hasCustomValue);

  const handlePresetTap = (value: number) => {
    setCustomSelected(false);
    setLongPressDelayMs(value);
  };

  const handleCustomTap = () => {
    setCustomSelected(true);
  };

  const handleSliderChange = (value: number) => {
    setLongPressDelayMs(value);
  };

  const isCurrentlyCustom = customSelected || hasCustomValue;

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {backAction ? (
              <BackButton action={backAction} />
            ) : (
              <IonBackButton text={t`Back`} defaultHref="/settings/advanced" />
            )}
          </IonButtons>
          <IonTitle>
            <Trans>Long Press Delay</Trans>
          </IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList>
          {presets.map((preset) => (
            <IonItem key={preset.value} button detail={false} onClick={() => handlePresetTap(preset.value)}>
              <IonLabel>{preset.label}</IonLabel>
              {!isCurrentlyCustom && delayMs === preset.value && (
                <IonIcon icon={checkmark} slot="end" color="primary" />
              )}
            </IonItem>
          ))}
          <IonItem button detail={false} onClick={handleCustomTap}>
            <IonLabel>{t`Custom`}</IonLabel>
            {isCurrentlyCustom && <IonIcon icon={checkmark} slot="end" color="primary" />}
          </IonItem>
        </IonList>

        {isCurrentlyCustom && (
          <IonList>
            <IonItem>
              <IonLabel position="stacked">
                {t`Delay`}: {delayMs}ms
              </IonLabel>
              <IonRange
                min={LONG_PRESS_CUSTOM_MIN}
                max={LONG_PRESS_CUSTOM_MAX}
                step={5}
                value={delayMs}
                onIonInput={(e) => handleSliderChange(e.detail.value as number)}
              >
                <IonLabel slot="start">{t`Fast`}</IonLabel>
                <IonLabel slot="end">{t`Slow`}</IonLabel>
              </IonRange>
            </IonItem>
          </IonList>
        )}
      </IonContent>
    </IonPage>
  );
}

export default function LongPressDelayPage() {
  return <LongPressDelayCore />;
}
