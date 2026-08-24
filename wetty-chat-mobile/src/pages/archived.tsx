import { IonButtons, IonHeader, IonPage, IonToolbar } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { useHistory, useParams } from 'react-router-dom';
import { ChatList } from '@/components/chat/lists/ChatList';
import { TitleWithConnectionStatus } from '@/components/TitleWithConnectionStatus';
import { BackButton } from '@/components/BackButton';
import type { ChatListTab } from '@/components/chat/lists/ChatListSegment';

function normalizeTab(tab?: string): ChatListTab {
  if (tab === 'threads' || tab === 'groups' || tab === 'messages') {
    return tab;
  }
  return 'messages';
}

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
        key={normalizeTab(tab)}
        archivedMode
        initialTab={normalizeTab(tab)}
        onChatSelect={(chatId, resumeHash) => history.push({ pathname: `/chats/chat/${chatId}`, hash: resumeHash })}
        onThreadSelect={(chatId, threadRootId) => history.push(`/chats/chat/${chatId}/thread/${threadRootId}`)}
      />
    </IonPage>
  );
}
