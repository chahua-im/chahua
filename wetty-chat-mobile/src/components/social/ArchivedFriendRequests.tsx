import { useCallback, useEffect, useState } from 'react';
import { IonContent, IonItem, IonLabel, IonList } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { useDispatch, useSelector } from 'react-redux';
import type { User } from '@/api/messages';
import type { MemberSummary } from '@/api/users';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import type { AppDispatch } from '@/store';
import { fetchArchivedRequests, selectArchivedRequests } from '@/store/socialSlice';
import { memberSummaryToUser } from '@/utils/userConvert';
import { FriendRequestRow } from './PendingFriendRequests';
import { useFriendRequestActions } from './useFriendRequestActions';

export function ArchivedFriendRequests() {
  const dispatch = useDispatch<AppDispatch>();
  const requests = useSelector(selectArchivedRequests);
  const { acceptRequest, rejectRequest } = useFriendRequestActions();
  const [profileUser, setProfileUser] = useState<User | null>(null);

  useEffect(() => {
    dispatch(fetchArchivedRequests());
  }, [dispatch]);

  const openProfile = useCallback((member: MemberSummary) => {
    setProfileUser(memberSummaryToUser(member));
  }, []);

  return (
    <IonContent fullscreen>
      <IonList>
        {requests.length === 0 ? (
          <IonItem lines="none">
            <IonLabel color="medium" className="ion-text-wrap">
              <Trans>No archived friend requests</Trans>
            </IonLabel>
          </IonItem>
        ) : (
          requests.map((request) => (
            <FriendRequestRow
              key={request.id}
              request={request}
              onOpenProfile={openProfile}
              actions={
                request.direction === 'incoming' && request.status === 'archived'
                  ? {
                      onAccept: () => void acceptRequest(request.id),
                      onReject: () => void rejectRequest(request.id, request.from.uid),
                    }
                  : undefined
              }
            />
          ))
        )}
      </IonList>
      <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
    </IonContent>
  );
}
