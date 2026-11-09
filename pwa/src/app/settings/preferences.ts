import { readChatFontSize, ChatFontSize } from './chat-font-size';
import { computed, inject, Service, signal } from '@angular/core';
import { SessionStore } from '../session/session-store';
import { AccountStorage, AccountStore } from '../storage/account-storage';
import { ColorMode, isColorMode } from './color-mode';
import { type AppLocale, isAppLocale } from './locale';

const THREADS_KEY = 'showThreadsInMessages';
const REACTIONS_KEY = 'recentReactions';
const PINNED_REACTIONS_KEY = 'pinnedReactions';

const AVATARS_KEY = 'showAllAvatars';
const DM_DETAILS_KEY = 'showDmDetails';

const COLOR_MODE_KEY = 'chahua.preferences.colorMode';
const LOCALE_KEY = 'chahua.preferences.locale';
const ERROR_DIAGNOSTICS_KEY = 'chahua.preferences.showDiagnosticsOnError';

@Service()
export class Preferences {
  private readonly session = inject(SessionStore);
  private readonly storage = inject(AccountStorage);
  private readonly fontSize = signal(readChatFontSize());
  readonly chatFontSize = this.fontSize.asReadonly();

  setChatFontSize(value: ChatFontSize) {
    window.localStorage.setItem('chahua.preferences.chatFontSize', String(value));
    this.fontSize.set(value);
  }

  readonly recentReactions = computed(() => readReactions(this.storage.read(AccountStore.Usage, REACTIONS_KEY, null)));
  readonly pinnedReactions = computed(() =>
    readPinnedReactions(this.storage.read(AccountStore.Preferences, PINNED_REACTIONS_KEY, null)),
  );
  private readonly locale = signal<AppLocale | null>(readLocale());
  rememberReaction(emoji: string) {
    if (this.pinnedReactions().includes(emoji)) return;
    this.storage.set(
      AccountStore.Usage,
      REACTIONS_KEY,
      [emoji, ...this.recentReactions().filter((item) => item !== emoji)].slice(0, 5),
    );
  }

  setPinnedReactions(reactions: readonly string[]) {
    const pinned = [...new Set(reactions)].slice(0, 5);
    this.storage.set(AccountStore.Preferences, PINNED_REACTIONS_KEY, pinned);
  }

  private readonly errorDiagnostics = signal(window.localStorage.getItem(ERROR_DIAGNOSTICS_KEY) !== 'false');
  readonly showDiagnosticsOnError = this.errorDiagnostics.asReadonly();
  private readonly mode = signal(readColorMode());
  readonly showThreadsInMessages = computed(() => this.storage.read(AccountStore.Preferences, THREADS_KEY, true));
  readonly showAllAvatars = computed(() => this.storage.read(AccountStore.Preferences, AVATARS_KEY, false));
  readonly showDmDetails = computed(() => this.storage.read(AccountStore.Preferences, DM_DETAILS_KEY, true));
  readonly showMembershipMessages = computed(() => this.session.user()?.showMembershipMessages ?? true);
  readonly colorMode = this.mode.asReadonly();
  readonly selectedLocale = this.locale.asReadonly();

  setShowThreadsInMessages(value: boolean) {
    this.storage.set(AccountStore.Preferences, THREADS_KEY, value);
  }

  setShowDiagnosticsOnError(value: boolean) {
    window.localStorage.setItem(ERROR_DIAGNOSTICS_KEY, String(value));
    this.errorDiagnostics.set(value);
  }

  setShowAllAvatars(value: boolean) {
    this.storage.set(AccountStore.Preferences, AVATARS_KEY, value);
  }

  setShowDmDetails(value: boolean) {
    this.storage.set(AccountStore.Preferences, DM_DETAILS_KEY, value);
  }

  setShowMembershipMessages(value: boolean) {
    return this.session.setShowMembershipMessages(value);
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

function readReactions(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 5)
    : DEFAULT_REACTIONS;
}

const DEFAULT_REACTIONS: readonly string[] = ['❤️', '😂', '😮', '😢', '🎉'];
const DEFAULT_PINNED_REACTIONS: readonly string[] = ['👍'];

function readPinnedReactions(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))].slice(0, 5)
    : DEFAULT_PINNED_REACTIONS;
}
