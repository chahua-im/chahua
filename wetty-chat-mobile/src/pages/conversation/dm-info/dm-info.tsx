import { useCallback, useEffect, useState } from 'react';
import {
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
  useIonAlert,
  useIonToast,
} from '@ionic/react';
import { banOutline, personRemoveOutline, searchOutline } from 'ionicons/icons';
import { useDispatch, useSelector } from 'react-redux';
import { useHistory, useParams } from 'react-router-dom';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageResponse, User } from '@/api/messages';
import { friendsApi } from '@/api/friends';
import { blocksApi } from '@/api/blocks';
import { BackButton } from '@/components/BackButton';
import { ChatAttachmentSection } from '@/components/chat/attachments/ChatAttachmentSection';
import { ChatMessageSearchPanel } from '@/components/chat/search/ChatMessageSearchPanel';
import { ChatMuteSettingItem } from '@/components/chat/settings/ChatMuteSettingItem';
import { GroupSettingsActionButton } from '@/components/chat/settings/GroupSettingsActionButton';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { FeatureGate } from '@/components/FeatureGate';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useGroupInfoMetadata } from '@/pages/conversation/group-info/useGroupInfoMetadata';
import { selectChatMeta } from '@/store/chatsSlice';
import {
  fetchBlocks,
  fetchFriends,
  selectBlocksLoaded,
  selectFriendsLoaded,
  selectIsBlocked,
  selectIsFriend,
} from '@/store/socialSlice';
import type { AppDispatch, RootState } from '@/store';
import type { BackAction } from '@/types/back-action';
import { buildChatMessageNavigationTarget } from '@/utils/chatNavigationTarget';
import { getChatDisplayName } from '@/utils/chatDisplay';
import { memberSummaryToUser } from '@/utils/userConvert';
import { PeerProfileHeader } from './PeerProfileHeader';
import styles from './DmInfo.module.scss';

type DmInfoMode = 'info' | 'search';

interface DmInfoCoreProps {
  chatId?: string;
  backAction?: BackAction;
}

function DmInfoSession({ chatId, backAction }: { chatId: string; backAction?: BackAction }) {
  const history = useHistory();
  const dispatch = useDispatch<AppDispatch>();
  const [presentAlert] = useIonAlert();
  const [presentToast] = useIonToast();
  const { archived, loading, mutedUntil } = useGroupInfoMetadata(chatId);
  const [mode, setMode] = useState<DmInfoMode>('info');
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const peer = useSelector((state: RootState) => selectChatMeta(state, chatId))?.peer ?? null;
  const friendsEnabled = useFeatureGate('friends');
  const blockEnabled = useFeatureGate('userBlock');
  const peerUid = peer?.uid ?? 0;
  const isFriend = useSelector((state: RootState) =>
    friendsEnabled && peerUid > 0 ? selectIsFriend(state, peerUid) : false,
  );
  const isBlocked = useSelector((state: RootState) =>
    blockEnabled && peerUid > 0 ? selectIsBlocked(state, peerUid) : false,
  );
  const friendsLoaded = useSelector(selectFriendsLoaded);
  const blocksLoaded = useSelector(selectBlocksLoaded);
  const displayName = peer?.username || (peerUid > 0 ? t`User ${peerUid}` : getChatDisplayName(chatId, null));

  useEffect(() => {
    if (peerUid <= 0) return;
    if (friendsEnabled && !friendsLoaded) dispatch(fetchFriends());
    if (blockEnabled && !blocksLoaded) dispatch(fetchBlocks());
  }, [peerUid, friendsEnabled, blockEnabled, friendsLoaded, blocksLoaded, dispatch]);

  const handleOpenSearchResult = useCallback(
    (message: MessageResponse) => {
      history.replace(
        buildChatMessageNavigationTarget({
          chatId,
          messageId: message.id,
          threadRootId: message.replyRootId,
        }),
      );
    },
    [chatId, history],
  );

  const runPeerAction = (opts: {
    header: string;
    message: string;
    confirmText: string;
    destructive: boolean;
    successMessage: string;
    action: () => Promise<void>;
  }) => {
    presentAlert({
      header: opts.header,
      message: opts.message,
      buttons: [
        { text: t`Cancel`, role: 'cancel' },
        {
          text: opts.confirmText,
          role: opts.destructive ? 'destructive' : undefined,
          handler: () => {
            setBusy(true);
            opts
              .action()
              .then(() => presentToast({ message: opts.successMessage, duration: 2000 }))
              .catch((err: Error) => presentToast({ message: err.message || t`Action failed`, duration: 2000 }))
              .finally(() => setBusy(false));
          },
        },
      ],
    });
  };

  const handleUnfriend = () => {
    runPeerAction({
      header: t`Remove Friend`,
      message: t`Remove ${displayName} from your friends?`,
      confirmText: t`Remove`,
      destructive: true,
      successMessage: t`Removed friend`,
      action: async () => {
        await friendsApi.removeFriend(peerUid);
        dispatch(fetchFriends());
      },
    });
  };

  const handleBlock = () => {
    runPeerAction({
      header: t`Block User`,
      message: t`Block ${displayName}? You won't be able to message each other.`,
      confirmText: t`Block`,
      destructive: true,
      successMessage: t`User blocked`,
      action: async () => {
        await blocksApi.blockUser(peerUid);
        dispatch(fetchBlocks());
      },
    });
  };

  const handleUnblock = () => {
    runPeerAction({
      header: t`Unblock User`,
      message: t`Unblock this user?`,
      confirmText: t`Unblock`,
      destructive: false,
      successMessage: t`User unblocked`,
      action: async () => {
        await blocksApi.unblockUser(peerUid);
        dispatch(fetchBlocks());
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
          <IonTitle>{mode === 'search' ? <Trans>Search</Trans> : <Trans>Chat Info</Trans>}</IonTitle>
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
          <>
            <PeerProfileHeader
              displayName={displayName}
              avatarUrl={peer?.avatarUrl}
              onOpenProfile={peer ? () => setProfileUser(memberSummaryToUser(peer)) : undefined}
            />
            <div className={styles.shareActions}>
              <FeatureGate feature="messageSearch">
                <GroupSettingsActionButton icon={searchOutline} onClick={() => setMode('search')}>
                  <Trans>Search</Trans>
                </GroupSettingsActionButton>
              </FeatureGate>
              <ChatMuteSettingItem chatId={chatId} mutedUntil={mutedUntil} archived={archived} />
            </div>
            <FeatureGate feature="chatAttachments">
              <ChatAttachmentSection chatId={chatId} />
            </FeatureGate>
            {peerUid > 0 && (
              <IonList inset>
                {blockEnabled && (
                  <IonItem button detail={false} disabled={busy} onClick={isBlocked ? handleUnblock : handleBlock}>
                    <IonIcon
                      aria-hidden="true"
                      icon={banOutline}
                      slot="start"
                      color={isBlocked ? 'medium' : 'danger'}
                    />
                    <IonLabel color={isBlocked ? 'medium' : 'danger'}>
                      {isBlocked ? <Trans>Unblock</Trans> : <Trans>Block</Trans>}
                    </IonLabel>
                  </IonItem>
                )}
                {friendsEnabled && isFriend && (
                  <IonItem button detail={false} disabled={busy} onClick={handleUnfriend}>
                    <IonIcon aria-hidden="true" icon={personRemoveOutline} slot="start" color="danger" />
                    <IonLabel color="danger">
                      <Trans>Unfriend</Trans>
                    </IonLabel>
                  </IonItem>
                )}
              </IonList>
            )}
            <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
          </>
        )}
      </IonContent>
    </IonPage>
  );
}

export default function DmInfoCore({ chatId: propChatId, backAction }: DmInfoCoreProps) {
  const { id } = useParams<{ id: string }>();
  const chatId = propChatId ?? (id ? String(id) : '');

  if (!chatId) {
    return null;
  }

  return <DmInfoSession key={chatId} chatId={chatId} backAction={backAction} />;
}

export function DmInfoPage() {
  const { id } = useParams<{ id: string }>();
  return <DmInfoCore chatId={id} backAction={{ type: 'back', defaultHref: `/chats/chat/${id}` }} />;
}
