import { ForwardedRecords } from './messages/forwarded-records/forwarded-records';
import { ReactionDetails } from './messages/reaction-details/reaction-details';
import { MediaViewer } from './messages/media-viewer/media-viewer';
import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanMatchFn, type Routes } from '@angular/router';
import { isPlatform } from '@ionic/angular';
import { openMessageLink } from './chats/chat-link/message-link.guard';
import { ChatLink } from './chats/chat-link/chat-link';
import { ChatListPage } from './chats/chat-list-page/chat-list.page';
import { isListTab, ListTab } from './chats/list-tabs';
import { ConversationPage } from './conversations/conversation/conversation.page';
import { PinnedMessagesPage } from './conversations/pinned-messages/pinned-messages.page';
import { SavedMessagesPage } from './conversations/saved-messages/saved-messages.page';
import { ChatDetails, DetailView } from './chats/chat-details/chat-details';
import { ChatSearch } from './chats/chat-search/chat-search';
import { StartChatKind } from './chats/start-chat/start-chat';
import { GroupKind } from '../generated/models';
import { NotificationCategoryPage } from './settings/notification-settings/notification-category-page';
import { NotificationSettings } from './settings/notification-settings/notification-settings';
import { Settings } from './settings/settings/settings';
import { GeneralSettings } from './settings/general-settings/general-settings';
import { LanguageSettings } from './settings/language-settings/language-settings';
import { FriendVerificationSettings } from './settings/friend-verification-settings/friend-verification-settings';
import { PrivacySettings } from './settings/privacy-settings/privacy-settings';
import { BlockedUsers } from './settings/blocked-users/blocked-users';
import { PresenceSettings } from './settings/presence-settings/presence-settings';
import { ReadReceiptSettings } from './settings/read-receipt-settings/read-receipt-settings';
import { StickerSettings } from './settings/sticker-settings/sticker-settings';
import { StickerPackDetail } from './settings/sticker-pack-detail/sticker-pack-detail';
import { Landing } from './pwa/landing/landing';

const matchListTab: CanMatchFn = (_route, segments) => isListTab(segments[1].path);

export const routes: Routes = [
  {
    path: 'landing',
    component: Landing,
    canMatch: [
      () =>
        isPlatform('pwa') ? new RedirectCommand(inject(Router).createUrlTree(['/chats']), { replaceUrl: true }) : true,
    ],
  },
  { path: 'm/:encoded', canActivate: [openMessageLink], children: [] },
  { path: 'media', component: ChatLink, data: { modal: true, component: MediaViewer, media: true } },
  {
    path: 'chats/chat/:id/message/:messageId/reactions',
    component: ChatLink,
    data: { modal: true, component: ReactionDetails },
  },
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
  { path: 'profile', component: ChatLink, data: { modal: true } },
  { path: 'profile/:uid', component: ChatLink, data: { modal: true } },
  { path: 'stickers/:packId', component: ChatLink, data: { modal: true } },
  { path: 'sticker/:stickerId', component: ChatLink, data: { modal: true } },
  { path: 'chats/new', component: ChatLink, data: { modal: true, kind: StartChatKind.Create } },
  { path: 'chats/add-friend', component: ChatLink, data: { modal: true, kind: StartChatKind.Friend } },
  { path: 'chats/join', component: ChatLink, data: { modal: true } },
  { path: 'chats/join/:code', component: ChatLink, data: { modal: true } },
  { path: 'chats/chat/:id/stickers/:packId', component: ChatLink, data: { modal: true } },
  { path: 'settings', component: ChatLink, data: { modal: true, component: Settings } },
  { path: 'settings/notifications', component: ChatLink, data: { modal: true, component: NotificationSettings } },
  {
    path: 'settings/notifications/dm',
    component: ChatLink,
    data: { modal: true, component: NotificationCategoryPage, props: { kind: GroupKind.dm } },
  },
  {
    path: 'settings/notifications/group',
    component: ChatLink,
    data: { modal: true, component: NotificationCategoryPage, props: { kind: GroupKind.group } },
  },
  { path: 'settings/general', component: ChatLink, data: { modal: true, component: GeneralSettings } },
  { path: 'settings/language', component: ChatLink, data: { modal: true, component: LanguageSettings } },
  {
    path: 'settings/friend-verification',
    component: ChatLink,
    data: { modal: true, component: FriendVerificationSettings },
  },
  { path: 'settings/privacy', component: ChatLink, data: { modal: true, component: PrivacySettings } },
  { path: 'settings/blocked-users', component: ChatLink, data: { modal: true, component: BlockedUsers } },
  { path: 'settings/presence', component: ChatLink, data: { modal: true, component: PresenceSettings } },
  { path: 'settings/read-receipts', component: ChatLink, data: { modal: true, component: ReadReceiptSettings } },
  { path: 'settings/stickers', component: ChatLink, data: { modal: true, component: StickerSettings } },
  { path: 'settings/stickers/:packId', component: ChatLink, data: { modal: true, component: StickerPackDetail } },
  {
    path: 'chats/chat/:id/info',
    component: ChatLink,
    data: { modal: true, component: ChatDetails, props: { asModal: true, currentConversation: true } },
  },
  {
    path: 'chats/chat/:id/thread/:threadId/info',
    component: ChatLink,
    data: { modal: true, component: ChatDetails, props: { asModal: true, currentConversation: true } },
  },
  {
    path: 'chats/chat/:id/invites',
    component: ChatLink,
    data: { modal: true, component: ChatDetails, props: { asModal: true, view: DetailView.Invites } },
  },
  { path: 'chats/chat/:id/search', component: ChatLink, data: { modal: true, component: ChatSearch } },
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
