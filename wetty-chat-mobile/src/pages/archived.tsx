import { IonButtons, IonHeader, IonPage, IonToolbar } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { useHistory, useParams } from 'react-router-dom';
import { ChatList } from '@/components/chat/lists/ChatList';
import { TitleWithConnectionStatus } from '@/components/TitleWithConnectionStatus';
import { BackButton } from '@/components/BackButton';
import { normalizeChatListTab } from '@/components/chat/lists/ChatListSegment';

interface ArchivedPageParams {
  tab?: string;
}

export default function ArchivedPage() {
  const history = useHistory();
  const { tab } = useParams<ArchivedPageParams>();

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <BackButton action={{ type: 'back', defaultHref: '/chats' }} />
          </IonButtons>
          <TitleWithConnectionStatus>
            <Trans>Archived</Trans>
          </TitleWithConnectionStatus>
        </IonToolbar>
      </IonHeader>
      <ChatList
        key={normalizeChatListTab(tab)}
        archivedMode
        initialTab={normalizeChatListTab(tab)}
        onChatSelect={(chatId, resumeHash) => history.push({ pathname: `/chats/chat/${chatId}`, hash: resumeHash })}
        onThreadSelect={(chatId, threadRootId) => history.push(`/chats/chat/${chatId}/thread/${threadRootId}`)}
      />
    </IonPage>
  );
}
