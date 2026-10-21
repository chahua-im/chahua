import { readChatFontSize, ChatFontSize } from './chat-font-size';
import { Service, signal } from '@angular/core';
import { ColorMode, isColorMode } from './color-mode';
import { type AppLocale, isAppLocale } from './locale';

const THREADS_KEY = 'chahua.preferences.showThreadsInMessages';
const REACTIONS_KEY = 'chahua.preferences.recentReactions';
const PINNED_REACTIONS_KEY = 'chahua.preferences.pinnedReactions';

const AVATARS_KEY = 'chahua.preferences.showAllAvatars';
const DM_DETAILS_KEY = 'chahua.preferences.showDmDetails';

const COLOR_MODE_KEY = 'chahua.preferences.colorMode';
const LOCALE_KEY = 'chahua.preferences.locale';

@Service()
export class Preferences {
  private readonly fontSize = signal(readChatFontSize());
  readonly chatFontSize = this.fontSize.asReadonly();

  setChatFontSize(value: ChatFontSize) {
    window.localStorage.setItem('chahua.preferences.chatFontSize', String(value));
    this.fontSize.set(value);
  }

  readonly recentReactions = signal<readonly string[]>(readReactions());
  readonly pinnedReactions = signal<readonly string[]>(readPinnedReactions());
  private readonly locale = signal<AppLocale | null>(readLocale());
  rememberReaction(emoji: string) {
    if (this.pinnedReactions().includes(emoji)) return;
    this.recentReactions.update((items) => [emoji, ...items.filter((item) => item !== emoji)].slice(0, 5));
    window.localStorage.setItem(REACTIONS_KEY, JSON.stringify(this.recentReactions()));
  }

  setPinnedReactions(reactions: string[]) {
    const pinned = [...new Set(reactions)].slice(0, 5);
    window.localStorage.setItem(PINNED_REACTIONS_KEY, JSON.stringify(pinned));
    this.pinnedReactions.set(pinned);
  }

  private readonly threads = signal(window.localStorage.getItem(THREADS_KEY) !== 'false');
  private readonly avatars = signal(window.localStorage.getItem(AVATARS_KEY) === 'true');
  private readonly dmDetails = signal(window.localStorage.getItem(DM_DETAILS_KEY) !== 'false');
  private readonly mode = signal(readColorMode());
  readonly showThreadsInMessages = this.threads.asReadonly();
  readonly showAllAvatars = this.avatars.asReadonly();
  readonly showDmDetails = this.dmDetails.asReadonly();
  readonly colorMode = this.mode.asReadonly();
  readonly selectedLocale = this.locale.asReadonly();

  setShowThreadsInMessages(value: boolean) {
    window.localStorage.setItem(THREADS_KEY, String(value));
    this.threads.set(value);
  }

  setShowAllAvatars(value: boolean) {
    window.localStorage.setItem(AVATARS_KEY, String(value));
    this.avatars.set(value);
  }

  setShowDmDetails(value: boolean) {
    window.localStorage.setItem(DM_DETAILS_KEY, String(value));
    this.dmDetails.set(value);
  }

  setColorMode(value: ColorMode) {
    window.localStorage.setItem(COLOR_MODE_KEY, value);
    this.mode.set(value);
  }

  setLocale(value: AppLocale | null) {
    if (value) window.localStorage.setItem(LOCALE_KEY, value);
    else window.localStorage.removeItem(LOCALE_KEY);
    this.locale.set(value);
  }
}

function readColorMode(): ColorMode {
  const value = window.localStorage.getItem(COLOR_MODE_KEY);
  return isColorMode(value) ? value : ColorMode.System;
}

function readLocale(): AppLocale | null {
  const value = window.localStorage.getItem(LOCALE_KEY);
  return isAppLocale(value) ? value : null;
}

function readReactions(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(REACTIONS_KEY) ?? 'null');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, 5)
      : DEFAULT_REACTIONS;
  } catch {
    return DEFAULT_REACTIONS;
  }
}

const DEFAULT_REACTIONS = ['❤️', '😂', '😮', '😢', '🎉'];
const DEFAULT_PINNED_REACTIONS = ['👍'];

function readPinnedReactions(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PINNED_REACTIONS_KEY) ?? 'null');
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string'))].slice(0, 5)
      : DEFAULT_PINNED_REACTIONS;
  } catch {
    return DEFAULT_PINNED_REACTIONS;
  }
}
