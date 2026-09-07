import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanMatchFn, type Routes } from '@angular/router';
import { isListTab, ListTab } from './chats/list-tabs';
import { ConversationCollectionKind } from './conversations/conversation-collection-kind';

const matchListTab: CanMatchFn = (_route, segments) => isListTab(segments[1].path);

export const routes: Routes = [
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
  {
    path: 'chats/saved',
    data: { collection: ConversationCollectionKind.Saved },
    loadComponent: () =>
      import('./conversations/conversation-collection/conversation-collection.page').then((m) => m.ConversationCollectionPage),
  },
  {
    path: 'chats/chat/:id/thread/:threadId/pins',
    data: { collection: ConversationCollectionKind.Pins },
    loadComponent: () =>
      import('./conversations/conversation-collection/conversation-collection.page').then((m) => m.ConversationCollectionPage),
  },
  {
    path: 'chats/chat/:id/pins',
    data: { collection: ConversationCollectionKind.Pins },
    loadComponent: () =>
      import('./conversations/conversation-collection/conversation-collection.page').then((m) => m.ConversationCollectionPage),
  },
  {
    path: 'chats',
    data: { tab: ListTab.Messages },
    loadComponent: () => import('./chats/chat-list-page/chat-list.page').then((m) => m.ChatListPage),
  },
  {
    path: 'chats/chat/:id',
    loadComponent: () => import('./conversations/conversation/conversation.page').then((m) => m.ConversationPage),
  },
  {
    path: 'chats/chat/:id/thread/:threadId',
    loadComponent: () => import('./conversations/conversation/conversation.page').then((m) => m.ConversationPage),
  },
  {
    path: 'chats/friends/archived-requests',
    data: { tab: ListTab.Friends, requestHistory: true },
    loadComponent: () => import('./chats/chat-list-page/chat-list.page').then((m) => m.ChatListPage),
  },
  {
    path: 'chats/:tab/archived',
    data: { archived: true },
    canMatch: [matchListTab],
    loadComponent: () => import('./chats/chat-list-page/chat-list.page').then((m) => m.ChatListPage),
  },
  {
    path: 'chats/:tab',
    canMatch: [matchListTab],
    loadComponent: () => import('./chats/chat-list-page/chat-list.page').then((m) => m.ChatListPage),
  },
  { path: '', redirectTo: 'chats', pathMatch: 'full' },
  { path: '**', redirectTo: 'chats' },
];
