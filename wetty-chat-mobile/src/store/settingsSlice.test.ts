import { describe, expect, it } from 'vitest';
import { hasLegacyChatListSettings, hydrateSettings, serializeSettings, type StoredSettings } from './settingsSlice';

describe('settings migration', () => {
  it('removes obsolete chat-list preferences from stored settings', () => {
    const saved: StoredSettings = {
      showAllTab: false,
      showGroupsTab: false,
      showFriendsTab: false,
      showThreadsTab: false,
    };

    expect(hasLegacyChatListSettings(saved)).toBe(true);

    const hydrated = hydrateSettings(saved);
    expect(hydrated).toMatchObject({ showThreadsInMessages: true, chatListTab: 'messages' });
    expect(hydrated).not.toHaveProperty('showAllTab');
    expect(hydrated).not.toHaveProperty('showGroupsTab');
    expect(hydrated).not.toHaveProperty('showFriendsTab');
    expect(hydrated).not.toHaveProperty('showThreadsTab');
    expect(serializeSettings(hydrated)).toEqual({
      locale: null,
      messageFontSize: 'medium',
      showThreadsInMessages: true,
      showAllAvatars: false,
      pinnedReactions: ['👍'],
      recentReactions: ['❤️', '😂', '😮', '😢', '🎉'],
    });
  });
});
