import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ColorMode } from './color-mode';
import { Preferences } from './preferences';

describe('Preferences', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts with threads visible and grouped avatars', () => {
    const preferences = TestBed.inject(Preferences);
    expect(preferences.showThreadsInMessages()).toBe(true);
    expect(preferences.showAllAvatars()).toBe(false);
  });

  it('persists both settings and restores them in a fresh service', () => {
    const preferences = TestBed.inject(Preferences);
    preferences.setShowThreadsInMessages(false);
    preferences.setShowAllAvatars(true);
    expect(preferences.showThreadsInMessages()).toBe(false);
    expect(preferences.showAllAvatars()).toBe(true);
    TestBed.resetTestingModule();
    const restored = TestBed.inject(Preferences);
    expect(restored.showThreadsInMessages()).toBe(false);
    expect(restored.showAllAvatars()).toBe(true);
    restored.setShowThreadsInMessages(true);
    restored.setShowAllAvatars(false);
    TestBed.resetTestingModule();
    expect(TestBed.inject(Preferences).showThreadsInMessages()).toBe(true);
    expect(TestBed.inject(Preferences).showAllAvatars()).toBe(false);
  });
  it('remembers the last five distinct reactions across fresh service instances', () => {
    const preferences = TestBed.inject(Preferences);
    for (const emoji of ['👍', '❤️', '😂', '😮', '😢', '🍵', '❤️']) preferences.rememberReaction(emoji);
    TestBed.resetTestingModule();
    expect(TestBed.inject(Preferences).recentReactions()).toEqual(['❤️', '🍵', '😢', '😮', '😂']);
  });

  it('follows the system color mode by default and persists an explicit choice', () => {
    const preferences = TestBed.inject(Preferences);
    expect(preferences.colorMode()).toBe(ColorMode.System);
    preferences.setColorMode(ColorMode.Dark);
    expect(localStorage.getItem('chahua.preferences.colorMode')).toBe('dark');
    TestBed.resetTestingModule();
    expect(TestBed.inject(Preferences).colorMode()).toBe(ColorMode.Dark);
  });

  it('falls back to the system color mode when the stored value is unknown', () => {
    localStorage.setItem('chahua.preferences.colorMode', 'sepia');
    expect(TestBed.inject(Preferences).colorMode()).toBe(ColorMode.System);
  });
});
