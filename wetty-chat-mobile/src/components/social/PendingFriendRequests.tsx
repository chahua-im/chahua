import { useCallback, useState } from 'react';
import { IonButton, IonIcon, IonItem, IonLabel, IonNote } from '@ionic/react';
import { archiveOutline, checkmarkOutline, closeOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { useSelector } from 'react-redux';
import type { FriendRequestHistoryEntry, FriendRequestStatus } from '@/api/friends';
import type { User } from '@/api/messages';
import type { MemberSummary } from '@/api/users';
import { UserAvatar } from '@/components/UserAvatar';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { selectPendingRequests } from '@/store/socialSlice';
import { memberSummaryToUser } from '@/utils/userConvert';
import { useFriendRequestActions } from './useFriendRequestActions';
import styles from './PendingFriendRequests.module.scss';

function requestStatusLabel(status: FriendRequestStatus): string {
  switch (status) {
    case 'pending':
    case 'archived':
      return t`Pending approval`;
    case 'accepted':
      return t`Accepted`;
    case 'rejected':
      return t`Rejected`;
  }
}

export function FriendRequestRow({
  request,
  onOpenProfile,
  actions,
}: {
  request: FriendRequestHistoryEntry;
  onOpenProfile: (member: MemberSummary) => void;
  actions?: {
    onAccept: () => void;
    onReject: () => void;
    onArchive?: () => void;
  };
}) {
  const incoming = request.direction === 'incoming';
  const peer = incoming ? request.from : request.to;
  const displayName = peer.username || t`User ${peer.uid}`;
  const preview = request.question
    ? t`Q: ${request.question} · A: ${request.message ?? ''}`
    : request.message
      ? request.message
      : incoming
        ? t`Friend request`
        : t`Friend request sent`;
  return (
    <IonItem button detail={false} className={styles.chatListItem} onClick={() => onOpenProfile(peer)}>
      <span slot="start">
        <UserAvatar name={displayName} avatarUrl={peer.avatarUrl} size={48} className={styles.chatsListAvatar} />
      </span>
      <IonLabel className={styles.chatsListLabel}>
        <h3 className={styles.chatsListTitle}>
          <span className={styles.chatsListTitleText}>{displayName}</span>
        </h3>
        <p className={styles.chatsListPreview}>{preview}</p>
      </IonLabel>
      {actions ? (
        <div slot="end" className={styles.requestActions} onClick={(event) => event.stopPropagation()}>
          <IonButton
            size="small"
            fill="clear"
            color="primary"
            aria-label={t`Accept`}
            title={t`Accept`}
            onClick={actions.onAccept}
          >
            <IonIcon slot="icon-only" icon={checkmarkOutline} aria-hidden="true" />
          </IonButton>
          <IonButton
            size="small"
            fill="clear"
            color="danger"
            aria-label={t`Reject`}
            title={t`Reject`}
            onClick={actions.onReject}
          >
            <IonIcon slot="icon-only" icon={closeOutline} aria-hidden="true" />
          </IonButton>
          {actions.onArchive && (
            <IonButton
              size="small"
              fill="clear"
              color="medium"
              aria-label={t`Archive`}
              title={t`Archive`}
              onClick={actions.onArchive}
            >
              <IonIcon slot="icon-only" icon={archiveOutline} aria-hidden="true" />
            </IonButton>
          )}
        </div>
      ) : (
        <IonNote slot="end" color="medium" className={styles.statusNote}>
          {requestStatusLabel(request.status)}
        </IonNote>
      )}
    </IonItem>
  );
}

export function PendingFriendRequests() {
  const requests = useSelector(selectPendingRequests);
  const { acceptRequest, rejectRequest, archiveRequest } = useFriendRequestActions();
  const [profileUser, setProfileUser] = useState<User | null>(null);

  const openProfile = useCallback((member: MemberSummary) => {
    setProfileUser(memberSummaryToUser(member));
  }, []);

  return (
    <>
      {requests.map((request) => (
        <FriendRequestRow
          key={request.id}
          request={request}
          onOpenProfile={openProfile}
          actions={{
            onAccept: () => void acceptRequest(request.id),
            onReject: () => void rejectRequest(request.id, request.from.uid),
            onArchive: () => void archiveRequest(request.id),
          }}
        />
      ))}
      <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
    </>
  );
}
