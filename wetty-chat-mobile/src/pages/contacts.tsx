import { useCallback, useEffect, useState } from 'react';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch } from '@/store';
import {
  fetchFriends,
  fetchIncomingRequests,
  fetchOutgoingRequests,
  selectFriends,
  selectFriendsLoaded,
  selectIncomingRequests,
  selectOutgoingRequests,
  selectRequestsLoaded,
} from '@/store/socialSlice';
import { ChatMemberRow } from '@/components/chat-members/ChatMemberRow';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { AddFriendModal } from '@/components/social/AddFriendModal';
import { BackButton } from '@/components/BackButton';
import { memberSummaryToUser } from '@/utils/userConvert';
import type { BackAction } from '@/types/back-action';
import type { User } from '@/api/messages';
import type { MemberSummary } from '@/api/users';

interface ContactsCoreProps {
  backAction?: BackAction;
}

function ContactsCore({ backAction }: ContactsCoreProps) {
  const dispatch = useDispatch<AppDispatch>();
  const friends = useSelector(selectFriends);
  const incoming = useSelector(selectIncomingRequests);
  const outgoing = useSelector(selectOutgoingRequests);
  const friendsLoaded = useSelector(selectFriendsLoaded);
  const requestsLoaded = useSelector(selectRequestsLoaded);
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (!friendsLoaded) dispatch(fetchFriends());
    if (!requestsLoaded) {
      dispatch(fetchIncomingRequests());
      dispatch(fetchOutgoingRequests());
    }
  }, [friendsLoaded, requestsLoaded, dispatch]);

  const openProfile = useCallback((member: MemberSummary) => {
    setProfileUser(memberSummaryToUser(member));
  }, []);

  const handleSearchSelect = useCallback(
    (member: MemberSummary) => {
      setSearchOpen(false);
      openProfile(member);
    },
    [openProfile],
  );

  return (
    <div className="ion-page">
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">{backAction && <BackButton action={backAction} />}</IonButtons>
          <IonTitle>
            <Trans>Contacts</Trans>
          </IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => setSearchOpen(true)}>
              <Trans>Add</Trans>
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent color="light">
        {incoming.length > 0 ? (
          <IonList inset>
            <IonListHeader>
              <IonLabel>
                <Trans>Friend Requests</Trans>
              </IonLabel>
            </IonListHeader>
            {incoming.map((req) => (
              <ChatMemberRow
                key={`in-${req.id}`}
                member={req.from}
                subtitle={t`Friend request`}
                onSelect={openProfile}
              />
            ))}
          </IonList>
        ) : null}

        {outgoing.length > 0 ? (
          <IonList inset>
            <IonListHeader>
              <IonLabel>
                <Trans>Outgoing Requests</Trans>
              </IonLabel>
            </IonListHeader>
            {outgoing.map((req) => (
              <ChatMemberRow
                key={`out-${req.id}`}
                member={req.to}
                subtitle={t`Pending`}
                onSelect={openProfile}
              />
            ))}
          </IonList>
        ) : null}

        <IonList inset>
          <IonListHeader>
            <IonLabel>
              <Trans>Friends</Trans>
            </IonLabel>
          </IonListHeader>
          {friends.length === 0 ? (
            <IonItem lines="none">
              <IonLabel color="medium" className="ion-text-wrap">
                <Trans>No friends yet. Tap Add to find someone.</Trans>
              </IonLabel>
            </IonItem>
          ) : (
            friends.map((friend) => (
              <ChatMemberRow
                key={`friend-${friend.user.uid}`}
                member={friend.user}
                onSelect={openProfile}
              />
            ))
          )}
        </IonList>

        <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
        <AddFriendModal
          isOpen={searchOpen}
          onDismiss={() => setSearchOpen(false)}
          onSelect={handleSearchSelect}
        />
      </IonContent>
    </div>
  );
}

export function ContactsPage() {
  return (
    <IonPage>
      <ContactsCore />
    </IonPage>
  );
}

export default ContactsPage;
