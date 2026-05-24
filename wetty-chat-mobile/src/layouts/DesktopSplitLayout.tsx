import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { matchPath, useHistory, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { Trans } from '@lingui/react/macro';
import { IonButton, IonButtons, IonHeader, IonIcon, IonModal, IonTitle, IonToolbar } from '@ionic/react';
import { addCircleOutline, arrowBack } from 'ionicons/icons';
import { UserAvatar } from '@/components/UserAvatar';
import { ChatList } from '@/components/chat/lists/ChatList';
import type { ChatListTab } from '@/components/chat/lists/ChatListSegment';
import ChatThreadCore from '@/pages/chat-thread/chat-thread';
import GroupInfoCore, { GroupSavedMessagesCore, GroupSettingsCore } from '@/pages/chat-thread/group-info';
import ChatMembersCore from '@/pages/chat-thread/chat-members';
import ChatInvitesCore from '@/pages/chat-thread/manage-invites';
import CreateChatCore from '@/pages/create-chat';
import { InvitePreviewCore } from '@/pages/invite-preview';
import { JoinChatCore } from '@/pages/join-chat';
import { SettingsCore } from '@/pages/settings';
import { SavedMessagesCore } from '@/pages/saved-messages';
import { GeneralSettingsCore } from '@/pages/settings/general';
import { LanguagePageCore } from '@/pages/settings/language';
import { StickerSettingsCore } from '@/pages/settings/stickers';
import { StickerPackDetailCore } from '@/pages/settings/sticker-pack-detail';
import type { BackAction } from '@/types/back-action';
import type { ChatThreadRouteState } from '@/types/chatThreadNavigation';
import styles from './DesktopSplitLayout.module.scss';
import { HeaderActionMenu, type HeaderActionMenuItem } from '@/components/HeaderActionMenu';
import { useHasGlobalPermission } from '@/hooks/useHasGlobalPermission';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import type { RootState } from '@/store';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

type DesktopRouteState = ChatThreadRouteState;

interface DesktopRouteMatches {
  activeChatId: string | undefined;
  archivedMatch: { tab?: string } | null;
  threadMatch: { id: string; threadId: string } | null;
  groupInfoMatch: { id: string } | null;
  groupInfoSavedMessagesMatch: { id: string } | null;
  groupInfoSettingsMatch: { id: string } | null;
  membersMatch: { id: string } | null;
  invitesMatch: { id: string } | null;
  joinPreviewMatch: { inviteCode: string } | null;
  isNewChat: boolean;
  isJoinChat: boolean;
  globalSettings: boolean;
  generalSettings: boolean;
  savedMessagesSettings: boolean;
  languageSettings: boolean;
  stickerSettings: boolean;
  stickerPackSettings: { packId: string } | null;
}

function getDesktopRouteMatches(pathname: string): DesktopRouteMatches {
  const threadRaw = matchPath<{ id: string; threadId: string }>(pathname, {
    path: '/chats/chat/:id/thread/:threadId',
    exact: true,
  });
  const archivedRaw = matchPath<{ tab?: string }>(pathname, {
    path: '/chats/archived/:tab?',
    exact: true,
  });
  const groupInfoRaw = matchPath<{ id: string }>(pathname, {
    path: '/chats/chat/:id/group-info',
    exact: true,
  });
  const groupInfoSavedMessagesRaw = matchPath<{ id: string }>(pathname, {
    path: '/chats/chat/:id/group-info/saved-messages',
    exact: true,
  });
  const groupInfoSettingsRaw = matchPath<{ id: string }>(pathname, {
    path: '/chats/chat/:id/group-info/settings',
    exact: true,
  });
  const membersRaw = matchPath<{ id: string }>(pathname, {
    path: '/chats/chat/:id/members',
    exact: true,
  });
  const invitesRaw = matchPath<{ id: string }>(pathname, {
    path: '/chats/chat/:id/invites',
    exact: true,
  });
  const chatRaw = matchPath<{ id: string }>(pathname, {
    path: '/chats/chat/:id',
    exact: true,
  });
  const newRaw = matchPath(pathname, {
    path: '/chats/new',
    exact: true,
  });
  const joinRaw = matchPath(pathname, {
    path: '/chats/join',
    exact: true,
  });
  const joinPreviewRaw = matchPath<{ inviteCode: string }>(pathname, {
    path: '/chats/join/:inviteCode',
    exact: true,
  });
  const languageSettings = !!matchPath(pathname, {
    path: '/settings/language',
    exact: true,
  });
  const generalSettings = !!matchPath(pathname, {
    path: '/settings/general',
    exact: true,
  });
  const savedMessagesSettings = !!matchPath(pathname, {
    path: '/settings/saved-messages',
    exact: true,
  });
  const stickerPackRaw = matchPath<{ packId: string }>(pathname, {
    path: '/settings/stickers/:packId',
    exact: true,
  });
  const stickerSettings = !!matchPath(pathname, { path: '/settings/stickers', exact: true }) || !!stickerPackRaw;
  const globalSettings =
    !!matchPath(pathname, {
      path: '/settings',
      exact: true,
    }) ||
    generalSettings ||
    savedMessagesSettings ||
    languageSettings ||
    stickerSettings;

  return {
    activeChatId:
      threadRaw?.params.id ??
      groupInfoSavedMessagesRaw?.params.id ??
      groupInfoSettingsRaw?.params.id ??
      groupInfoRaw?.params.id ??
      membersRaw?.params.id ??
      invitesRaw?.params.id ??
      chatRaw?.params.id ??
      undefined,
    archivedMatch: archivedRaw?.params ?? null,
    threadMatch: threadRaw?.params ?? null,
    groupInfoMatch: groupInfoRaw?.params ?? null,
    groupInfoSavedMessagesMatch: groupInfoSavedMessagesRaw?.params ?? null,
    groupInfoSettingsMatch: groupInfoSettingsRaw?.params ?? null,
    membersMatch: membersRaw?.params ?? null,
    invitesMatch: invitesRaw?.params ?? null,
    joinPreviewMatch: joinPreviewRaw?.params ?? null,
    isNewChat: !!newRaw,
    isJoinChat: !!joinRaw,
    globalSettings,
    generalSettings,
    savedMessagesSettings,
    languageSettings,
    stickerSettings,
    stickerPackSettings: stickerPackRaw?.params ?? null,
  };
}

/** Deduplicates the settings / members modal pattern. */
function ChatModal({
  chatId,
  routePath,
  children,
}: {
  chatId: string | null;
  routePath: string;
  children: (chatId: string, backAction: BackAction) => ReactNode;
}) {
  const history = useHistory();
  const location = useLocation();

  const handleDidDismiss = useCallback(() => {
    if (!chatId) {
      return;
    }

    const stillOnModalRoute = !!matchPath(location.pathname, {
      path: routePath,
      exact: true,
    });

    if (!stillOnModalRoute) {
      return;
    }

    history.push(`/chats/chat/${chatId}`);
  }, [chatId, history, location.pathname, routePath]);

  return (
    <IonModal isOpen={chatId != null} onDidDismiss={handleDidDismiss}>
      {chatId != null &&
        children(chatId, {
          type: 'close',
          onClose: () => history.push(`/chats/chat/${chatId}`),
        })}
    </IonModal>
  );
}

export function DesktopSplitLayout() {
  const history = useHistory();
  const location = useLocation<DesktopRouteState | undefined>();
  const canCreateChat = useHasGlobalPermission('chat.create');
  const savedMessagesEnabled = useFeatureGate('savedMessages');
  const currentUser = useSelector((state: RootState) => state.user);
  const skipNextGlobalSettingsDismiss = useRef(false);
  const headerActions: HeaderActionMenuItem[] = [
    ...(canCreateChat
      ? [
          {
            id: 'create-chat',
            label: <Trans>Create Chat</Trans>,
            onSelect: () => history.push('/chats/new'),
          },
        ]
      : []),
    {
      id: 'join-via-code',
      label: <Trans>Join via Code</Trans>,
      onSelect: () => history.push('/chats/join'),
    },
  ];
  const currentRoute = getDesktopRouteMatches(location.pathname);
  const backgroundPath = location.state?.backgroundPath ?? '/chats';
  const baseRoute = currentRoute.globalSettings ? getDesktopRouteMatches(backgroundPath) : currentRoute;
  const {
    activeChatId,
    archivedMatch,
    threadMatch,
    groupInfoMatch,
    groupInfoSavedMessagesMatch: routeGroupInfoSavedMessagesMatch,
    groupInfoSettingsMatch,
    membersMatch,
    invitesMatch,
    joinPreviewMatch,
    isNewChat,
    isJoinChat,
  } = baseRoute;
  const groupInfoSavedMessagesMatch = savedMessagesEnabled ? routeGroupInfoSavedMessagesMatch : null;
  const disabledGroupSavedMessagesChatId = savedMessagesEnabled ? null : routeGroupInfoSavedMessagesMatch?.id;
  const disabledSavedMessagesSettings = !savedMessagesEnabled && currentRoute.savedMessagesSettings;
  useDocumentTitle(activeChatId);
  const globalSettingsOpen = currentRoute.globalSettings;
  const initialArchivedTab: ChatListTab | null =
    archivedMatch?.tab === 'threads' || archivedMatch?.tab === 'groups' || archivedMatch?.tab === 'all'
      ? archivedMatch.tab
      : archivedMatch
        ? 'all'
        : null;
  const [archivedSidebarTab, setArchivedSidebarTab] = useState<ChatListTab | null>(initialArchivedTab);
  const archivedMode = archivedSidebarTab != null;
  const archivedTab = archivedSidebarTab ?? 'all';
  const groupInfoModalChatId =
    groupInfoSavedMessagesMatch?.id ?? groupInfoSettingsMatch?.id ?? groupInfoMatch?.id ?? null;
  const groupInfoModalRoutePath = groupInfoSavedMessagesMatch
    ? '/chats/chat/:id/group-info/saved-messages'
    : groupInfoSettingsMatch
      ? '/chats/chat/:id/group-info/settings'
      : '/chats/chat/:id/group-info';

  useEffect(() => {
    if (disabledSavedMessagesSettings) {
      history.replace({
        pathname: '/settings',
        state: { backgroundPath },
      });
      return;
    }

    if (disabledGroupSavedMessagesChatId) {
      history.replace(`/chats/chat/${disabledGroupSavedMessagesChatId}/group-info`);
    }
  }, [backgroundPath, disabledGroupSavedMessagesChatId, disabledSavedMessagesSettings, history]);

  useEffect(() => {
    if (archivedMatch) {
      history.replace('/chats');
    }
  }, [archivedMatch, history]);

  const handleChatSelect = useCallback(
    (chatId: string, resumeHash?: string) => {
      history.replace({
        pathname: `/chats/chat/${chatId}`,
        hash: resumeHash,
      });
    },
    [history],
  );

  const openSettingsModal = useCallback(() => {
    history.push({
      pathname: '/settings',
      state: { backgroundPath: location.pathname },
    });
  }, [history, location.pathname]);

  const closeGlobalSettings = useCallback(() => {
    skipNextGlobalSettingsDismiss.current = true;
    history.replace(backgroundPath);
  }, [backgroundPath, history]);

  const handleGlobalSettingsDidDismiss = useCallback(() => {
    if (skipNextGlobalSettingsDismiss.current) {
      skipNextGlobalSettingsDismiss.current = false;
      return;
    }

    if (!getDesktopRouteMatches(location.pathname).globalSettings) {
      return;
    }

    history.replace(backgroundPath);
  }, [backgroundPath, history, location.pathname]);

  const openLanguageSettings = useCallback(() => {
    history.push({
      pathname: '/settings/language',
      state: { backgroundPath },
    });
  }, [backgroundPath, history]);

  const openGeneralSettings = useCallback(() => {
    history.push({
      pathname: '/settings/general',
      state: { backgroundPath },
    });
  }, [backgroundPath, history]);

  const openSavedMessages = useCallback(() => {
    if (!savedMessagesEnabled) {
      return;
    }

    history.push({
      pathname: '/settings/saved-messages',
      state: { backgroundPath },
    });
  }, [backgroundPath, history, savedMessagesEnabled]);

  const openStickerSettings = useCallback(() => {
    history.push({
      pathname: '/settings/stickers',
      state: { backgroundPath },
    });
  }, [backgroundPath, history]);

  const openStickerPackSettings = useCallback(
    (packId: string) => {
      history.push({
        pathname: `/settings/stickers/${packId}`,
        state: { backgroundPath },
      });
    },
    [backgroundPath, history],
  );

  const handleThreadSelect = useCallback(
    (chatId: string, threadRootId: string) => {
      history.replace(`/chats/chat/${chatId}/thread/${threadRootId}`);
    },
    [history],
  );

  let subPageOverlay: ReactNode = null;

  if (threadMatch) {
    const { id, threadId } = threadMatch;
    subPageOverlay = (
      <ChatThreadCore
        key={threadId}
        chatId={id}
        threadId={threadId}
        backAction={{
          type: 'callback',
          onBack: () => history.replace(`/chats/chat/${id}`),
        }}
      />
    );
  }

  return (
    <div className={styles.desktopSplitLayout}>
      <div className={styles.desktopSplitLeft}>
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              {archivedMode ? (
                <IonButton onClick={() => setArchivedSidebarTab(null)} aria-label="Back to chats">
                  <IonIcon slot="icon-only" icon={arrowBack} />
                </IonButton>
              ) : (
                <IonButton onClick={openSettingsModal} aria-label="Open settings">
                  <UserAvatar
                    name={currentUser.username ?? 'User'}
                    avatarUrl={currentUser.avatarUrl}
                    size={26}
                    fallback="icon"
                    className={styles.settingsAvatar}
                  />
                </IonButton>
              )}
            </IonButtons>
            <IonTitle>{archivedMode ? <Trans>Archived</Trans> : <Trans>Chats</Trans>}</IonTitle>
            <IonButtons slot="end">
              <HeaderActionMenu icon={addCircleOutline} actions={headerActions} />
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <ChatList
          key={archivedMode ? `archived-${archivedTab}` : 'active'}
          activeChatId={activeChatId}
          activeThreadId={threadMatch?.threadId}
          archivedMode={archivedMode}
          initialTab={archivedTab}
          onOpenArchived={setArchivedSidebarTab}
          onChatSelect={handleChatSelect}
          onThreadSelect={handleThreadSelect}
        />
      </div>
      <div className={styles.desktopSplitRight}>
        {/* Base layer: always render ChatThreadCore when a chat is selected */}
        {activeChatId && !isNewChat && !joinPreviewMatch && (
          <div style={{ display: subPageOverlay ? 'none' : undefined }} className={styles.desktopSplitPane}>
            <ChatThreadCore key={activeChatId} chatId={activeChatId} />
          </div>
        )}

        {/* Overlay layer: sub-page (thread) */}
        {subPageOverlay && <div className={styles.desktopSplitPane}>{subPageOverlay}</div>}

        {/* Group info modal */}
        <ChatModal chatId={groupInfoModalChatId} routePath={groupInfoModalRoutePath}>
          {(chatId, backAction) =>
            groupInfoSavedMessagesMatch ? (
              <GroupSavedMessagesCore
                chatId={chatId}
                backAction={{
                  type: 'callback',
                  onBack: () => history.push(`/chats/chat/${chatId}/group-info`),
                }}
              />
            ) : groupInfoSettingsMatch ? (
              <GroupSettingsCore
                chatId={chatId}
                backAction={{
                  type: 'callback',
                  onBack: () => history.push(`/chats/chat/${chatId}/group-info`),
                }}
              />
            ) : (
              <GroupInfoCore chatId={chatId} backAction={backAction} />
            )
          }
        </ChatModal>

        {/* Members modal */}
        <ChatModal chatId={membersMatch?.id ?? null} routePath="/chats/chat/:id/members">
          {(chatId, backAction) => <ChatMembersCore chatId={chatId} backAction={backAction} />}
        </ChatModal>

        <ChatModal chatId={invitesMatch?.id ?? null} routePath="/chats/chat/:id/invites">
          {(chatId) => (
            <ChatInvitesCore
              chatId={chatId}
              backAction={{ type: 'close', onClose: () => history.push(`/chats/chat/${chatId}/group-info`) }}
            />
          )}
        </ChatModal>

        {/* Global settings modal */}
        <IonModal isOpen={globalSettingsOpen} onDidDismiss={handleGlobalSettingsDidDismiss}>
          {currentRoute.languageSettings ? (
            <LanguagePageCore
              backAction={{
                type: 'callback',
                onBack: () =>
                  history.push({
                    pathname: '/settings/general',
                    state: { backgroundPath },
                  }),
              }}
            />
          ) : currentRoute.stickerPackSettings ? (
            <StickerPackDetailCore
              packId={currentRoute.stickerPackSettings.packId}
              backAction={
                (location.state as any)?.fromChat
                  ? {
                      type: 'callback',
                      onBack: closeGlobalSettings,
                    }
                  : {
                      type: 'callback',
                      onBack: () =>
                        history.push({
                          pathname: '/settings/stickers',
                          state: { backgroundPath },
                        }),
                    }
              }
            />
          ) : currentRoute.stickerSettings ? (
            <StickerSettingsCore
              backAction={{
                type: 'callback',
                onBack: () =>
                  history.push({
                    pathname: '/settings',
                    state: { backgroundPath },
                  }),
              }}
              onOpenPack={openStickerPackSettings}
            />
          ) : savedMessagesEnabled && currentRoute.savedMessagesSettings ? (
            <SavedMessagesCore
              backAction={{
                type: 'callback',
                onBack: () =>
                  history.push({
                    pathname: '/settings',
                    state: { backgroundPath },
                  }),
              }}
            />
          ) : currentRoute.generalSettings ? (
            <GeneralSettingsCore
              backAction={{
                type: 'callback',
                onBack: () =>
                  history.push({
                    pathname: '/settings',
                    state: { backgroundPath },
                  }),
              }}
              onOpenLanguage={openLanguageSettings}
            />
          ) : (
            <SettingsCore
              backAction={{ type: 'close', onClose: closeGlobalSettings }}
              onOpenGeneral={openGeneralSettings}
              onOpenSavedMessages={savedMessagesEnabled ? openSavedMessages : undefined}
              onOpenStickers={openStickerSettings}
            />
          )}
        </IonModal>

        {/* Create chat page */}
        {isNewChat && (
          <div className={styles.desktopSplitPane}>
            <CreateChatCore backAction={{ type: 'close', onClose: () => history.replace('/chats') }} />
          </div>
        )}

        {/* Join chat page */}
        {isJoinChat && (
          <div className={styles.desktopSplitPane}>
            <JoinChatCore backAction={{ type: 'close', onClose: () => history.replace('/chats') }} />
          </div>
        )}

        {joinPreviewMatch && (
          <div className={styles.desktopSplitPane}>
            <InvitePreviewCore
              inviteCode={decodeURIComponent(joinPreviewMatch.inviteCode)}
              backAction={{ type: 'close', onClose: () => history.replace('/chats') }}
            />
          </div>
        )}

        {/* Placeholder when no chat selected */}
        {!activeChatId && !isNewChat && !isJoinChat && !joinPreviewMatch && (
          <div className={styles.desktopSplitPlaceholder}>
            <Trans>Select a chat</Trans>
          </div>
        )}
      </div>
    </div>
  );
}
