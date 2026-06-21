import { t } from '@lingui/core/macro';
import { useSyncExternalStore } from 'react';
import { kvDelete, kvGet, kvSet } from '@/utils/db';

// ============================================================
// Adding a new advanced setting:
//   1. Add a property + default to ADVANCED_DEFAULTS
//   2. (Optional) Add a typed getter / hook below
// That's it. Lock resets everything automatically.
// ============================================================

// --- Advanced settings schema ---

interface AdvancedSettings {
  longPressDelayMs: number;
}

const ADVANCED_DEFAULTS: Readonly<AdvancedSettings> = {
  longPressDelayMs: 350,
} as const;

// --- Constants (importable by UI) ---

export interface LongPressPreset {
  value: number;
  label: string;
}

export function getLongPressPresets(): LongPressPreset[] {
  return [
    { value: 150, label: t`Fast (150ms)` },
    { value: 350, label: t`Default (350ms)` },
    { value: 600, label: t`Slow (600ms)` },
    { value: 1000, label: t`Very Slow (1000ms)` },
  ];
}

export const LONG_PRESS_CUSTOM_MIN = 5;
export const LONG_PRESS_CUSTOM_MAX = 1500;

export function isCustomLongPressValue(ms: number): boolean {
  return getLongPressPresets().every((p) => p.value !== ms);
}

// --- Pub/Sub ---

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of listeners) l();
}

// --- Single IDB key for all advanced settings ---

const SETTINGS_KEY = 'advanced_settings';
const UNLOCK_KEY = 'advanced_settings_unlocked';

// In-memory state
let unlockedCache = false;
let settingsCache: AdvancedSettings = { ...ADVANCED_DEFAULTS };

// --- Init (call once in bootstrap) ---

export async function initAdvancedSettings(): Promise<void> {
  const [storedUnlock, storedSettings] = await Promise.all([
    kvGet<boolean>(UNLOCK_KEY),
    kvGet<AdvancedSettings>(SETTINGS_KEY),
  ]);
  unlockedCache = storedUnlock ?? false;
  if (storedSettings) {
    settingsCache = { ...ADVANCED_DEFAULTS, ...storedSettings };
  }
}

// --- Unlock / Lock ---

function getUnlockedSnapshot(): boolean {
  return unlockedCache;
}

export function isAdvancedSettingsUnlocked(): boolean {
  return unlockedCache;
}

export function unlockAdvancedSettings(): void {
  if (unlockedCache) return;
  unlockedCache = true;
  kvSet(UNLOCK_KEY, true);
  notify();
}

export function lockAdvancedSettings(): void {
  if (!unlockedCache) return;
  unlockedCache = false;
  settingsCache = { ...ADVANCED_DEFAULTS };
  kvSet(UNLOCK_KEY, false);
  kvDelete(SETTINGS_KEY);
  notify();
}

export function toggleAdvancedSettings(): void {
  if (unlockedCache) {
    lockAdvancedSettings();
  } else {
    unlockAdvancedSettings();
  }
}

export function useAdvancedSettingsUnlocked(): boolean {
  return useSyncExternalStore(subscribe, getUnlockedSnapshot, () => false);
}

// --- Generic settings accessor ---

function setSetting<K extends keyof AdvancedSettings>(key: K, value: AdvancedSettings[K]): void {
  settingsCache = { ...settingsCache, [key]: value };
  kvSet(SETTINGS_KEY, settingsCache);
  notify();
}

// --- Long Press Delay ---

function getLongPressDelaySnapshot(): number {
  return settingsCache.longPressDelayMs;
}

export function getLongPressDelayMs(): number {
  return getLongPressDelaySnapshot();
}

export function setLongPressDelayMs(ms: number): void {
  setSetting('longPressDelayMs', ms);
}

export function useLongPressDelayMs(): number {
  return useSyncExternalStore(subscribe, getLongPressDelaySnapshot, () => ADVANCED_DEFAULTS.longPressDelayMs);
}
