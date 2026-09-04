import { MAX_PINNED_REACTIONS } from '@/constants/emojiAndStickers';
import type { PayloadAction } from '@reduxjs/toolkit';
import { createSlice, current } from '@reduxjs/toolkit';
import type { RootState } from './index';
import { kvSet } from '@/utils/db';
import { isColorMode, type ColorMode } from '@/utils/colorMode';

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
  colorMode: ColorMode;
  messageFontSize: ChatFontSizeOption;
  showThreadsInMessages: boolean;
  showAllAvatars: boolean;
  pinnedReactions: string[];
  recentReactions: string[];
  /** Selected chat list segment tab; ephemeral UI state, never persisted. */
  chatListTab: 'messages' | 'groups' | 'friends' | 'threads';
}

type LegacyChatListSettings = {
  showAllTab?: boolean;
  showGroupsTab?: boolean;
  showFriendsTab?: boolean;
  showThreadsTab?: boolean;
};

export type StoredSettings = Partial<SettingsState> & LegacyChatListSettings;

export function hasLegacyChatListSettings(saved: StoredSettings | null | undefined): boolean {
  return Boolean(
    saved &&
    ('showAllTab' in saved || 'showGroupsTab' in saved || 'showFriendsTab' in saved || 'showThreadsTab' in saved),
  );
}

export function isChatFontSizeOption(value: unknown): value is ChatFontSizeOption {
  return typeof value === 'string' && chatFontSizeOptions.includes(value as ChatFontSizeOption);
}

function normalizePinnedReactions(reactions: string[]): string[] {
  return Array.from(new Set(reactions)).slice(0, MAX_PINNED_REACTIONS);
}

export function serializeSettings(state: SettingsState) {
  return {
    locale: state.locale,
    colorMode: state.colorMode,
    messageFontSize: state.messageFontSize,
    showThreadsInMessages: state.showThreadsInMessages,
    showAllAvatars: state.showAllAvatars,
    pinnedReactions: state.pinnedReactions,
    recentReactions: state.recentReactions,
  };
}

function persistSettings(state: SettingsState) {
  void kvSet('settings', serializeSettings(current(state)));
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
  colorMode: 'system',
  messageFontSize: defaultChatFontSize,
  showThreadsInMessages: true,
  showAllAvatars: false,
  pinnedReactions: normalizePinnedReactions(['👍']),
  recentReactions: ['❤️', '😂', '😮', '😢', '🎉'],
  chatListTab: 'messages',
};

export function hydrateSettings(saved: StoredSettings | null | undefined): SettingsState {
  const persistedSettings = { ...saved };
  delete persistedSettings.showAllTab;
  delete persistedSettings.showGroupsTab;
  delete persistedSettings.showFriendsTab;
  delete persistedSettings.showThreadsTab;

  return {
    ...defaultSettings,
    ...persistedSettings,
    colorMode: isColorMode(saved?.colorMode) ? saved.colorMode : defaultSettings.colorMode,
    messageFontSize: isChatFontSizeOption(saved?.messageFontSize) ? saved.messageFontSize : defaultChatFontSize,
    pinnedReactions: normalizePinnedReactions(saved?.pinnedReactions ?? defaultSettings.pinnedReactions),
    recentReactions: saved?.recentReactions ?? defaultSettings.recentReactions,
    // UI state, never persisted - always reset on hydrate.
    chatListTab: 'messages',
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
    setColorMode(state, action: PayloadAction<ColorMode>) {
      state.colorMode = action.payload;
      persistSettings(state);
    },
    setMessageFontSize(state, action: PayloadAction<ChatFontSizeOption>) {
      state.messageFontSize = action.payload;
      persistSettings(state);
    },
    setShowThreadsInMessages(state, action: PayloadAction<boolean>) {
      state.showThreadsInMessages = action.payload;
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
  setColorMode,
  setMessageFontSize,
  setShowThreadsInMessages,
  setChatListTab,
  setShowAllAvatars,
  setPinnedReactions,
  addRecentReaction,
} = settingsSlice.actions;
export const selectLocale = (state: RootState) => state.settings.locale;
export const selectColorMode = (state: RootState) => state.settings.colorMode;
export const selectEffectiveLocale = (state: RootState) => state.settings.locale ?? detectLocale();
export const selectMessageFontSize = (state: RootState) => state.settings.messageFontSize;
export const selectShowThreadsInMessages = (state: RootState) => state.settings.showThreadsInMessages;
export const selectChatListTab = (state: RootState) => state.settings.chatListTab;
export const selectShowAllAvatars = (state: RootState) => state.settings.showAllAvatars;
export const selectPinnedReactions = (state: RootState) => state.settings.pinnedReactions;
export const selectRecentReactions = (state: RootState) => state.settings.recentReactions;
export const selectChatFontSizeStyle = (state: RootState) => getChatFontSizeStyle(state.settings.messageFontSize);
export default settingsSlice.reducer;
