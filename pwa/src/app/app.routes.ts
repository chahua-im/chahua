import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanMatchFn, type Routes } from '@angular/router';
import { ChatLink } from './chats/chat-link/chat-link';
import { ChatListPage } from './chats/chat-list-page/chat-list.page';
import { isListTab, ListTab } from './chats/list-tabs';
import { ConversationPage } from './conversations/conversation/conversation.page';
import { PinnedMessagesPage } from './conversations/pinned-messages/pinned-messages.page';
import { SavedMessagesPage } from './conversations/saved-messages/saved-messages.page';
import { Landing } from './pwa/landing/landing';

const matchListTab: CanMatchFn = (_route, segments) => isListTab(segments[1].path);

export const routes: Routes = [
  { path: 'landing', component: Landing },
  { path: 'm/:encoded', component: ChatLink },
  { path: 'profile', component: ChatLink },
  { path: 'chats/new', component: ChatLink, data: { create: true } },
  { path: 'chats/join', component: ChatLink },
  { path: 'chats/join/:code', component: ChatLink },
  { path: 'chats/chat/:id/stickers/:packId', component: ChatLink },
  {
    path: 'settings',
    pathMatch: 'full',
    canMatch: [
      () =>
        new RedirectCommand(inject(Router).createUrlTree(['/chats'], { queryParams: { settings: '1' } }), {
          browserUrl: '/settings',
        }),
    ],
    children: [],
  },
  { path: 'chats/chat/:id/saved', component: SavedMessagesPage },
  {
    path: 'chats/saved',
    component: SavedMessagesPage,
  },
  {
    path: 'chats/chat/:id/thread/:threadId/pins',
    component: PinnedMessagesPage,
  },
  {
    path: 'chats/chat/:id/pins',
    component: PinnedMessagesPage,
  },
  {
    path: 'chats',
    data: { tab: ListTab.Messages },
    component: ChatListPage,
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
    path: 'chats/:tab',
    canMatch: [matchListTab],
    component: ChatListPage,
  },
  { path: '', redirectTo: 'chats', pathMatch: 'full' },
  { path: '**', redirectTo: 'chats' },
];
