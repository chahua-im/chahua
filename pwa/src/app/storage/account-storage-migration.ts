import { AccountStore, type AccountDatabase, type AccountScope, type Draft } from './account-database';

const preferenceNames = [
  'showThreadsInMessages',
  'showAllAvatars',
  'showDmDetails',
  'pinnedReactions',
  'autoSortStickerPacks',
  'autoSortFavoriteStickers',
];
const usageNames = ['recentReactions', 'favoriteStickerOrder'];

/** A committed receipt prevents leftover source keys from overwriting later edits. */
export async function migrateAccountStorage(db: AccountDatabase, scope: AccountScope) {
  const sources = new Map<string, string>();
  const preferences: Record<string, unknown> = {};
  const usage: Record<string, unknown> = {};
  for (const [names, target] of [
    [preferenceNames, preferences],
    [usageNames, usage],
  ] as const) {
    for (const name of names) {
      const key = `chahua.preferences.${name}`;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      try {
        const value: unknown = JSON.parse(raw);
        if (name === 'pinnedReactions' || usageNames.includes(name)) {
          if (!Array.isArray(value)) continue;
        } else if (typeof value !== 'boolean') continue;
        target[name] = value;
        sources.set(key, raw);
      } catch {
        /* Keep unreadable sources. */
      }
    }
  }
  const recents = localStorage.getItem('nicematic-recents');
  if (recents !== null) {
    try {
      const value: unknown = JSON.parse(recents);
      if (
        Array.isArray(value) &&
        value.every(
          (entry) =>
            entry &&
            typeof entry.char === 'string' &&
            typeof entry.name === 'string' &&
            Array.isArray(entry.keywords) &&
            typeof entry.category === 'string' &&
            typeof entry.hasSkinTone === 'boolean' &&
            Number.isFinite(entry.count) &&
            Number.isFinite(entry.lastUsed),
        )
      ) {
        usage['emojiRecents'] = value;
        sources.set('nicematic-recents', recents);
      }
    } catch {
      /* Keep unreadable sources. */
    }
  }
  const tone = localStorage.getItem('nicematic-skintone');
  if (tone !== null && ['', '🏻', '🏼', '🏽', '🏾', '🏿'].includes(tone)) {
    preferences['skinTone'] = tone;
    sources.set('nicematic-skintone', tone);
  }

  const drafts = new Map<string, { uid: number; values: Record<string, Draft> }>();
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)!;
    const match = /^chahua\.drafts\.(\d+)$/.exec(key);
    if (!match || !Number.isSafeInteger(Number(match[1]))) continue;
    const raw = localStorage.getItem(key)!;
    const values = parseDrafts(raw);
    if (!values) continue;
    sources.set(key, raw);
    drafts.set(key, { uid: Number(match[1]), values });
  }

  const transaction = db.transaction([...Object.values(AccountStore), 'meta'], 'readwrite');
  const done = transaction.done;
  // Observe aborts immediately, including while a request is still pending.
  void done.catch(() => {});
  const meta = transaction.objectStore('meta');
  try {
    const owner = await meta.get('legacy-owner');
    let defaults: Record<string, unknown> =
      ((await meta.get('preference-defaults'))?.value as Record<string, unknown> | undefined) ?? {};
    if (!owner) {
      defaults = preferences;
      await meta.put({ key: 'legacy-owner', value: scope });
      await meta.put({ key: 'preference-defaults', value: defaults });
      await meta.put({ key: 'global-sources', value: [...sources.keys()].filter((key) => !drafts.has(key)) });
      for (const [name, value] of Object.entries(usage)) {
        const target = transaction.objectStore(AccountStore.Usage);
        if ((await target.get([...scope, name])) === undefined) {
          await target.put({ environment: scope[0], uid: scope[1], key: name, value });
        }
      }
    } else {
      const copied: string[] = ((await meta.get('global-sources'))?.value as string[] | undefined) ?? [];
      // A later old-version write was not part of the committed import; retain it.
      for (const key of sources.keys()) if (!drafts.has(key) && !copied.includes(key)) sources.delete(key);
    }
    for (const [name, value] of Object.entries(defaults)) {
      const target = transaction.objectStore(AccountStore.Preferences);
      if ((await target.get([...scope, name])) === undefined) {
        await target.put({ environment: scope[0], uid: scope[1], key: name, value });
      }
    }
    for (const [source, { uid, values }] of drafts) {
      if (await meta.get(source)) continue;
      const target = transaction.objectStore(AccountStore.Drafts);
      for (const [name, draft] of Object.entries(values)) {
        const previous = (await target.get([scope[0], uid, name]))?.value;
        if (!previous || previous.savedAt < draft.savedAt) {
          await target.put({ environment: scope[0], uid, key: name, value: draft });
        }
      }
      await meta.put({ key: source, value: true });
    }
    await done;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* It may already have aborted. */
    }
    await done.catch(() => {});
    throw error;
  }
  // Storage cleanup is independent of the committed copy. Retry it on the next load.
  for (const [key, raw] of sources) {
    try {
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
    } catch {
      /* The receipt keeps an interrupted cleanup idempotent. */
    }
  }
}

export function readLegacyDrafts(uid: number): Record<string, Draft> {
  try {
    return parseDrafts(localStorage.getItem(`chahua.drafts.${uid}`) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function parseDrafts(raw: string): Record<string, Draft> | undefined {
  try {
    const values: unknown = JSON.parse(raw);
    if (!values || typeof values !== 'object' || Array.isArray(values)) return;
    for (const [key, value] of Object.entries(values)) {
      if (!/^\d+(?:\/\d+)?$/.test(key) || !value || typeof value !== 'object') return;
      const draft = value as Partial<Draft>;
      if (typeof draft.text !== 'string' || typeof draft.savedAt !== 'number' || !Number.isFinite(draft.savedAt))
        return;
      if (draft.replyTo != null && (typeof draft.replyTo !== 'string' || !/^\d+$/.test(draft.replyTo))) return;
    }
    return values as Record<string, Draft>;
  } catch {
    return;
  }
}
