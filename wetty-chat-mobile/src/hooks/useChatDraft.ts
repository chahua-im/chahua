import { useCallback, useEffect, useRef } from 'react';
import { kvGet, kvSet, kvDelete } from '@/utils/db';
import { notifyDraftChange } from '@/utils/draftEvents';
import { DRAFT_KEY_PREFIX } from '@/utils/draftSync';

export interface ChatDraft {
  text: string;
  replyToMessageId?: string;
  replyToUsername?: string;
}

const SAVE_DEBOUNCE_MS = 500;

function draftKey(key: string): string {
  return `${DRAFT_KEY_PREFIX}${key}`;
}

export async function loadDraft(key: string): Promise<ChatDraft | undefined> {
  return kvGet<ChatDraft>(draftKey(key));
}

export async function saveDraft(key: string, draft: ChatDraft): Promise<void> {
  if (!draft.text && !draft.replyToMessageId) {
    // If both text and replyTo are empty, clear the draft instead of saving an empty one
    await clearDraft(key);
    return;
  }
  await kvSet(draftKey(key), draft);
  notifyDraftChange(key);
}

export async function clearDraft(key: string): Promise<void> {
  await kvDelete(draftKey(key));
  notifyDraftChange(key);
}

/**
 * Hook to manage chat compose drafts in IndexedDB.
 * Returns a ref-backed save function so the latest draft can be saved
 * without causing re-renders on every debounce cycle.
 */
export function useChatDraft(draftKeyValue: string | undefined) {
  const draftKeyRef = useRef(draftKeyValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<ChatDraft | null>(null);

  useEffect(() => {
    draftKeyRef.current = draftKeyValue;
  }, [draftKeyValue]);

  const saveDebounced = useCallback((draft: ChatDraft) => {
    const key = draftKeyRef.current;
    if (!key) return;

    pendingRef.current = draft;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      void saveDraft(key, draft);
      pendingRef.current = null;
      timerRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const clear = useCallback(() => {
    const key = draftKeyRef.current;
    if (!key) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    void clearDraft(key);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const key = draftKeyRef.current;
        const pending = pendingRef.current;
        if (key && pending) {
          void saveDraft(key, pending);
        }
      }
    };
  }, [draftKeyValue]);

  return { saveDebounced, clear };
}
