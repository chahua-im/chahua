import { useCallback, useEffect, useState } from 'react';
import { IonContent, IonItem, IonLabel, IonList, IonListHeader } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch } from '@/store';
import {
  fetchIncomingRequests,
  fetchOutgoingRequests,
  selectIncomingRequests,
  selectOutgoingRequests,
} from '@/store/socialSlice';
import { UserAvatar } from '@/components/UserAvatar';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { memberSummaryToUser } from '@/utils/userConvert';
import type { FriendRequestResponse } from '@/api/friends';
import type { User } from '@/api/messages';
import type { MemberSummary } from '@/api/users';

/**
 * Incoming request row that surfaces the requester's verification message or
 * the target's question + the requester's answer, so the recipient can review
 * before accepting. Falls back to a plain "Friend request" label for direct.
 */
function IncomingRequestRow({
  req,
  onSelect,
}: {
  req: FriendRequestResponse;
  onSelect: (member: MemberSummary) => void;
}) {
  const member = req.from;
  const displayName = member.username || t`User ${member.uid}`;
  return (
    <IonItem button detail={false} onClick={() => onSelect(member)}>
      <UserAvatar name={displayName} avatarUrl={member.avatarUrl} size={40} />
      <IonLabel className="ion-text-wrap">
        <h3>{displayName}</h3>
        {req.question ? (
          <>
            <p>{t`Question: ${req.question}`}</p>
            <p>{t`Answer: ${req.message ?? ''}`}</p>
          </>
        ) : req.message ? (
          <p>{req.message}</p>
        ) : (
          <p>{t`Friend request`}</p>
        )}
      </IonLabel>
    </IonItem>
  );
}

export function FriendRequestsList() {
  const dispatch = useDispatch<AppDispatch>();
  const incoming = useSelector(selectIncomingRequests);
  const outgoing = useSelector(selectOutgoingRequests);
  const [profileUser, setProfileUser] = useState<User | null>(null);

  useEffect(() => {
    // Requests are never persisted; refetch both directions on entry so a missed
    // friendRequestReceived / friendRequestResolved WS event cannot leave stale rows.
    dispatch(fetchIncomingRequests());
    dispatch(fetchOutgoingRequests());
  }, [dispatch]);

  const openProfile = useCallback((member: MemberSummary) => {
    setProfileUser(memberSummaryToUser(member));
  }, []);

  return (
    <IonContent fullscreen>
      {incoming.length === 0 && outgoing.length === 0 ? (
        <IonList>
          <IonItem lines="none">
            <IonLabel color="medium" className="ion-text-wrap">
              <Trans>No pending friend requests</Trans>
            </IonLabel>
          </IonItem>
        </IonList>
      ) : (
        <>
          {incoming.length > 0 && (
            <IonList>
              <IonListHeader>
                <IonLabel>
                  <Trans>Friend Requests</Trans>
                </IonLabel>
              </IonListHeader>
              {incoming.map((req) => (
                <IncomingRequestRow key={`in-${req.id}`} req={req} onSelect={openProfile} />
              ))}
            </IonList>
          )}

          {outgoing.length > 0 && (
            <IonList>
              <IonListHeader>
                <IonLabel>
                  <Trans>Outgoing Requests</Trans>
                </IonLabel>
              </IonListHeader>
              {outgoing.map((req) => (
                <IonItem key={`out-${req.id}`} onClick={() => openProfile(req.to)}>
                  <UserAvatar name={req.to.username || t`User ${req.to.uid}`} avatarUrl={req.to.avatarUrl} size={40} />
                  <IonLabel className="ion-text-wrap">
                    <h3>{req.to.username || t`User ${req.to.uid}`}</h3>
                    <p>{t`Pending`}</p>
                  </IonLabel>
                </IonItem>
              ))}
            </IonList>
          )}
        </>
      )}

      <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
    </IonContent>
  );
}
