import { useCallback, useEffect, useState } from 'react';
import { IonButton, IonContent, IonItem, IonLabel, IonList, IonNote } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useDispatch, useSelector } from 'react-redux';
import { Virtuoso } from 'react-virtuoso';
import type { FriendRequestHistoryEntry } from '@/api/friends';
import type { User } from '@/api/messages';
import type { MemberSummary } from '@/api/users';
import { UserAvatar } from '@/components/UserAvatar';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import type { AppDispatch } from '@/store';
import { fetchRequestHistory, selectRequestHistory } from '@/store/socialSlice';
import { memberSummaryToUser } from '@/utils/userConvert';
import { useFriendRequestActions } from './useFriendRequestActions';
import styles from './FriendRequestsList.module.scss';

function RequestHistoryRow({
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
  const pending = request.status === 'pending';

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
      {pending && incoming ? (
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
          {pending ? t`Pending approval` : request.status === 'accepted' ? t`Accepted` : t`Rejected`}
        </IonNote>
      )}
    </IonItem>
  );
}

export function FriendRequestsList() {
  const dispatch = useDispatch<AppDispatch>();
  const requestHistory = useSelector(selectRequestHistory);
  const { acceptRequest, rejectRequest } = useFriendRequestActions();
  const [profileUser, setProfileUser] = useState<User | null>(null);

  useEffect(() => {
    // History is never persisted; refetch on entry so a missed WS event cannot leave stale rows.
    dispatch(fetchRequestHistory());
  }, [dispatch]);

  const openProfile = useCallback((member: MemberSummary) => {
    setProfileUser(memberSummaryToUser(member));
  }, []);

  return (
    <IonContent fullscreen scrollY={false} className={styles.content}>
      {requestHistory.length === 0 ? (
        <IonList>
          <IonItem lines="none">
            <IonLabel color="medium" className="ion-text-wrap">
              <Trans>No friend requests</Trans>
            </IonLabel>
          </IonItem>
        </IonList>
      ) : (
        <Virtuoso
          className={`ion-content-scroll-host ${styles.scrollHost}`}
          data={requestHistory}
          itemContent={(_, request) => (
            <RequestHistoryRow
              request={request}
              onOpenProfile={openProfile}
              onAccept={(entry) => void acceptRequest(entry.id)}
              onReject={(entry) => void rejectRequest(entry.id, entry.from.uid)}
            />
          )}
        />
      )}
      <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
    </IonContent>
  );
}
