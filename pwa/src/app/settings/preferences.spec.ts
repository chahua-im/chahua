import { stubIndexedDB } from '../storage/testing';
import { AccountStorage } from '../storage/account-storage';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ChatFontSize } from './chat-font-size';
import { ColorMode } from './color-mode';
import { SessionStore } from '../session/session-store';
import { testUser } from '../api/testing';
import { Preferences } from './preferences';

describe('Preferences', () => {
  beforeEach(async () => {
    stubIndexedDB();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
    });
    await TestBed.inject(AccountStorage).activate(1);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('persists message font size and restores the platform default for invalid storage', async () => {
    const preferences = TestBed.inject(Preferences);
    expect(preferences.chatFontSize()).toBe(ChatFontSize.Medium);
    preferences.setChatFontSize(ChatFontSize.Large);
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    expect(TestBed.inject(Preferences).chatFontSize()).toBe(ChatFontSize.Large);
    localStorage.setItem('chahua.preferences.chatFontSize', '99');
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    expect(TestBed.inject(Preferences).chatFontSize()).toBe(ChatFontSize.Medium);
  });

  it('starts with threads and dm details visible, and grouped avatars', async () => {
    const preferences = TestBed.inject(Preferences);
    expect(preferences.showThreadsInMessages()).toBe(true);
    expect(preferences.showAllAvatars()).toBe(false);
    expect(preferences.showDmDetails()).toBe(true);
  });

  it('defaults error diagnostics to visible and persists changes across service instances', async () => {
    const preferences = TestBed.inject(Preferences);
    expect(preferences.showDiagnosticsOnError()).toBe(true);
    preferences.setShowDiagnosticsOnError(false);
    expect(preferences.showDiagnosticsOnError()).toBe(false);
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    const restored = TestBed.inject(Preferences);
    expect(restored.showDiagnosticsOnError()).toBe(false);
    restored.setShowDiagnosticsOnError(true);
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    expect(TestBed.inject(Preferences).showDiagnosticsOnError()).toBe(true);
  });

  it('persists display settings and restores them in a fresh service', async () => {
    const preferences = TestBed.inject(Preferences);
    preferences.setShowThreadsInMessages(false);
    preferences.setShowAllAvatars(true);
    preferences.setShowDmDetails(false);
    expect(preferences.showThreadsInMessages()).toBe(false);
    expect(preferences.showAllAvatars()).toBe(true);
    expect(preferences.showDmDetails()).toBe(false);
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    const restored = TestBed.inject(Preferences);
    expect(restored.showThreadsInMessages()).toBe(false);
    expect(restored.showAllAvatars()).toBe(true);
    expect(restored.showDmDetails()).toBe(false);
    restored.setShowThreadsInMessages(true);
    restored.setShowAllAvatars(false);
    restored.setShowDmDetails(true);
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    expect(TestBed.inject(Preferences).showThreadsInMessages()).toBe(true);
    expect(TestBed.inject(Preferences).showAllAvatars()).toBe(false);
    expect(TestBed.inject(Preferences).showDmDetails()).toBe(true);
  });
  it('uses the current account preference and ignores the legacy browser value', async () => {
    localStorage.setItem('chahua.preferences.showMembershipMessages', 'false');
    const preferences = TestBed.inject(Preferences);
    const session = TestBed.inject(SessionStore);
    session.user.set({ ...testUser, showMembershipMessages: true });
    expect(preferences.showMembershipMessages()).toBe(true);
    session.user.set({ ...testUser, showMembershipMessages: false });
    expect(preferences.showMembershipMessages()).toBe(false);
    session.user.set({ ...testUser, uid: 2, showMembershipMessages: true });
    expect(preferences.showMembershipMessages()).toBe(true);
    expect(localStorage.getItem('chahua.preferences.showMembershipMessages')).toBe('false');
  });

  it('remembers the last five distinct reactions across fresh service instances', async () => {
    const preferences = TestBed.inject(Preferences);
    for (const emoji of ['👍', '❤️', '😂', '😮', '😢', '🍵', '❤️']) preferences.rememberReaction(emoji);
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    expect(TestBed.inject(Preferences).recentReactions()).toEqual(['❤️', '🍵', '😢', '😮', '😂']);
  });

  it('pins reactions by default and keeps pinned out of recents', async () => {
    const preferences = TestBed.inject(Preferences);
    expect(preferences.pinnedReactions()).toEqual(['👍']);
    expect(preferences.recentReactions()).toEqual(['❤️', '😂', '😮', '😢', '🎉']);
    preferences.setPinnedReactions(['👍', '👍', '❤️', '😂', '😮', '😢', '🎉']);
    expect(preferences.pinnedReactions()).toEqual(['👍', '❤️', '😂', '😮', '😢']);
    preferences.rememberReaction('👍');
    preferences.rememberReaction('🍵');
    expect(preferences.recentReactions()).toEqual(['🍵', '❤️', '😂', '😮', '😢']);
  });

  it('restores pinned reactions in a fresh service', async () => {
    TestBed.inject(Preferences).setPinnedReactions(['🍵', '🫡']);
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    expect(TestBed.inject(Preferences).pinnedReactions()).toEqual(['🍵', '🫡']);
  });

  it('persists an explicit locale and clears it for auto', async () => {
    const preferences = TestBed.inject(Preferences);
    expect(preferences.selectedLocale()).toBeNull();
    preferences.setLocale('zh-TW');
    expect(localStorage.getItem('chahua.preferences.locale')).toBe('zh-TW');
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    const restored = TestBed.inject(Preferences);
    expect(restored.selectedLocale()).toBe('zh-TW');
    restored.setLocale(null);
    expect(localStorage.getItem('chahua.preferences.locale')).toBeNull();
  });

  it('ignores an unsupported saved locale', async () => {
    localStorage.setItem('chahua.preferences.locale', 'ja-JP');
    expect(TestBed.inject(Preferences).selectedLocale()).toBeNull();
  });

  it('follows the system color mode by default and persists an explicit choice', async () => {
    const preferences = TestBed.inject(Preferences);
    expect(preferences.colorMode()).toBe(ColorMode.System);
    preferences.setColorMode(ColorMode.Dark);
    expect(localStorage.getItem('chahua.preferences.colorMode')).toBe('dark');
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    await TestBed.inject(AccountStorage).activate(1);
    expect(TestBed.inject(Preferences).colorMode()).toBe(ColorMode.Dark);
  });

  it('falls back to the system color mode when the stored value is unknown', async () => {
    localStorage.setItem('chahua.preferences.colorMode', 'sepia');
    expect(TestBed.inject(Preferences).colorMode()).toBe(ColorMode.System);
  });
});
