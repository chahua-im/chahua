export type ChatListTab = 'messages' | 'groups' | 'friends' | 'threads';

export function normalizeChatListTab(tab?: string): ChatListTab {
  switch (tab) {
    case 'threads':
    case 'groups':
    case 'messages':
    case 'friends':
      return tab;
    default:
      return 'messages';
  }
}
