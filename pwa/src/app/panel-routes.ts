import { type Routes } from '@angular/router';
import { GroupKind } from '../generated/models';
import { ChatDetails, DetailView } from './chats/chat-details/chat-details';
import { ChatSearch } from './chats/chat-search/chat-search';
import { StartChatKind } from './chats/start-chat/start-chat';
import { MediaViewer } from './messages/media-viewer/media-viewer';
import { ReactionDetails } from './messages/reaction-details/reaction-details';
import { BlockedUsers } from './settings/blocked-users/blocked-users';
import { FriendVerificationSettings } from './settings/friend-verification-settings/friend-verification-settings';
import { GeneralSettings } from './settings/general-settings/general-settings';
import { LanguageSettings } from './settings/language-settings/language-settings';
import { NotificationCategoryPage } from './settings/notification-settings/notification-category-page';
import { NotificationSettings } from './settings/notification-settings/notification-settings';
import { PresenceSettings } from './settings/presence-settings/presence-settings';
import { PrivacySettings } from './settings/privacy-settings/privacy-settings';
import { ReadReceiptSettings } from './settings/read-receipt-settings/read-receipt-settings';
import { Settings } from './settings/settings/settings';
import { StickerPackDetail } from './settings/sticker-pack-detail/sticker-pack-detail';
import { StickerSettings } from './settings/sticker-settings/sticker-settings';

export const panelRoutes: Routes = [
  { path: 'media', data: { modal: true, component: MediaViewer, media: true } },
  {
    path: 'chats/chat/:id/message/:messageId/reactions',
    data: { modal: true, component: ReactionDetails },
  },
  { path: 'profile', data: { modal: true } },
  { path: 'profile/:uid', data: { modal: true } },
  { path: 'stickers/:packId', data: { modal: true } },
  { path: 'sticker/:stickerId', data: { modal: true } },
  { path: 'chats/new', data: { modal: true, kind: StartChatKind.Create } },
  { path: 'chats/add-friend', data: { modal: true, kind: StartChatKind.Friend } },
  { path: 'chats/join', data: { modal: true } },
  { path: 'chats/join/:code', data: { modal: true } },
  { path: 'chats/chat/:id/stickers/:packId', data: { modal: true } },
  { path: 'settings', data: { modal: true, component: Settings } },
  { path: 'settings/notifications', data: { modal: true, component: NotificationSettings } },
  {
    path: 'settings/notifications/dm',
    data: { modal: true, component: NotificationCategoryPage, props: { kind: GroupKind.dm } },
  },
  {
    path: 'settings/notifications/group',
    data: { modal: true, component: NotificationCategoryPage, props: { kind: GroupKind.group } },
  },
  { path: 'settings/general', data: { modal: true, component: GeneralSettings } },
  { path: 'settings/language', data: { modal: true, component: LanguageSettings } },
  {
    path: 'settings/friend-verification',
    data: { modal: true, component: FriendVerificationSettings },
  },
  { path: 'settings/privacy', data: { modal: true, component: PrivacySettings } },
  { path: 'settings/blocked-users', data: { modal: true, component: BlockedUsers } },
  { path: 'settings/presence', data: { modal: true, component: PresenceSettings } },
  { path: 'settings/read-receipts', data: { modal: true, component: ReadReceiptSettings } },
  { path: 'settings/stickers', data: { modal: true, component: StickerSettings } },
  { path: 'settings/stickers/:packId', data: { modal: true, component: StickerPackDetail } },
  {
    path: 'chats/chat/:id/info',
    data: { modal: true, component: ChatDetails, props: { currentConversation: true } },
  },
  {
    path: 'chats/chat/:id/thread/:threadId/info',
    data: { modal: true, component: ChatDetails, props: { currentConversation: true } },
  },
  {
    path: 'chats/chat/:id/invites',
    data: { modal: true, component: ChatDetails, props: { view: DetailView.Invites } },
  },
  { path: 'chats/chat/:id/search', data: { modal: true, component: ChatSearch } },
];
