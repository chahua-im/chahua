import { IonButtons, IonHeader, IonPage, IonToolbar } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { BackButton } from '@/components/BackButton';
import { ArchivedFriendRequests } from '@/components/social/ArchivedFriendRequests';
import { TitleWithConnectionStatus } from '@/components/TitleWithConnectionStatus';

export default function ArchivedFriendRequestsPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <BackButton action={{ type: 'back', defaultHref: '/chats/friends' }} />
          </IonButtons>
          <TitleWithConnectionStatus>
            <Trans>Friend Requests</Trans>
          </TitleWithConnectionStatus>
        </IonToolbar>
      </IonHeader>
      <ArchivedFriendRequests />
    </IonPage>
  );
}
