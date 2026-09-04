import { useCallback, useState } from 'react';
import { IonButton, IonItem, IonLabel, IonNote } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { useSelector } from 'react-redux';
import type { FriendRequestHistoryEntry } from '@/api/friends';
import type { User } from '@/api/messages';
import type { MemberSummary } from '@/api/users';
import { UserAvatar } from '@/components/UserAvatar';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { selectPendingRequests } from '@/store/socialSlice';
import { memberSummaryToUser } from '@/utils/userConvert';
import { useFriendRequestActions } from './useFriendRequestActions';
import styles from './PendingFriendRequests.module.scss';

function FriendRequestRow({
  request,
  onOpenProfile,
  onAccept,
  onReject,
}: {
  request: FriendRequestHistoryEntry;
  onOpenProfile: (member: MemberSummary) => void;
  onAccept: (request: FriendRequestHistoryEntry) => void;
  onReject: (request: FriendRequestHistoryEntry) => void;
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
      {incoming ? (
        <div slot="end" className={styles.requestActions} onClick={(event) => event.stopPropagation()}>
          <IonButton size="small" fill="solid" color="primary" onClick={() => onAccept(request)}>
            {t`Accept`}
          </IonButton>
          <IonButton size="small" fill="outline" color="danger" onClick={() => onReject(request)}>
            {t`Reject`}
          </IonButton>
        </div>
      ) : (
        <IonNote slot="end" color="medium" className={styles.statusNote}>
          {t`Pending approval`}
        </IonNote>
      )}
    </IonItem>
  );
}

export function PendingFriendRequests() {
  const requests = useSelector(selectPendingRequests);
  const { acceptRequest, rejectRequest } = useFriendRequestActions();
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
          onAccept={(entry) => void acceptRequest(entry.id)}
          onReject={(entry) => void rejectRequest(entry.id, entry.from.uid)}
        />
      ))}
      <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
    </>
  );
}
