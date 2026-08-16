import { useCallback, useEffect, useState } from 'react';
import { IonItem, IonLabel, IonList, IonListHeader } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch } from '@/store';
import { fetchIncomingRequests, selectIncomingRequests, selectOutgoingRequests } from '@/store/socialSlice';
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
export function IncomingRequestRow({
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

/**
 * Section shown above the DM list on the Friends tab: pending
 * incoming/outgoing friend requests. The add-friend entry lives in the
 * header action menu instead. Hosts its own profile modal.
 */
export function FriendsTabSection() {
  const dispatch = useDispatch<AppDispatch>();
  const incoming = useSelector(selectIncomingRequests);
  const outgoing = useSelector(selectOutgoingRequests);
  const [profileUser, setProfileUser] = useState<User | null>(null);

  useEffect(() => {
    // Always refetch while the tab is visible: the recipient may have missed
    // the friendRequestReceived WS event (backgrounded PWA, reconnect gap).
    dispatch(fetchIncomingRequests());
  }, [dispatch]);

  const openProfile = useCallback((member: MemberSummary) => {
    setProfileUser(memberSummaryToUser(member));
  }, []);

  if (incoming.length === 0 && outgoing.length === 0) {
    return null;
  }

  return (
    <>
      {incoming.length > 0 && (
        <IonList inset>
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
        <IonList inset>
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

      <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
    </>
  );
}
