export const CHAT_LIST_TABS = ['messages', 'groups', 'friends', 'threads'] as const;

export type ChatListTab = (typeof CHAT_LIST_TABS)[number];
