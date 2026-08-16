import { useState } from 'react';
import { IonButtons, IonHeader, IonPage, IonToolbar } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { useHistory } from 'react-router-dom';
import { addCircleOutline } from 'ionicons/icons';
import { ChatList } from '@/components/chat/lists/ChatList';
import { HeaderActionMenu } from '@/components/HeaderActionMenu';
import { useHasGlobalPermission } from '@/hooks/useHasGlobalPermission';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { AddFriendModalHost } from '@/components/social/AddFriendModalHost';
import { TitleWithConnectionStatus } from '@/components/TitleWithConnectionStatus';

export default function Chats() {
  const canCreateChat = useHasGlobalPermission('chat.create');
  const friendsEnabled = useFeatureGate('friends');
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const history = useHistory();
  const menuActions = [
    ...(canCreateChat
      ? [
          {
            id: 'create-chat',
            label: <Trans>Create Group</Trans>,
            onSelect: () => history.push('/chats/new'),
          },
        ]
      : []),
    {
      id: 'join-via-code',
      label: <Trans>Join Group</Trans>,
      onSelect: () => history.push('/chats/join'),
    },
    ...(friendsEnabled
      ? [
          {
            id: 'add-friend',
            label: <Trans>Add Friend</Trans>,
            onSelect: () => setAddFriendOpen(true),
          },
        ]
      : []),
  ];

  return (
    <IonPage className="chats-page">
      <IonHeader>
        <IonToolbar>
          <TitleWithConnectionStatus>
            <Trans>Chats</Trans>
          </TitleWithConnectionStatus>
          <IonButtons slot="end">
            <HeaderActionMenu actions={menuActions} icon={addCircleOutline} />
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <ChatList
        onChatSelect={(chatId, resumeHash) => history.push({ pathname: `/chats/chat/${chatId}`, hash: resumeHash })}
        onThreadSelect={(chatId, threadRootId, resumeHash) =>
          history.push({ pathname: `/chats/chat/${chatId}/thread/${threadRootId}`, hash: resumeHash })
        }
      />
      <AddFriendModalHost open={addFriendOpen} onClose={() => setAddFriendOpen(false)} />
    </IonPage>
  );
}
