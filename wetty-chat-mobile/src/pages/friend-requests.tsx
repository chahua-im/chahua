import { IonButtons, IonHeader, IonPage, IonToolbar } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { BackButton } from '@/components/BackButton';
import { FriendRequestsList } from '@/components/social/FriendRequestsList';
import { TitleWithConnectionStatus } from '@/components/TitleWithConnectionStatus';

export default function FriendRequestsPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <BackButton action={{ type: 'back', defaultHref: '/chats' }} />
          </IonButtons>
          <TitleWithConnectionStatus>
            <Trans>Friend Requests</Trans>
          </TitleWithConnectionStatus>
        </IonToolbar>
      </IonHeader>
      <FriendRequestsList />
    </IonPage>
  );
}
