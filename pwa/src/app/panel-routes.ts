import { type Type } from '@angular/core';
import { type Routes } from '@angular/router';
import { ChatDetails } from './chats/chat-details/chat-details';
import { ChatSearch } from './chats/chat-search/chat-search';
import { StartChat } from './chats/start-chat/start-chat';
import { MediaViewer } from './messages/media-viewer/media-viewer';
import { ReactionDetails } from './messages/reaction-details/reaction-details';
import { StickerPicker } from './messages/sticker-picker/sticker-picker';
import { PanelContent, panelDefinitions } from './navigation/panel-definitions';
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

export const panelComponents: Record<PanelContent, Type<unknown>> = {
  [PanelContent.Media]: MediaViewer,
  [PanelContent.Reactions]: ReactionDetails,
  [PanelContent.Profile]: ChatDetails,
  [PanelContent.StickerPicker]: StickerPicker,
  [PanelContent.StartChat]: StartChat,
  [PanelContent.Settings]: Settings,
  [PanelContent.Notifications]: NotificationSettings,
  [PanelContent.NotificationCategory]: NotificationCategoryPage,
  [PanelContent.General]: GeneralSettings,
  [PanelContent.Language]: LanguageSettings,
  [PanelContent.FriendVerification]: FriendVerificationSettings,
  [PanelContent.Privacy]: PrivacySettings,
  [PanelContent.BlockedUsers]: BlockedUsers,
  [PanelContent.Presence]: PresenceSettings,
  [PanelContent.ReadReceipts]: ReadReceiptSettings,
  [PanelContent.StickerSettings]: StickerSettings,
  [PanelContent.StickerPack]: StickerPackDetail,
  [PanelContent.ChatDetails]: ChatDetails,
  [PanelContent.ChatSearch]: ChatSearch,
};

export const panelRoutes: Routes = panelDefinitions.map(({ path }) => ({ path, data: { modal: true } }));
