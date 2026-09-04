import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonPage,
  IonRange,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/react';
import { useDispatch, useSelector } from 'react-redux';
import { useHistory } from 'react-router-dom';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from '@/i18n';
import { BackButton } from '@/components/BackButton';
import { ChatBubble } from '@/components/chat/messages/ChatBubble';
import {
  chatFontSizeOptions,
  selectColorMode,
  selectLocale,
  selectMessageFontSize,
  selectShowAllAvatars,
  selectShowThreadsInMessages,
  setMessageFontSize,
  setShowAllAvatars,
  setShowThreadsInMessages,
} from '@/store/settingsSlice';
import { FeatureGate } from '@/components/FeatureGate';
import type { BackAction } from '@/types/back-action';
import type { ColorMode } from '@/utils/colorMode';
import styles from './GeneralSettings.module.scss';

interface GeneralSettingsCoreProps {
  backAction?: BackAction;
  onOpenLanguage?: () => void;
  onOpenColorMode?: () => void;
}

const localeLabels: Record<string, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
};

function getColorModeLabel(colorMode: ColorMode): string {
  switch (colorMode) {
    case 'light':
      return t`Light`;
    case 'dark':
      return t`Dark`;
    case 'system':
      return t`Follow System`;
  }
}

export function GeneralSettingsCore({ backAction, onOpenLanguage, onOpenColorMode }: GeneralSettingsCoreProps) {
  const dispatch = useDispatch();
  const history = useHistory();
  const locale = useSelector(selectLocale);
  const colorMode = useSelector(selectColorMode);
  const messageFontSize = useSelector(selectMessageFontSize);
  const showThreadsInMessages = useSelector(selectShowThreadsInMessages);
  const showAllAvatars = useSelector(selectShowAllAvatars);
  const sliderValue = chatFontSizeOptions.indexOf(messageFontSize);

  const handleOpenLanguage = () => {
    if (onOpenLanguage) {
      onOpenLanguage();
      return;
    }
    history.push('/settings/language');
  };

  const handleOpenColorMode = () => {
    if (onOpenColorMode) {
      onOpenColorMode();
      return;
    }
    history.push('/settings/color-mode');
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {backAction ? <BackButton action={backAction} /> : <IonBackButton text={t`Back`} defaultHref="/settings" />}
          </IonButtons>
          <IonTitle>
            <Trans>General</Trans>
          </IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light" className="ion-no-padding">
        <IonList inset>
          <IonItem button detail={true} onClick={handleOpenLanguage}>
            <IonLabel>
              <Trans>Language</Trans>
            </IonLabel>
            <IonLabel slot="end" color="medium">
              {locale ? (localeLabels[locale] ?? locale) : t`Auto`}
            </IonLabel>
          </IonItem>
          <FeatureGate feature="colorMode">
            <IonItem button detail={true} onClick={handleOpenColorMode}>
              <IonLabel>
                <Trans>Appearance</Trans>
              </IonLabel>
              <IonLabel slot="end" color="medium">
                {getColorModeLabel(colorMode)}
              </IonLabel>
            </IonItem>
          </FeatureGate>
          <IonItem>
            <IonToggle
              checked={showThreadsInMessages}
              onIonChange={(e) => dispatch(setShowThreadsInMessages(e.detail.checked))}
            >
              <Trans>Show 'Threads' in Messages</Trans>
            </IonToggle>
          </IonItem>
          <IonItem>
            <IonToggle checked={showAllAvatars} onIonChange={(e) => dispatch(setShowAllAvatars(e.detail.checked))}>
              <Trans>Show Avatars Next to All Messages</Trans>
            </IonToggle>
          </IonItem>
        </IonList>

        <IonListHeader>
          <IonLabel>
            <Trans>Messages Font Size</Trans>
          </IonLabel>
        </IonListHeader>
        <IonList inset>
          <IonItem>
            <div className={styles.sectionContent}>
              <IonRange
                aria-label={i18n._(t`Messages Font Size`)}
                min={0}
                max={chatFontSizeOptions.length - 1}
                step={1}
                snaps={true}
                ticks={true}
                value={sliderValue}
                onIonInput={(event) => {
                  const nextIndex = Number(event.detail.value);
                  const nextValue = chatFontSizeOptions[nextIndex];
                  if (nextValue) {
                    dispatch(setMessageFontSize(nextValue));
                  }
                }}
              />
              <div className={styles.rangeLabels}>
                <span>{i18n._(t`Small`)}</span>
                <span>{i18n._(t`Large`)}</span>
              </div>
            </div>
          </IonItem>
          <IonItem>
            <div className={styles.sectionContent}>
              <div className={styles.previewBubble}>
                <ChatBubble
                  senderName={i18n._(t`Alex`)}
                  senderGender={0}
                  message={i18n._(t`This is how your messages will look in chat.`)}
                  isSent={false}
                  showAvatar={true}
                  showName={true}
                />
              </div>
            </div>
          </IonItem>
        </IonList>
      </IonContent>
    </IonPage>
  );
}

export default function GeneralSettingsPage() {
  return <GeneralSettingsCore />;
}
