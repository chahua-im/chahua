import { useCallback, useRef, useState } from 'react';
import {
  useIonAlert,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import { exitOutline, linkOutline, searchOutline, settingsOutline } from 'ionicons/icons';
import { useHistory, useParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { leaveGroup, type GroupRole } from '@/api/group';
import type { MessageResponse } from '@/api/messages';
import { setChatInList } from '@/store/chatsSlice';
import type { RootState } from '@/store/index';
import { BackButton } from '@/components/BackButton';
import { GroupProfile } from '@/components/chat/profiles/GroupProfile';
import { ChatRoleGate } from '@/components/chat/permissions/ChatRoleGate';
import { ChatMuteSettingItem } from '@/components/chat/settings/ChatMuteSettingItem';
import type { BackAction } from '@/types/back-action';
import styles from './GroupInfo.module.scss';
import { ShareInviteModal } from '@/components/chat/settings/ShareInviteModal';
import { GroupSettingsActionButton } from '@/components/chat/settings/GroupSettingsActionButton';
import { ChatAttachmentSection } from '@/components/chat/attachments/ChatAttachmentSection';
import { ChatMessageSearchPanel } from '@/components/chat/search/ChatMessageSearchPanel';
import { useGroupInfoMetadata } from './useGroupInfoMetadata';
import { FeatureGate } from '@/components/FeatureGate';
import { buildMessageSearchTarget } from '@/utils/messageSearch';

interface GroupInfoCoreProps {
  chatId?: string;
  backAction?: BackAction;
}

interface GroupInfoContentProps {
  chatId: string;
  name: string;
  description: string;
  avatarUrl: string;
  mutedUntil: string | null;
  archived: boolean;
  myRole: GroupRole | null;
  leavingGroup: boolean;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onLeaveGroup: () => void;
}

function GroupInfoContent({
  chatId,
  name,
  description,
  avatarUrl,
  mutedUntil,
  archived,
  myRole,
  leavingGroup,
  onOpenSearch,
  onOpenSettings,
  onLeaveGroup,
}: GroupInfoContentProps) {
  const [shareModalOpen, setShareModalOpen] = useState(false);

  return (
    <>
      <GroupProfile
        chatId={chatId}
        name={name}
        description={description}
        avatarUrl={avatarUrl}
        avatarEditable={false}
      />

      <div className={styles.shareActions}>
        <FeatureGate feature="messageSearch">
          <GroupSettingsActionButton icon={searchOutline} onClick={onOpenSearch}>
            <Trans>Search</Trans>
          </GroupSettingsActionButton>
        </FeatureGate>

        <ChatMuteSettingItem chatId={chatId} mutedUntil={mutedUntil} archived={archived} />

        <ChatRoleGate chatId={chatId} allow="admin" role={myRole}>
          <GroupSettingsActionButton icon={linkOutline} onClick={() => setShareModalOpen(true)}>
            <Trans>Invite</Trans>
          </GroupSettingsActionButton>
        </ChatRoleGate>
      </div>

      <ChatRoleGate chatId={chatId} allow="admin" role={myRole}>
        <IonList inset>
          <IonItem button detail={true} onClick={onOpenSettings}>
            <IonIcon aria-hidden="true" icon={settingsOutline} slot="start" color="primary" />
            <IonLabel>
              <Trans>Settings</Trans>
            </IonLabel>
          </IonItem>
        </IonList>
      </ChatRoleGate>

      <FeatureGate feature="chatAttachments">
        <ChatAttachmentSection chatId={chatId} />
      </FeatureGate>

      <IonList inset>
        <IonItem button detail={false} disabled={leavingGroup} onClick={onLeaveGroup}>
          <IonIcon aria-hidden="true" icon={exitOutline} slot="start" color="danger" />
          <IonLabel color="danger">{leavingGroup ? <Trans>Leaving...</Trans> : <Trans>Leave Group</Trans>}</IonLabel>
        </IonItem>
      </IonList>

      {myRole === 'admin' ? (
        <ShareInviteModal isOpen={shareModalOpen} chatId={chatId} onDismiss={() => setShareModalOpen(false)} />
      ) : null}
    </>
  );
}

type GroupInfoMode = 'info' | 'search';

function GroupInfoSession({ chatId, backAction }: { chatId: string; backAction?: BackAction }) {
  const history = useHistory();
  const dispatch = useDispatch();
  const [presentToast] = useIonToast();
  const [presentAlert, dismissAlert] = useIonAlert();
  const currentUserId = useSelector((state: RootState) => state.user.uid);
  const { archived, formState, loading, mutedUntil } = useGroupInfoMetadata(chatId);
  const [mode, setMode] = useState<GroupInfoMode>('info');
  const [leavingGroup, setLeavingGroup] = useState(false);
  const alertHistoryStateRef = useRef(false);
  const alertClosedByHistoryRef = useRef(false);

  const handleOpenSearchResult = useCallback(
    (message: MessageResponse) => {
      history.replace(buildMessageSearchTarget(chatId, message));
    },
    [chatId, history],
  );

  const handleLeaveGroup = () => {
    if (!currentUserId || leavingGroup) {
      return;
    }

    if (!alertHistoryStateRef.current) {
      window.history.pushState({ alertOpen: true }, '', window.location.href);
      alertHistoryStateRef.current = true;
    }

    const handlePopState = () => {
      if (!alertHistoryStateRef.current) {
        return;
      }

      alertClosedByHistoryRef.current = true;
      alertHistoryStateRef.current = false;
      void dismissAlert();
    };

    window.addEventListener('popstate', handlePopState);

    presentAlert({
      header: t`Leave Group`,
      message: t`Are you sure you want to leave this group?`,
      backdropDismiss: true,
      buttons: [
        { text: t`Cancel`, role: 'cancel' },
        {
          text: t`Leave`,
          role: 'destructive',
          handler: () => {
            alertHistoryStateRef.current = false;
            setLeavingGroup(true);
            leaveGroup(chatId, currentUserId)
              .then(() => {
                dispatch(setChatInList({ chatId, inList: false }));
                presentToast({ message: t`Left group`, duration: 2000 });
                history.replace('/chats');
              })
              .catch((err: Error) => {
                presentToast({ message: err.message || t`Failed to leave group`, duration: 3000 });
              })
              .finally(() => setLeavingGroup(false));
          },
        },
      ],
      onDidDismiss: () => {
        window.removeEventListener('popstate', handlePopState);

        if (alertClosedByHistoryRef.current) {
          alertClosedByHistoryRef.current = false;
          return;
        }

        if (alertHistoryStateRef.current) {
          alertHistoryStateRef.current = false;
          window.history.back();
        }
      },
    });
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            {mode === 'search' ? (
              <BackButton action={{ type: 'callback', onBack: () => setMode('info') }} />
            ) : (
              backAction && <BackButton action={backAction} />
            )}
          </IonButtons>
          <IonTitle>{mode === 'search' ? <Trans>Search</Trans> : <Trans>Group Info</Trans>}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light" className="ion-no-padding">
        {mode === 'search' ? (
          <ChatMessageSearchPanel chatId={chatId} onOpenMessage={handleOpenSearchResult} />
        ) : loading ? (
          <div className={styles.loadingState}>
            <IonSpinner />
          </div>
        ) : (
          <GroupInfoContent
            chatId={chatId}
            name={formState.name}
            description={formState.description}
            avatarUrl={formState.avatarUrl}
            mutedUntil={mutedUntil}
            archived={archived}
            myRole={formState.myRole}
            leavingGroup={leavingGroup}
            onOpenSearch={() => setMode('search')}
            onOpenSettings={() => history.push(`/chats/chat/${chatId}/group-info/settings`)}
            onLeaveGroup={handleLeaveGroup}
          />
        )}
      </IonContent>
    </IonPage>
  );
}

export default function GroupInfoCore({ chatId: propChatId, backAction }: GroupInfoCoreProps) {
  const { id } = useParams<{ id: string }>();
  const chatId = propChatId ?? (id ? String(id) : '');

  if (!chatId) {
    return null;
  }

  return <GroupInfoSession key={chatId} chatId={chatId} backAction={backAction} />;
}

export function GroupInfoPage() {
  const { id } = useParams<{ id: string }>();
  return <GroupInfoCore chatId={id} backAction={{ type: 'back', defaultHref: `/chats/chat/${id}` }} />;
}
