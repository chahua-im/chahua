import { IonButtons, IonHeader, IonPage, IonToolbar } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { useHistory } from 'react-router-dom';
import { ChatList } from '@/components/chat/lists/ChatList';
import { TitleWithConnectionStatus } from '@/components/TitleWithConnectionStatus';
import { BackButton } from '@/components/BackButton';
import type { ChatListTab } from '@/components/chat/lists/chatListTabs';

export default function ArchivedPage({ initialTab }: { initialTab: ChatListTab }) {
  const history = useHistory();

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
        key={initialTab}
        archivedMode
        initialTab={initialTab}
        onChatSelect={(chatId, resumeHash) => history.push({ pathname: `/chats/chat/${chatId}`, hash: resumeHash })}
        onThreadSelect={(chatId, threadRootId) => history.push(`/chats/chat/${chatId}/thread/${threadRootId}`)}
      />
    </IonPage>
  );
}
