import { IonButton, IonButtons, IonHeader, IonIcon, IonProgressBar, IonTitle, IonToolbar } from '@ionic/react';
import { informationCircleOutline, notifications, notificationsOffOutline, people } from 'ionicons/icons';
import { useSelector } from 'react-redux';
import { BackButton } from '@/components/BackButton';
import type { RootState } from '@/store/index';
import type { BackAction } from '@/types/back-action';

interface ConversationHeaderProps {
  backAction?: BackAction;
  chatName: string;
  isMuted: boolean;
  threadId?: string;
  threadSubscribed: boolean | null;
  threadArchived: boolean;
  threadSubLoading: boolean;
  isDm: boolean;
  onOpenMembers: () => void;
  onOpenGroupInfo: () => void;
  onOpenPeerProfile?: () => void;
  onToggleThreadSubscription: () => void;
}

export function ConversationHeader({
  backAction,
  chatName,
  isMuted,
  threadId,
  threadSubscribed,
  threadArchived,
  threadSubLoading,
  isDm,
  onOpenMembers,
  onOpenGroupInfo,
  onOpenPeerProfile,
  onToggleThreadSubscription,
}: ConversationHeaderProps) {
  const wsConnected = useSelector((state: RootState) => state.connection.wsConnected);

  return (
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">{backAction && <BackButton action={backAction} />}</IonButtons>
        <IonTitle>
          <span className="conversation-title">
            <span>{chatName}</span>
            {isMuted && !threadId ? (
              <IonIcon aria-hidden="true" icon={notificationsOffOutline} className="conversation-title__icon" />
            ) : null}
          </span>
        </IonTitle>
        <IonButtons slot="end">
          {threadId ? (
            threadSubscribed != null && (
              <IonButton
                onClick={onToggleThreadSubscription}
                disabled={threadSubLoading}
                color={threadSubscribed && !threadArchived ? undefined : 'medium'}
              >
                <IonIcon
                  slot="icon-only"
                  icon={threadSubscribed && !threadArchived ? notifications : notificationsOffOutline}
                />
              </IonButton>
            )
          ) : isDm ? (
            <IonButton onClick={onOpenPeerProfile}>
              <IonIcon slot="icon-only" icon={informationCircleOutline} />
            </IonButton>
          ) : (
            <>
              <IonButton onClick={onOpenMembers}>
                <IonIcon slot="icon-only" icon={people} />
              </IonButton>
              <IonButton onClick={onOpenGroupInfo}>
                <IonIcon slot="icon-only" icon={informationCircleOutline} />
              </IonButton>
            </>
          )}
        </IonButtons>
        {!wsConnected && <IonProgressBar type="indeterminate" />}
      </IonToolbar>
    </IonHeader>
  );
}
