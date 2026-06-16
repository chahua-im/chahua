import { getDb } from '@/utils/db';
import type { ChatDraft } from '@/hooks/useChatDraft';

export const DRAFT_KEY_PREFIX = 'draft:';

export async function getAllDrafts(): Promise<Record<string, { text: string; savedAt: number }>> {
  const db = await getDb();
  const keys = await db.getAllKeys('kv');
  const values = await db.getAll('kv');

  const drafts: Record<string, { text: string; savedAt: number }> = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = values[i] as ChatDraft | undefined;
    if (typeof key !== 'string' || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
    if (!value || typeof value !== 'object') continue;

    const rawKey = key.slice(DRAFT_KEY_PREFIX.length);
    drafts[rawKey] = { text: value.text, savedAt: value.savedAt ?? 0 };
  }

  return drafts;
}
