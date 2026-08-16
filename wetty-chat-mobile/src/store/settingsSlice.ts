import { MAX_PINNED_REACTIONS } from '@/constants/emojiAndStickers';
import type { PayloadAction } from '@reduxjs/toolkit';
import { createSlice, current } from '@reduxjs/toolkit';
import type { RootState } from './index';
import { kvSet } from '@/utils/db';

export const supportedLocales = ['en', 'zh-CN', 'zh-TW'];
export const defaultLocale = 'en';
export const chatFontSizeOptions = ['small', 'mediumSmall', 'medium', 'mediumLarge', 'large'] as const;
export type ChatFontSizeOption = (typeof chatFontSizeOptions)[number];
export const defaultChatFontSize: ChatFontSizeOption = 'medium';

const chatFontSizeStyles: Record<ChatFontSizeOption, string> = {
  small: '12px',
  mediumSmall: '14px',
  medium: 'inherit',
  mediumLarge: '18px',
  large: '20px',
};

export function detectLocale(): string {
  for (const lang of navigator.languages) {
    if (supportedLocales.includes(lang)) return lang;
    const base = lang.split('-')[0];
    const match = supportedLocales.find((l) => l.split('-')[0] === base);
    if (match) return match;
  }
  return defaultLocale;
}

export interface SettingsState {
  locale: string | null;
  messageFontSize: ChatFontSizeOption;
  showAllTab: boolean;
  showGroupsTab: boolean;
  showFriendsTab: boolean;
  showThreadsTab: boolean;
  showAllAvatars: boolean;
  pinnedReactions: string[];
  recentReactions: string[];
  /** Selected chat list segment tab; ephemeral UI state, never persisted. */
  chatListTab: 'all' | 'groups' | 'friends' | 'threads';
}

export function isChatFontSizeOption(value: unknown): value is ChatFontSizeOption {
  return typeof value === 'string' && chatFontSizeOptions.includes(value as ChatFontSizeOption);
}

function normalizePinnedReactions(reactions: string[]): string[] {
  return Array.from(new Set(reactions)).slice(0, MAX_PINNED_REACTIONS);
}

function persistSettings(state: SettingsState) {
  const currentState = current(state);
  void kvSet('settings', {
    locale: currentState.locale,
    messageFontSize: currentState.messageFontSize,
    showAllTab: currentState.showAllTab,
    showGroupsTab: currentState.showGroupsTab,
    showFriendsTab: currentState.showFriendsTab,
    showThreadsTab: currentState.showThreadsTab,
    showAllAvatars: currentState.showAllAvatars,
    pinnedReactions: currentState.pinnedReactions,
    recentReactions: currentState.recentReactions,
  });
}

function persistEffectiveLocale(locale: string | null) {
  const effective = locale && supportedLocales.includes(locale) ? locale : detectLocale();
  void kvSet('effective_locale', effective);
}

export function getChatFontSizeStyle(messageFontSize: ChatFontSizeOption): string {
  return chatFontSizeStyles[messageFontSize];
}

const defaultSettings: SettingsState = {
  locale: null,
  messageFontSize: defaultChatFontSize,
  showAllTab: true,
  showGroupsTab: true,
  showFriendsTab: true,
  showThreadsTab: true,
  showAllAvatars: false,
  pinnedReactions: normalizePinnedReactions(['👍']),
  recentReactions: ['❤️', '😂', '😮', '😢', '🎉'],
  chatListTab: 'all',
};

export function hydrateSettings(saved: Partial<SettingsState> | null | undefined): SettingsState {
  return {
    ...defaultSettings,
    ...saved,
    messageFontSize: isChatFontSizeOption(saved?.messageFontSize) ? saved.messageFontSize : defaultChatFontSize,
    pinnedReactions: normalizePinnedReactions(saved?.pinnedReactions ?? defaultSettings.pinnedReactions),
    recentReactions: saved?.recentReactions ?? defaultSettings.recentReactions,
    // UI state, never persisted - always reset on hydrate.
    chatListTab: 'all',
  };
}

const settingsSlice = createSlice({
  name: 'settings',
  initialState: defaultSettings,
  reducers: {
    setLocale(state, action: PayloadAction<string | null>) {
      state.locale = action.payload;
      persistSettings(state);
      persistEffectiveLocale(state.locale);
    },
    setMessageFontSize(state, action: PayloadAction<ChatFontSizeOption>) {
      state.messageFontSize = action.payload;
      persistSettings(state);
    },
    setShowAllTab(state, action: PayloadAction<boolean>) {
      state.showAllTab = action.payload;
      persistSettings(state);
    },
    setShowGroupsTab(state, action: PayloadAction<boolean>) {
      state.showGroupsTab = action.payload;
      persistSettings(state);
    },
    setShowFriendsTab(state, action: PayloadAction<boolean>) {
      state.showFriendsTab = action.payload;
      persistSettings(state);
    },
    setShowThreadsTab(state, action: PayloadAction<boolean>) {
      state.showThreadsTab = action.payload;
      persistSettings(state);
    },
    setChatListTab(state, action: PayloadAction<SettingsState['chatListTab']>) {
      state.chatListTab = action.payload;
    },
    setShowAllAvatars(state, action: PayloadAction<boolean>) {
      state.showAllAvatars = action.payload;
      persistSettings(state);
    },
    setPinnedReactions(state, action: PayloadAction<string[]>) {
      state.pinnedReactions = normalizePinnedReactions(action.payload);
      persistSettings(state);
    },
    addRecentReaction(state, action: PayloadAction<string>) {
      const emoji = action.payload;
      if (!state.pinnedReactions.includes(emoji)) {
        state.recentReactions = [emoji, ...state.recentReactions.filter((r) => r !== emoji)].slice(0, 30);
        persistSettings(state);
      }
    },
  },
});

export const {
  setLocale,
  setMessageFontSize,
  setShowAllTab,
  setShowGroupsTab,
  setShowFriendsTab,
  setShowThreadsTab,
  setChatListTab,
  setShowAllAvatars,
  setPinnedReactions,
  addRecentReaction,
} = settingsSlice.actions;
export const selectLocale = (state: RootState) => state.settings.locale;
export const selectEffectiveLocale = (state: RootState) => state.settings.locale ?? detectLocale();
export const selectMessageFontSize = (state: RootState) => state.settings.messageFontSize;
export const selectShowAllTab = (state: RootState) => state.settings.showAllTab;
export const selectShowGroupsTab = (state: RootState) => state.settings.showGroupsTab;
export const selectShowFriendsTab = (state: RootState) => state.settings.showFriendsTab;
export const selectShowThreadsTab = (state: RootState) => state.settings.showThreadsTab;
export const selectChatListTab = (state: RootState) => state.settings.chatListTab;
export const selectShowAllAvatars = (state: RootState) => state.settings.showAllAvatars;
export const selectPinnedReactions = (state: RootState) => state.settings.pinnedReactions;
export const selectRecentReactions = (state: RootState) => state.settings.recentReactions;
export const selectChatFontSizeStyle = (state: RootState) => getChatFontSizeStyle(state.settings.messageFontSize);
export default settingsSlice.reducer;
