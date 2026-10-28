import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanMatchFn, type Routes } from '@angular/router';
import { isPlatform } from '@ionic/angular';
import { openMessageLink } from './chats/chat-link/message-link.guard';
import { ChatListPage } from './chats/chat-list-page/chat-list.page';
import { isListTab, ListTab } from './chats/list-tabs';
import { ConversationPage } from './conversations/conversation/conversation.page';
import { PinnedMessagesPage } from './conversations/pinned-messages/pinned-messages.page';
import { SavedMessagesPage } from './conversations/saved-messages/saved-messages.page';
import { ForwardedRecords } from './messages/forwarded-records/forwarded-records';
import { canNavigatePanels, openPanel } from './navigation/panel-navigation';
import { panelRoutes } from './panel-routes';
import { Landing } from './pwa/landing/landing';

const matchListTab: CanMatchFn = (_route, segments) => isListTab(segments[1].path);

const primaryRoutes: Routes = [
  {
    path: 'landing',
    component: Landing,
    canMatch: [
      () =>
        isPlatform('pwa') ? new RedirectCommand(inject(Router).createUrlTree(['/chats']), { replaceUrl: true }) : true,
    ],
  },
  { path: 'm/:encoded', canActivate: [openMessageLink], children: [] },
  {
    path: 'chats/chat/:id/message/:messageId/forwarded',
    component: ForwardedRecords,
    data: { preserveConversation: true },
  },
  {
    path: 'chats/chat/:id/message/:messageId/forwarded/:bundleId',
    component: ForwardedRecords,
    data: { preserveConversation: true },
  },
  { path: 'chats/saved/:savedId/forwarded', component: ForwardedRecords, data: { preserveConversation: true } },
  {
    path: 'chats/saved/:savedId/forwarded/:bundleId',
    component: ForwardedRecords,
    data: { preserveConversation: true },
  },
  { path: 'settings/experimental', redirectTo: 'settings/general', pathMatch: 'full' },
  {
    path: 'chats/saved',
    component: SavedMessagesPage,
  },
  {
    path: 'chats/chat/:id/thread/:threadId/pins',
    component: PinnedMessagesPage,
    data: { preserveConversation: true },
  },
  {
    path: 'chats/chat/:id/pins',
    component: PinnedMessagesPage,
    data: { preserveConversation: true },
  },
  {
    path: 'chats/chat/:id',
    component: ConversationPage,
  },
  {
    path: 'chats/chat/:id/thread/:threadId',
    component: ConversationPage,
  },
  {
    path: 'chats/friends/archived-requests',
    data: { tab: ListTab.Friends, requestHistory: true },
    component: ChatListPage,
  },
  {
    path: 'chats/:tab/archived',
    data: { archived: true },
    canMatch: [matchListTab],
    component: ChatListPage,
  },
  {
    path: 'chats',
    component: ChatListPage,
    children: [
      { path: '', pathMatch: 'full', data: { tab: ListTab.Messages }, children: [] },
      { path: ':tab', canMatch: [(_route, segments) => isListTab(segments[0].path)], children: [] },
    ],
  },
  { path: '', redirectTo: 'chats', pathMatch: 'full' },
  { path: '**', redirectTo: 'chats' },
];

export const routes: Routes = [
  ...panelRoutes.map((route) => ({ ...route, canActivate: [openPanel], children: [] })),
  ...primaryRoutes.map((route) =>
    route.redirectTo != null
      ? route
      : {
          ...route,
          canActivate: [...(route.canActivate ?? []), canNavigatePanels],
          runGuardsAndResolvers: 'always' as const,
        },
  ),
];
