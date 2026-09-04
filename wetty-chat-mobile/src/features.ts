export const FEATURES = {
  demoPage: {
    enabled: false,
    description: 'Shows the internal component demo tab/page.',
  },
  developerSettings: {
    enabled: false,
    description: 'Shows internal developer settings.',
  },
  colorMode: {
    enabled: true,
    description: 'Lets users choose a light, dark, or system color mode.',
  },
  chatMemberAdd: {
    enabled: false,
    description: 'Allows adding members from the group members page.',
  },
  chatVisibility: {
    enabled: false,
    description: 'Allows admins to switch chats between public and private visibility.',
  },
  chatAttachments: {
    enabled: false,
    description: 'Shows the chat attachments section in the group info page.',
  },
  mediaCompression: {
    enabled: true,
    description: 'Compresses image and video attachments before upload.',
  },
  fileAttachments: {
    enabled: true,
    description: 'Allows ordinary files to be attached to chat messages.',
  },
  messageSearch: {
    enabled: true,
    description: 'Shows chat-scoped message search from the group info page.',
  },
  savedMessages: {
    enabled: true,
    description: 'Allows users to save messages and view saved messages from settings or group info.',
  },
  landingInviteModal: {
    enabled: true,
    description: 'Shows invite preview and redeem modal on the install landing page.',
  },
  profileDeepLink: {
    enabled: true,
    description: 'External /profile?uid= links open the target user profile in-app.',
  },
  pendingInvitePwaModal: {
    enabled: false,
    description: 'Stores landing auth/invite state for PWA handoff and shows pending invites inside the installed app.',
  },
  friends: {
    enabled: true,
    description: 'Friends list, friend requests, and unfriend actions.',
  },
  directMessages: {
    enabled: true,
    description: '1:1 direct messages with mutual friends.',
  },
  userBlock: {
    enabled: true,
    description: 'Blocklist (Chahua-side 「拉黑」) affecting DM and friend relationships only.',
  },
} as const;

export type Feature = keyof typeof FEATURES;

export function isFeatureEnabled(feature: Feature): boolean {
  if (__FEATURE_GATES_ENABLED__) {
    return true;
  }

  return FEATURES[feature].enabled;
}

export function whenFeature<T>(feature: Feature, value: T): T | null {
  return isFeatureEnabled(feature) ? value : null;
}

export function featureGatedList<T>(items: readonly (T | null | false | undefined)[]): T[] {
  return items.filter((item): item is T => item !== null && item !== undefined && item !== false);
}
