import { IonBadge, IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/react';
import { Trans } from '@lingui/react/macro';
import { chatbubbles, flask, settings } from 'ionicons/icons';
import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { Redirect, Route, useLocation, matchPath } from 'react-router-dom';

import ChatsPage from '@/pages/chats';
import ArchivedPage from '@/pages/archived';
import ThreadsPage from '@/pages/threads';
import { CreateChatPage } from '@/pages/create-chat';
import InvitePreviewPage from '@/pages/invite-preview';
import JoinChatPage from '@/pages/join-chat';
import { ChatThreadPage } from '@/pages/chat-thread/chat-thread';
import { GroupInfoPage, GroupSavedMessagesPage, GroupSettingsPage } from '@/pages/chat-thread/group-info';
import { ChatMembersPage } from '@/pages/chat-thread/chat-members';
import { ChatInvitesPage } from '@/pages/chat-thread/manage-invites';
import SettingsPage from '@/pages/settings';
import SavedMessagesPage from '@/pages/saved-messages';
import GeneralSettingsPage from '@/pages/settings/general';
import LanguagePage from '@/pages/settings/language';
import StickerSettingsPage from '@/pages/settings/stickers';
import StickerPackDetailPage from '@/pages/settings/sticker-pack-detail';
import NotFoundPage from '@/pages/not-found';
import ComponentDemoPage from '@/pages/component-demo';

import { safariSafeRouteAnimation } from '@/utils/navigationHistory';
import { formatUnreadBadge } from '@/utils/unreadBadge';
import { featureGatedList, whenFeature } from '@/features';
import { selectTotalUnreadChatCount } from '@/store/chatsSlice';
import styles from './MobileLayout.module.scss';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

const TAB_ROOT_PATHS = ['/', '/chats', '/settings', '/demo'];

const MobileLayout: React.FC = () => {
  const location = useLocation();
  const unreadChatCount = useSelector(selectTotalUnreadChatCount);
  const isTabRoot = TAB_ROOT_PATHS.includes(location.pathname);
  const chatMatch = matchPath<{ id: string }>(location.pathname, { path: '/chats/chat/:id', exact: true });
  useDocumentTitle(chatMatch?.params.id);

  const tabBarButtons = useMemo(() => {
    return featureGatedList([
      <IonTabButton tab="chats" href="/chats" key="chats">
        <IonIcon icon={chatbubbles} />
        <IonLabel>
          <Trans>Chats</Trans>
        </IonLabel>
        {unreadChatCount > 0 && <IonBadge color="primary">{formatUnreadBadge(unreadChatCount)}</IonBadge>}
      </IonTabButton>,
      <IonTabButton tab="settings" href="/settings" key="settings">
        <IonIcon icon={settings} />
        <IonLabel>
          <Trans>Settings</Trans>
        </IonLabel>
      </IonTabButton>,
      whenFeature(
        'demoPage',
        <IonTabButton tab="demo" href="/demo" key="demo">
          <IonIcon icon={flask} />
          <IonLabel>Demo</IonLabel>
        </IonTabButton>,
      ),
    ]);
  }, [unreadChatCount]);

  return (
    <IonTabs className={`${isTabRoot ? '' : styles.tabBarHidden}`}>
      <IonRouterOutlet animation={safariSafeRouteAnimation}>
        <Route path="/chats" exact component={ChatsPage} />
        <Route path="/chats/archived/:tab?" exact component={ArchivedPage} />
        <Route path="/chats/threads" exact component={ThreadsPage} />
        <Route path="/chats/new" exact component={CreateChatPage} />
        <Route path="/chats/join" exact component={JoinChatPage} />
        <Route path="/chats/join/:inviteCode" exact component={InvitePreviewPage} />
        <Route path="/chats/chat/:id" exact component={ChatThreadPage} />
        <Route path="/chats/chat/:id/thread/:threadId" exact component={ChatThreadPage} />
        {whenFeature(
          'savedMessages',
          <Route path="/chats/chat/:id/group-info/saved-messages" exact component={GroupSavedMessagesPage} />,
        )}
        <Route path="/chats/chat/:id/group-info/settings" exact component={GroupSettingsPage} />
        <Route path="/chats/chat/:id/group-info" exact component={GroupInfoPage} />
        <Route path="/chats/chat/:id/invites" exact component={ChatInvitesPage} />
        <Route path="/chats/chat/:id/members" exact component={ChatMembersPage} />
        <Route path="/chats/chat/:id/stickers/:packId" exact component={StickerPackDetailPage} />
        <Route path="/demo" exact component={ComponentDemoPage} />
        <Route path="/settings/general" exact component={GeneralSettingsPage} />
        <Route path="/settings/language" exact component={LanguagePage} />
        {whenFeature('savedMessages', <Route path="/settings/saved-messages" exact component={SavedMessagesPage} />)}
        <Route path="/settings/stickers/:packId" exact component={StickerPackDetailPage} />
        <Route path="/settings/stickers" exact component={StickerSettingsPage} />
        <Route path="/settings" exact component={SettingsPage} />
        <Redirect exact from="/" to="/chats" />
        <Route component={NotFoundPage} />
      </IonRouterOutlet>
      <IonTabBar slot="bottom">{tabBarButtons}</IonTabBar>
    </IonTabs>
  );
};

export default MobileLayout;
