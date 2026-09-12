import { Service } from '@angular/core';
import type { Draft } from '../conversations/draft-store';

const DATABASE = 'wetty';
const MIGRATION_KEY = 'chahua.migration.wetty';

enum MigrationState {
  Copied = 'copied',
  Complete = 'true',
}

/** Runs before components and preference stores are created. */
@Service()
export class LegacyMigration {
  async run() {
    const state = localStorage.getItem(MIGRATION_KEY);
    if (state === MigrationState.Complete || !('indexedDB' in window)) return;
    try {
      if (state === MigrationState.Copied) {
        deleteLegacy();
        return;
      }
      const db = await openExisting();
      if (!db) return;
      let legacy: Record<string, unknown>;
      try {
        const store = db.transaction('kv').objectStore('kv');
        const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
        legacy = Object.fromEntries(keys.map((key, index) => [String(key), values[index]]));
      } finally {
        db.close();
      }

      const token = legacy['jwt_token'];
      // The old database may contain the only surviving login credential.
      if (typeof token === 'string' && token) saveMissing('jwt_token', token);
      const uid = tokenUid(token);
      const settings = legacy['settings'] as Record<string, unknown> | undefined;
      for (const name of ['showThreadsInMessages', 'showAllAvatars']) {
        if (typeof settings?.[name] === 'boolean') saveMissing(`chahua.preferences.${name}`, String(settings[name]));
      }
      if (Array.isArray(settings?.['recentReactions'])) {
        saveMissing(
          'chahua.preferences.recentReactions',
          JSON.stringify(settings['recentReactions'].filter((item) => typeof item === 'string').slice(0, 5)),
        );
      }

      delete legacy['jwt_token'];
      delete legacy['client_id'];
      delete legacy['effective_locale'];
      if (uid != null) {
        const key = `chahua.drafts.${uid}`;
        const drafts: Record<string, Draft> = JSON.parse(localStorage.getItem(key) ?? '{}');
        for (const [oldKey, value] of Object.entries(legacy)) {
          const match = /^draft:(\d+)(?:_thread_(\d+))?$/.exec(oldKey);
          if (!match) continue;
          const old = value as { text: string; replyToMessageId?: string; savedAt?: number };
          if (typeof old?.text !== 'string') throw new Error(`Invalid legacy draft: ${oldKey}`);
          const draftKey = `${match[1]}${match[2] ? `/${match[2]}` : ''}`;
          const draft = { text: old.text, replyTo: old.replyToMessageId, savedAt: old.savedAt ?? 0 };
          if (!drafts[draftKey] || drafts[draftKey].savedAt < draft.savedAt) drafts[draftKey] = draft;
          delete legacy[oldKey];
        }
        localStorage.setItem(key, JSON.stringify(drafts));
      }
      // Preserve preferences without a current UI, and drafts whose owner cannot be identified.
      localStorage.setItem('chahua.migration.wetty.backup', JSON.stringify(legacy));
      localStorage.setItem(MIGRATION_KEY, MigrationState.Copied);
      deleteLegacy();
    } catch (error) {
      // Failed reads/writes leave the old database intact for a later attempt.
      console.error('Unable to migrate legacy storage', error);
    }
  }
}

function deleteLegacy() {
  // Never wait for old tabs to close, or queue another startup read behind this deletion.
  const deletion = indexedDB.deleteDatabase(DATABASE);
  deletion.onsuccess = () => {
    try {
      localStorage.setItem(MIGRATION_KEY, MigrationState.Complete);
    } catch (error) {
      console.error('Unable to mark legacy migration complete', error);
    }
  };
  deletion.onerror = () => console.error('Unable to delete legacy storage', deletion.error);
}

function saveMissing(key: string, value: string) {
  if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
}

function tokenUid(token: unknown): number | undefined {
  if (typeof token !== 'string') return;
  try {
    const { uid } = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (Number.isSafeInteger(uid) && uid > 0) return uid;
  } catch {
    // An unreadable token leaves drafts in the backup without assigning an owner.
  }
  return undefined;
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function openExisting(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE);
    let missing = false;
    opening.onupgradeneeded = () => {
      missing = true;
      opening.transaction!.abort(); // Detect absence without creating an empty legacy database.
    };
    opening.onerror = () => (missing ? resolve(undefined) : reject(opening.error));
    opening.onsuccess = () => resolve(opening.result);
  });
}
