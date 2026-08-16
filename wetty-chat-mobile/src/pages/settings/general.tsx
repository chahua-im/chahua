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
  selectLocale,
  selectMessageFontSize,
  selectShowAllAvatars,
  selectShowAllTab,
  selectShowFriendsTab,
  selectShowGroupsTab,
  selectShowThreadsTab,
  setMessageFontSize,
  setShowAllTab,
  setShowGroupsTab,
  setShowFriendsTab,
  setShowThreadsTab,
  setShowAllAvatars,
} from '@/store/settingsSlice';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import type { BackAction } from '@/types/back-action';
import styles from './GeneralSettings.module.scss';

interface GeneralSettingsCoreProps {
  backAction?: BackAction;
  onOpenLanguage?: () => void;
}

const localeLabels: Record<string, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
};

export function GeneralSettingsCore({ backAction, onOpenLanguage }: GeneralSettingsCoreProps) {
  const dispatch = useDispatch();
  const history = useHistory();
  const locale = useSelector(selectLocale);
  const messageFontSize = useSelector(selectMessageFontSize);
  const showAllTab = useSelector(selectShowAllTab);
  const showGroupsTab = useSelector(selectShowGroupsTab);
  const showFriendsTab = useSelector(selectShowFriendsTab);
  const showThreadsTab = useSelector(selectShowThreadsTab);
  const friendsEnabled = useFeatureGate('friends');
  const showAllAvatars = useSelector(selectShowAllAvatars);
  const sliderValue = chatFontSizeOptions.indexOf(messageFontSize);

  const handleOpenLanguage = () => {
    if (onOpenLanguage) {
      onOpenLanguage();
      return;
    }
    history.push('/settings/language');
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
          <IonItem>
            <IonToggle checked={showAllTab} onIonChange={(e) => dispatch(setShowAllTab(e.detail.checked))}>
              <Trans>Show "All" Tab in Chats</Trans>
            </IonToggle>
          </IonItem>
          <IonItem>
            <IonToggle checked={showGroupsTab} onIonChange={(e) => dispatch(setShowGroupsTab(e.detail.checked))}>
              <Trans>Show "Groups" Tab in Chats</Trans>
            </IonToggle>
          </IonItem>
          {friendsEnabled && (
            <IonItem>
              <IonToggle checked={showFriendsTab} onIonChange={(e) => dispatch(setShowFriendsTab(e.detail.checked))}>
                <Trans>Show "Friends" Tab in Chats</Trans>
              </IonToggle>
            </IonItem>
          )}
          <IonItem>
            <IonToggle checked={showThreadsTab} onIonChange={(e) => dispatch(setShowThreadsTab(e.detail.checked))}>
              <Trans>Show "Threads" Tab in Chats</Trans>
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
