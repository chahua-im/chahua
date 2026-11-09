import { delayNextGetAll, stubIndexedDB } from './testing';
import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { forceCloseDatabase, IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { ACCOUNT_DATABASE, type AccountDatabaseSchema } from './account-database';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { AccountStorage, AccountStore } from './account-storage';
import { LegacyMigration } from '../pwa/legacy-migration';
import { PickerRecents, PickerSkinTone } from '../messages/emoji-picker/picker-preferences';
import type { Emoji } from '@nicematic/emoji-picker';

const draft = (text: string, savedAt = 10) => ({ text, replyTo: '9007199254741001', savedAt });
const emoji: Emoji = {
  char: '🫡',
  name: 'saluting face',
  keywords: ['salute'],
  category: 'smileys',
  hasSkinTone: false,
};

describe('account persistence and migration', () => {
  beforeEach(() => {
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
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
  });

  afterEach(async () => {
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stores migrated and newly written values with inline keys in database version 1', async () => {
    localStorage.setItem('chahua.preferences.showAllAvatars', 'true');
    localStorage.setItem('chahua.preferences.recentReactions', '["🍵"]');
    localStorage.setItem('chahua.drafts.7', JSON.stringify({ '42': draft('migrated') }));
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    storage.set(AccountStore.Drafts, '42/43', draft('new'));
    await storage.settled();

    const db = await openDB<AccountDatabaseSchema>(ACCOUNT_DATABASE);
    const environment = new URL('/_api', location.origin).href;
    try {
      expect(db.version).toBe(1);
      expect([...db.objectStoreNames]).toEqual(['drafts', 'meta', 'preferences', 'usage']);
      const transaction = db.transaction([...db.objectStoreNames]);
      for (const name of db.objectStoreNames) {
        const store = transaction.objectStore(name);
        expect(store.keyPath).toEqual(name === 'meta' ? 'key' : ['environment', 'uid', 'key']);
        expect(store.autoIncrement).toBe(false);
        expect([...store.indexNames]).toEqual([]);
      }
      expect(await transaction.objectStore(AccountStore.Preferences).getAll()).toEqual([
        { environment, uid: 7, key: 'showAllAvatars', value: true },
      ]);
      expect(await transaction.objectStore(AccountStore.Usage).getAll()).toEqual([
        { environment, uid: 7, key: 'recentReactions', value: ['🍵'] },
      ]);
      const drafts = transaction.objectStore(AccountStore.Drafts);
      expect(await drafts.getAllKeys()).toEqual([
        [environment, 7, '42'],
        [environment, 7, '42/43'],
      ]);
      expect(await drafts.getAll()).toEqual([
        { environment, uid: 7, key: '42', value: draft('migrated') },
        { environment, uid: 7, key: '42/43', value: draft('new') },
      ]);
      const meta = transaction.objectStore('meta');
      expect(await meta.get('legacy-owner')).toEqual({ key: 'legacy-owner', value: [environment, 7] });
      expect(await meta.get('preference-defaults')).toEqual({
        key: 'preference-defaults',
        value: { showAllAvatars: true },
      });
      expect(await meta.get('chahua.drafts.7')).toEqual({ key: 'chahua.drafts.7', value: true });
      await transaction.done;
    } finally {
      db.close();
    }
  });

  it('recomputes only the changed store and refreshes all stores when the account changes', async () => {
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    const readPreferences = vi.fn(() => storage.read(AccountStore.Preferences, 'showAllAvatars', false));
    const readUsage = vi.fn(() => [...storage.read(AccountStore.Usage, 'recentReactions', [])]);
    const readDrafts = vi.fn(() => Object.values(storage.entries(AccountStore.Drafts)).map((item) => item?.text));
    const preferences = computed(readPreferences);
    const usage = computed(readUsage);
    const drafts = computed(readDrafts);
    const readAll = () => [preferences(), usage(), drafts()];
    const counts = () => [readPreferences, readUsage, readDrafts].map((read) => read.mock.calls.length);

    expect(readAll()).toEqual([false, [], []]);
    expect(counts()).toEqual([1, 1, 1]);
    storage.set(AccountStore.Drafts, '42', draft('saved'));
    expect(readAll()).toEqual([false, [], ['saved']]);
    expect(counts()).toEqual([1, 1, 2]);
    storage.set(AccountStore.Preferences, 'showAllAvatars', true);
    expect(readAll()).toEqual([true, [], ['saved']]);
    expect(counts()).toEqual([2, 1, 2]);
    storage.set(AccountStore.Usage, 'recentReactions', ['🍵']);
    expect(readAll()).toEqual([true, ['🍵'], ['saved']]);
    expect(counts()).toEqual([2, 2, 2]);
    storage.set(AccountStore.Drafts, '42', undefined);
    expect(readAll()).toEqual([true, ['🍵'], []]);
    expect(counts()).toEqual([2, 2, 3]);

    await storage.activate(8);
    expect(readAll()).toEqual([false, [], []]);
    await storage.activate(7);
    expect(readAll()).toEqual([true, ['🍵'], []]);
    storage.deactivate();
    expect(readAll()).toEqual([false, [], []]);
    expect(counts()).toEqual([5, 5, 6]);
  });

  it('assigns global usage once, seeds explicit preferences, and imports every UID-scoped draft', async () => {
    localStorage.setItem('chahua.preferences.showAllAvatars', 'true');
    localStorage.setItem('chahua.preferences.pinnedReactions', '["🍵"]');
    localStorage.setItem('chahua.preferences.recentReactions', '["😂"]');
    localStorage.setItem(
      'chahua.preferences.favoriteStickerOrder',
      '[{"stickerId":"9007199254741001","lastUsedOn":5}]',
    );
    localStorage.setItem('nicematic-recents', JSON.stringify([{ ...emoji, count: 3, lastUsed: 20 }]));
    localStorage.setItem('nicematic-skintone', '🏽');
    localStorage.setItem('chahua.drafts.7', JSON.stringify({ '42/43': draft('seven') }));
    localStorage.setItem('chahua.drafts.8', JSON.stringify({ '42': draft('eight') }));
    localStorage.setItem('chahua.drafts.undefined', JSON.stringify({ '42': draft('unknown') }));
    localStorage.setItem('chahua.migration.wetty.backup', '{"unassigned":"keep"}');
    localStorage.setItem('jwt_token', 'keep-token');
    localStorage.setItem('chahua.preferences.colorMode', 'dark');
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    expect(storage.read(AccountStore.Drafts, '42/43', null)).toEqual(draft('seven'));
    expect(storage.read(AccountStore.Preferences, 'showAllAvatars', false)).toBe(true);
    expect(storage.read(AccountStore.Usage, 'recentReactions', [])).toEqual(['😂']);
    expect(storage.read(AccountStore.Usage, 'favoriteStickerOrder', [])).toEqual([
      { stickerId: '9007199254741001', lastUsedOn: 5 },
    ]);
    expect(TestBed.inject(PickerRecents).recents()).toEqual([emoji]);
    expect(TestBed.inject(PickerSkinTone).currentSkinTone()).toBe('🏽');
    expect(localStorage.getItem('chahua.drafts.7')).toBeNull();
    expect(localStorage.getItem('chahua.drafts.8')).toBeNull();
    expect(localStorage.getItem('nicematic-recents')).toBeNull();
    await storage.activate(8);
    expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('eight'));
    expect(storage.read(AccountStore.Preferences, 'pinnedReactions', [])).toEqual(['🍵']);
    expect(storage.read(AccountStore.Usage, 'recentReactions', [])).toEqual([]);
    expect(TestBed.inject(PickerRecents).recents()).toEqual([]);
    expect(localStorage.getItem('jwt_token')).toBe('keep-token');
    expect(localStorage.getItem('chahua.preferences.colorMode')).toBe('dark');
    expect(localStorage.getItem('chahua.drafts.undefined')).toContain('unknown');
    expect(localStorage.getItem('chahua.migration.wetty.backup')).toContain('keep');
  });

  it('retains data across logout and reload, keeps pending writes with their owner, and isolates backend environments', async () => {
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    storage.set(AccountStore.Drafts, '42', draft('seven'));
    storage.set(AccountStore.Preferences, 'showAllAvatars', true);
    await storage.activate(8);
    expect(storage.entries(AccountStore.Drafts)).toEqual({});
    storage.set(AccountStore.Drafts, '42', draft('eight'));
    storage.deactivate();
    expect(storage.entries(AccountStore.Drafts)).toEqual({});
    await storage.settled();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    const restored = TestBed.inject(AccountStorage);
    await restored.activate(7);
    expect(restored.read(AccountStore.Drafts, '42', null)).toEqual(draft('seven'));
    await restored.activate(8);
    expect(restored.read(AccountStore.Drafts, '42', null)).toEqual(draft('eight'));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('https://another.example/_api')] });
    const other = TestBed.inject(AccountStorage);
    await other.activate(7);
    expect(other.entries(AccountStore.Drafts)).toEqual({});
    expect(other.read(AccountStore.Preferences, 'showAllAvatars', false)).toBe(false);
  });

  it('does not restore a deleted draft or overwrite new preferences after interrupted source cleanup', async () => {
    localStorage.setItem('chahua.drafts.7', JSON.stringify({ '42': draft('old') }));
    localStorage.setItem('chahua.preferences.recentReactions', '["😂"]');
    const remove = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('cleanup interrupted');
    });
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    expect(localStorage.getItem('chahua.drafts.7')).not.toBeNull();
    storage.set(AccountStore.Drafts, '42', undefined);
    storage.set(AccountStore.Usage, 'recentReactions', ['🍵']);
    await storage.settled();
    remove.mockRestore();
    storage.deactivate();
    await storage.activate(7);
    expect(storage.entries(AccountStore.Drafts)).toEqual({});
    expect(storage.read(AccountStore.Usage, 'recentReactions', [])).toEqual(['🍵']);
    expect(localStorage.getItem('chahua.drafts.7')).toBeNull();
    expect(localStorage.getItem('chahua.preferences.recentReactions')).toBeNull();
  });

  it('reopens after an abnormal database close and persists subsequent writes', async () => {
    let connection!: IDBDatabase;
    const open = indexedDB.open.bind(indexedDB);
    const openings = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
      const request = open(...args);
      request.addEventListener('success', () => (connection = request.result));
      return request;
    });
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    storage.set(AccountStore.Preferences, 'showAllAvatars', true);
    await storage.settled();
    const closed = new Promise<void>((resolve) =>
      connection.addEventListener('close', () => resolve(), { once: true }),
    );
    forceCloseDatabase(connection as unknown as Parameters<typeof forceCloseDatabase>[0]);
    await closed;
    expect(storage.read(AccountStore.Preferences, 'showAllAvatars', false)).toBe(true);
    storage.set(AccountStore.Drafts, '42', draft('after close'));
    storage.set(AccountStore.Usage, 'recentReactions', ['🍵']);
    await storage.settled();
    expect(openings).toHaveBeenCalledTimes(2);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    const restored = TestBed.inject(AccountStorage);
    await restored.activate(7);
    expect(restored.read(AccountStore.Drafts, '42', undefined)).toEqual(draft('after close'));
    expect(restored.read(AccountStore.Usage, 'recentReactions', [])).toEqual(['🍵']);
    expect(restored.read(AccountStore.Preferences, 'showAllAvatars', false)).toBe(true);
  });

  it('keeps the newer destination draft and existing account preferences', async () => {
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    storage.set(AccountStore.Drafts, '42', draft('newer', 20));
    storage.set(AccountStore.Preferences, 'showAllAvatars', false);
    await storage.settled();
    localStorage.setItem('chahua.drafts.7', JSON.stringify({ '42': draft('older', 10), '43': draft('missing') }));
    localStorage.setItem('chahua.preferences.showAllAvatars', 'true');
    storage.deactivate();
    await storage.activate(7);
    expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('newer', 20));
    expect(storage.read(AccountStore.Drafts, '43', null)).toEqual(draft('missing'));
    expect(storage.read(AccountStore.Preferences, 'showAllAvatars', true)).toBe(false);
  });

  it.each(['throw', 'abort'])(
    'leaves sources intact after migration %s and retries without losing drafts',
    async (failureMode) => {
      localStorage.setItem('chahua.drafts.7', JSON.stringify({ '42': draft('keep') }));
      localStorage.setItem('chahua.preferences.recentReactions', '["🍵"]');
      const put = IDBObjectStore.prototype.put;
      const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        if (this.name === AccountStore.Drafts) {
          if (failureMode === 'abort') {
            const request = put.apply(this, args);
            this.transaction.abort();
            return request;
          }
          this.transaction.abort();
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        return put.apply(this, args);
      });
      const storage = TestBed.inject(AccountStorage);
      await storage.activate(7);
      expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('keep'));
      expect(storage.read(AccountStore.Usage, 'recentReactions', [])).toEqual([]);
      expect(localStorage.getItem('chahua.drafts.7')).not.toBeNull();
      expect(localStorage.getItem('chahua.preferences.recentReactions')).not.toBeNull();
      failure.mockRestore();
      storage.deactivate();
      await storage.activate(7);
      expect(storage.read(AccountStore.Usage, 'recentReactions', [])).toEqual(['🍵']);
      expect(localStorage.getItem('chahua.drafts.7')).toBeNull();
    },
  );

  it.each(['throw', 'abort'])('keeps edits in memory when a write fails with %s', async (failureMode) => {
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    storage.set(AccountStore.Drafts, '42', draft('persisted'));
    await storage.settled();
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (failureMode === 'throw') throw new DOMException('Cannot clone', 'DataCloneError');
      const request = put.apply(this, args);
      this.transaction.abort();
      return request;
    });
    storage.set(AccountStore.Drafts, '42', draft('memory only'));
    await storage.settled();
    expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('memory only'));
    failure.mockRestore();
    storage.deactivate();
    await storage.activate(7);
    expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('persisted'));
  });

  it.each(['switch', 'logout'])('ignores a delayed old-account read after %s', async (action) => {
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    storage.set(AccountStore.Drafts, '42', draft('seven'));
    await storage.settled();
    storage.deactivate();
    const reading = delayNextGetAll();
    const loading = storage.activate(7);
    await reading.ready;
    if (action === 'switch') await storage.activate(8);
    else storage.deactivate();
    reading.release();
    await loading;
    expect(storage.entries(AccountStore.Drafts)).toEqual({});
  });

  it('falls back after database creation aborts and can retry without an unhandled rejection', async () => {
    localStorage.setItem('chahua.drafts.7', JSON.stringify({ '42': draft('recover') }));
    const create = IDBDatabase.prototype.createObjectStore;
    const failure = vi.spyOn(IDBDatabase.prototype, 'createObjectStore').mockImplementation(function (
      this: IDBDatabase,
      ...args
    ) {
      const store = create.apply(this, args);
      if (store.name === 'meta') queueMicrotask(() => store.transaction.abort());
      return store;
    });
    const storage = TestBed.inject(AccountStorage);
    try {
      await storage.activate(7);
      expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('recover'));
      expect(localStorage.getItem('chahua.drafts.7')).not.toBeNull();
    } finally {
      failure.mockRestore();
    }
    storage.deactivate();
    await storage.activate(7);
    expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('recover'));
    expect(localStorage.getItem('chahua.drafts.7')).toBeNull();
  });

  it('uses UID-scoped draft fallback and keeps edits in memory if IndexedDB cannot open', async () => {
    localStorage.setItem('chahua.drafts.7', JSON.stringify({ '42': draft('recover') }));
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('recover'));
    storage.set(AccountStore.Drafts, '42', draft('edited'));
    await storage.settled();
    expect(storage.read(AccountStore.Drafts, '42', null)).toEqual(draft('edited'));
    expect(localStorage.getItem('chahua.drafts.7')).toContain('recover');
    await storage.activate(8);
    expect(storage.entries(AccountStore.Drafts)).toEqual({});
  });

  it('persists picker recents and skin tone by account without recreating global keys', async () => {
    const storage = TestBed.inject(AccountStorage);
    await storage.activate(7);
    const recents = TestBed.inject(PickerRecents);
    const tone = TestBed.inject(PickerSkinTone);
    recents.addRecent(emoji);
    tone.setSkinTone('🏽');
    await storage.activate(8);
    expect(recents.recents()).toEqual([]);
    expect(tone.currentSkinTone()).toBe('');
    await storage.activate(7);
    expect(recents.recents()).toEqual([emoji]);
    expect(tone.currentSkinTone()).toBe('🏽');
    expect(localStorage.getItem('nicematic-recents')).toBeNull();
    expect(localStorage.getItem('nicematic-skintone')).toBeNull();
  });

  it('carries wetty drafts through the existing migration and keeps its unassigned backup', async () => {
    const opening = indexedDB.open('wetty', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('kv');
    const db = await new Promise<IDBDatabase>((resolve) => {
      opening.onsuccess = () => resolve(opening.result);
    });
    const transaction = db.transaction('kv', 'readwrite');
    transaction.objectStore('kv').put(`header.${btoa(JSON.stringify({ uid: 7 }))}.signature`, 'jwt_token');
    transaction.objectStore('kv').put({ text: 'legacy', replyToMessageId: '99', savedAt: 5 }, 'draft:42_thread_43');
    transaction.objectStore('kv').put({ retained: true }, 'unknown-setting');
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
    });
    db.close();
    await TestBed.inject(LegacyMigration).run();
    await TestBed.inject(AccountStorage).activate(7);
    expect(TestBed.inject(AccountStorage).read(AccountStore.Drafts, '42/43', null)).toEqual({
      text: 'legacy',
      replyTo: '99',
      savedAt: 5,
    });
    expect(localStorage.getItem('chahua.migration.wetty.backup')).toContain('unknown-setting');
    expect(localStorage.getItem('chahua.drafts.7')).toBeNull();
  });
});
