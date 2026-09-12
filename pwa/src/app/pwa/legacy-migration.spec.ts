import { IDBFactory } from 'fake-indexeddb';
import { LegacyMigration } from './legacy-migration';

const token = (uid: number) => `header.${btoa(JSON.stringify({ uid }))}.signature`;
const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
async function legacy(entries: Record<string, unknown>, keepOpen = false) {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const opening = indexedDB.open('wetty', 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('kv');
      opening.result.createObjectStore('notification_hwm');
    };
    opening.onsuccess = () => resolve(opening.result);
  });
  const tx = db.transaction('kv', 'readwrite');
  for (const [key, value] of Object.entries(entries)) tx.objectStore('kv').put(value, key);
  await done(tx);
  if (!keepOpen) db.close();
  return db;
}

describe('LegacyMigration', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });
  afterEach(async () => {
    if (localStorage.getItem('chahua.migration.wetty') === 'copied') {
      await vi.waitFor(() => expect(localStorage.getItem('chahua.migration.wetty')).toBe('true'));
    }
    vi.unstubAllGlobals();
  });

  it('does not create a database on a fresh installation', async () => {
    await new LegacyMigration().run();
    await vi.waitFor(async () => expect(await indexedDB.databases()).toEqual([]));
  });

  it('converts drafts and preferences before deleting the legacy database, preserving login and unsupported settings', async () => {
    await legacy({
      jwt_token: token(7),
      settings: {
        showThreadsInMessages: false,
        showAllAvatars: true,
        colorMode: 'dark',
        recentReactions: ['❤️', '😂', '😮', '😢', '🎉', '👀'],
      },
      'draft:90071992547409931': {
        text: 'hello',
        replyToMessageId: '90071992547409933',
        replyToUsername: 'Alice',
        savedAt: 10,
      },
      'draft:42_thread_43': { text: '', replyToMessageId: '44' },
      autoSortStickerPacks: false,
    });
    await new LegacyMigration().run();
    await vi.waitFor(async () => expect(await indexedDB.databases()).toEqual([]));
    expect(localStorage.getItem('jwt_token')).toBe(token(7));
    expect(localStorage.getItem('chahua.preferences.showThreadsInMessages')).toBe('false');
    expect(localStorage.getItem('chahua.preferences.showAllAvatars')).toBe('true');
    expect(JSON.parse(localStorage.getItem('chahua.preferences.recentReactions')!)).toEqual([
      '❤️',
      '😂',
      '😮',
      '😢',
      '🎉',
    ]);
    expect(JSON.parse(localStorage.getItem('chahua.drafts.7')!)).toEqual({
      '90071992547409931': { text: 'hello', replyTo: '90071992547409933', savedAt: 10 },
      '42/43': { text: '', replyTo: '44', savedAt: 0 },
    });
    const backup = JSON.parse(localStorage.getItem('chahua.migration.wetty.backup')!);
    expect(backup.settings.colorMode).toBe('dark');
    expect(backup.autoSortStickerPacks).toBe(false);
    expect(backup.jwt_token).toBeUndefined();
    expect(localStorage.getItem('chahua.migration.wetty')).toBe('true');
  });

  it('keeps existing preferences and newer drafts, and assigns old drafts to their original account', async () => {
    localStorage.setItem('jwt_token', token(8));
    localStorage.setItem('chahua.preferences.showAllAvatars', 'false');
    localStorage.setItem('chahua.drafts.7', JSON.stringify({ '42': { text: 'newer', savedAt: 20 } }));
    await legacy({
      jwt_token: token(7),
      settings: { showAllAvatars: true },
      'draft:42': { text: 'older', savedAt: 10 },
      'draft:43': { text: 'old account' },
    });
    await new LegacyMigration().run();
    expect(localStorage.getItem('jwt_token')).toBe(token(8));
    expect(localStorage.getItem('chahua.preferences.showAllAvatars')).toBe('false');
    expect(JSON.parse(localStorage.getItem('chahua.drafts.7')!)['42'].text).toBe('newer');
    expect(JSON.parse(localStorage.getItem('chahua.drafts.7')!)['43'].text).toBe('old account');
    expect(localStorage.getItem('chahua.drafts.8')).toBeNull();
  });

  it('does not delete the old database when saving fails, and retries on the next launch', async () => {
    await legacy({ jwt_token: token(7), 'draft:42': { text: 'keep me' } });
    const original = localStorage.setItem.bind(localStorage);
    const failure = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'chahua.drafts.7') throw new DOMException('Full', 'QuotaExceededError');
      original(key, value);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await new LegacyMigration().run();
    expect((await indexedDB.databases()).map((db) => db.name)).toEqual(['wetty']);
    expect(localStorage.getItem('chahua.migration.wetty')).toBeNull();
    failure.mockRestore();
    await new LegacyMigration().run();
    await vi.waitFor(async () => expect(await indexedDB.databases()).toEqual([]));
    expect(JSON.parse(localStorage.getItem('chahua.drafts.7')!)['42'].text).toBe('keep me');
    log.mockRestore();
  });

  it('lets startup continue when an old tab blocks deletion, then deletes after that tab closes', async () => {
    const connection = await legacy({ jwt_token: token(7), 'draft:42': { text: 'saved' } }, true);
    await new LegacyMigration().run();
    expect(localStorage.getItem('chahua.drafts.7')).toContain('saved');
    expect(localStorage.getItem('chahua.migration.wetty')).toBe('copied');
    await new LegacyMigration().run(); // A later launch must not open a database queued for deletion.
    expect(localStorage.getItem('chahua.drafts.7')).toContain('saved');
    connection.close();
    await vi.waitFor(() => expect(localStorage.getItem('chahua.migration.wetty')).toBe('true'));
  });

  it('backs up drafts with an unknown owner instead of assigning them to the wrong account', async () => {
    await legacy({ 'draft:42': { text: 'unassigned' } });
    await new LegacyMigration().run();
    expect(JSON.parse(localStorage.getItem('chahua.migration.wetty.backup')!)['draft:42'].text).toBe('unassigned');
    await vi.waitFor(async () => expect(await indexedDB.databases()).toEqual([]));
  });
});
