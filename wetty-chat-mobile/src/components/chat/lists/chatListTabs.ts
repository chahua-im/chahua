export const CHAT_LIST_TABS = ['messages', 'groups', 'friends', 'threads'] as const;
export const ARCHIVED_FRIEND_REQUESTS_PATH = '/chats/friends/archived-requests';

export type ChatListTab = (typeof CHAT_LIST_TABS)[number];
