import { GroupKind } from '../../generated/models';
import { encodeId } from '../api/snowflake-id';
import { DetailView } from '../chats/chat-details/detail-view';
import { StartChatKind } from '../chats/start-chat/start-chat-kind';

export enum PanelKind {
  Settings = 'settings',
  Profile = 'profile',
  Info = 'info',
  Search = 'search',
  Invites = 'invites',
  Reactions = 'reactions',
  Stickers = 'stickers',
  Sticker = 'sticker',
  Create = 'create',
  AddFriend = 'add-friend',
  Join = 'join',
  Media = 'media',
}

export enum PanelContent {
  Media,
  Reactions,
  Profile,
  StickerPicker,
  StartChat,
  Settings,
  Notifications,
  NotificationCategory,
  General,
  Language,
  FriendVerification,
  Privacy,
  BlockedUsers,
  Presence,
  ReadReceipts,
  StickerSettings,
  StickerPack,
  ChatDetails,
  ChatSearch,
}

type PanelProps = {
  kind?: GroupKind | StartChatKind;
  currentConversation?: boolean;
  view?: DetailView;
  selectable?: boolean;
};

export interface PanelDefinition {
  path: string;
  kind: PanelKind;
  content: PanelContent;
  props?: PanelProps;
  inputs?: readonly (keyof typeof parameterInputs)[];
  conversation?: boolean;
  settings?: { address: string; parent?: string; child?: string };
}

// Pure protocol data: importing it from navigation never imports page components.
export const panelDefinitions: readonly PanelDefinition[] = [
  { path: 'media', kind: PanelKind.Media, content: PanelContent.Media },
  {
    path: 'chats/chat/:id/message/:messageId/reactions',
    kind: PanelKind.Reactions,
    inputs: ['id', 'messageId'],
    conversation: true,
    content: PanelContent.Reactions,
  },
  { path: 'profile', kind: PanelKind.Profile, content: PanelContent.Profile },
  { path: 'profile/:uid', kind: PanelKind.Profile, content: PanelContent.Profile },
  {
    path: 'stickers/:packId',
    kind: PanelKind.Stickers,
    inputs: ['packId'],
    content: PanelContent.StickerPicker,
    props: { selectable: false },
  },
  {
    path: 'sticker/:stickerId',
    kind: PanelKind.Sticker,
    inputs: ['stickerId'],
    content: PanelContent.StickerPicker,
    props: { selectable: false },
  },
  { path: 'chats/new', kind: PanelKind.Create, content: PanelContent.StartChat, props: { kind: StartChatKind.Create } },
  {
    path: 'chats/add-friend',
    kind: PanelKind.AddFriend,
    content: PanelContent.StartChat,
    props: { kind: StartChatKind.Friend },
  },
  { path: 'chats/join', kind: PanelKind.Join, content: PanelContent.StartChat, props: { kind: StartChatKind.Join } },
  {
    path: 'chats/join/:code',
    kind: PanelKind.Join,
    inputs: ['code'],
    content: PanelContent.StartChat,
    props: { kind: StartChatKind.Join },
  },
  {
    path: 'chats/chat/:id/stickers/:packId',
    kind: PanelKind.Stickers,
    inputs: ['packId'],
    content: PanelContent.StickerPicker,
    props: { selectable: false },
  },
  { path: 'settings', kind: PanelKind.Settings, content: PanelContent.Settings, settings: { address: 'settings' } },
  {
    path: 'settings/notifications',
    kind: PanelKind.Settings,
    content: PanelContent.Notifications,
    settings: { address: 'notifications', parent: '/settings', child: 'notifications' },
  },
  {
    path: 'settings/notifications/dm',
    kind: PanelKind.Settings,
    content: PanelContent.NotificationCategory,
    props: { kind: GroupKind.dm },
    settings: { address: 'notification/dm', parent: '/settings/notifications', child: 'dm' },
  },
  {
    path: 'settings/notifications/group',
    kind: PanelKind.Settings,
    content: PanelContent.NotificationCategory,
    props: { kind: GroupKind.group },
    settings: { address: 'notification/group', parent: '/settings/notifications', child: 'group' },
  },
  {
    path: 'settings/general',
    kind: PanelKind.Settings,
    content: PanelContent.General,
    settings: { address: 'general', parent: '/settings', child: 'general' },
  },
  {
    path: 'settings/language',
    kind: PanelKind.Settings,
    content: PanelContent.Language,
    settings: { address: 'language', parent: '/settings', child: 'language' },
  },
  {
    path: 'settings/friend-verification',
    kind: PanelKind.Settings,
    content: PanelContent.FriendVerification,
    settings: { address: 'friend-verification', parent: '/settings/privacy', child: 'friend-verification' },
  },
  {
    path: 'settings/privacy',
    kind: PanelKind.Settings,
    content: PanelContent.Privacy,
    settings: { address: 'privacy', parent: '/settings', child: 'privacy' },
  },
  {
    path: 'settings/blocked-users',
    kind: PanelKind.Settings,
    content: PanelContent.BlockedUsers,
    settings: { address: 'blocked-users', parent: '/settings/privacy', child: 'blocked-users' },
  },
  {
    path: 'settings/presence',
    kind: PanelKind.Settings,
    content: PanelContent.Presence,
    settings: { address: 'presence', parent: '/settings/privacy', child: 'presence' },
  },
  {
    path: 'settings/read-receipts',
    kind: PanelKind.Settings,
    content: PanelContent.ReadReceipts,
    settings: { address: 'read-receipts', parent: '/settings/privacy', child: 'read-receipts' },
  },
  {
    path: 'settings/stickers',
    kind: PanelKind.Settings,
    content: PanelContent.StickerSettings,
    settings: { address: 'sticker-settings', parent: '/settings', child: 'stickers' },
  },
  {
    path: 'settings/stickers/:packId',
    kind: PanelKind.Settings,
    inputs: ['packId'],
    content: PanelContent.StickerPack,
    settings: { address: 'sticker-pack/:packId', parent: '/settings/stickers', child: ':packId' },
  },
  {
    path: 'chats/chat/:id/info',
    kind: PanelKind.Info,
    inputs: ['id'],
    conversation: true,
    content: PanelContent.ChatDetails,
    props: { currentConversation: true },
  },
  {
    path: 'chats/chat/:id/thread/:threadId/info',
    kind: PanelKind.Info,
    inputs: ['id', 'threadId'],
    conversation: true,
    content: PanelContent.ChatDetails,
    props: { currentConversation: true },
  },
  {
    path: 'chats/chat/:id/invites',
    kind: PanelKind.Invites,
    inputs: ['id'],
    conversation: true,
    content: PanelContent.ChatDetails,
    props: { view: DetailView.Invites },
  },
  {
    path: 'chats/chat/:id/search',
    kind: PanelKind.Search,
    inputs: ['id'],
    conversation: true,
    content: PanelContent.ChatSearch,
  },
];

export const panelViews: Record<string, string> = {
  [DetailView.Info]: 'overview',
  [DetailView.Invites]: 'invites',
  [DetailView.Privacy]: 'privacy',
  [DetailView.Management]: 'management',
  image: 'images',
  video: 'videos',
  other: 'files',
};

// Most keys use key/value. These retain their existing compact query syntax.
export const panelParameterAddresses: Partial<Record<PanelKind, { path: string; numeric?: boolean }>> = {
  [PanelKind.Create]: { path: 'chats/new' },
  [PanelKind.AddFriend]: { path: 'chats/add-friend' },
  [PanelKind.Join]: { path: 'chats/join/:value' },
  [PanelKind.Reactions]: { path: 'message/:value/reactions', numeric: true },
};

const routes = panelDefinitions.map((definition) => ({ definition, segments: definition.path.split('/') }));

export function matchPanel(segments: readonly string[]) {
  const route = routes.find(
    (route) =>
      route.segments.length === segments.length &&
      route.segments.every((part, index) => part.startsWith(':') || part === segments[index]),
  );
  if (!route) return undefined;
  const params: Record<string, string> = {};
  route.segments.forEach((part, index) => {
    if (part.startsWith(':')) params[part.slice(1)] = segments[index];
  });
  return { definition: route.definition, params };
}

export function panelDefinition(path: string) {
  return matchPanel(path.split('?', 1)[0].replace(/^\//, '').split('/'))?.definition;
}

export function hasPanelViews(path: string) {
  const content = panelDefinition(path)?.content;
  return content === PanelContent.ChatDetails || content === PanelContent.Profile;
}

// Route parameter bindings live with their wire paths, including the Snowflake number encoding.
const parameterInputs = {
  id: { input: 'chatId', parse: encodeId },
  threadId: { input: 'threadId', parse: encodeId },
  messageId: { input: 'messageId', parse: encodeId },
  packId: { input: 'packId', parse: encodeId },
  stickerId: { input: 'stickerId', parse: encodeId },
  code: { input: 'code', parse: (value) => value },
} satisfies Record<string, { input: string; parse: (value: string) => unknown }>;

export function panelInputs(definition: PanelDefinition, params: Readonly<Record<string, string>>) {
  const inputs: Record<string, unknown> = {};
  for (const name of definition.inputs ?? []) {
    const binding = parameterInputs[name];
    inputs[binding.input] = binding.parse(params[name]);
  }
  return inputs;
}
