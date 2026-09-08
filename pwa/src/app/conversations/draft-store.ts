import { computed, inject, linkedSignal, Service } from '@angular/core';
import { decodeId, type SnowflakeID } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';

export interface Draft {
  text: string;
  replyTo?: string;
  savedAt: number;
}

@Service()
export class DraftStore {
  private readonly session = inject(SessionStore);
  private readonly storageKey = computed(() => `chahua.drafts.${this.session.user()?.uid}`);
  private readonly items = linkedSignal({
    source: this.storageKey,
    computation: (key): Record<string, Draft> => {
      try {
        return JSON.parse(window.localStorage.getItem(key) ?? '{}');
      } catch {
        return {};
      }
    },
  });

  get(chatId: SnowflakeID, threadId?: SnowflakeID) {
    return this.items()[this.key(chatId, threadId)];
  }

  save(chatId: SnowflakeID, threadId: SnowflakeID | undefined, text: string, replyTo?: SnowflakeID) {
    const previous = this.get(chatId, threadId);
    const replyId = replyTo ? decodeId(replyTo) : undefined;
    if (!text.trim() && !replyId) {
      this.clear(chatId, threadId);
      return;
    }
    if (previous?.text === text && previous?.replyTo === replyId) return;
    this.update(chatId, threadId, { text, replyTo: replyId, savedAt: Date.now() });
  }

  clear(chatId: SnowflakeID, threadId?: SnowflakeID) {
    if (this.get(chatId, threadId)) this.update(chatId, threadId, undefined);
  }

  private key(chatId: SnowflakeID, threadId?: SnowflakeID) {
    return `${decodeId(chatId)}${threadId ? `/${decodeId(threadId)}` : ''}`;
  }

  private update(chatId: SnowflakeID, threadId: SnowflakeID | undefined, draft: Draft | undefined) {
    const items = { ...this.items() };
    const key = this.key(chatId, threadId);
    if (draft) items[key] = draft;
    else delete items[key];
    this.items.set(items);
    try {
      window.localStorage.setItem(this.storageKey(), JSON.stringify(items));
    } catch {
      // Storage may be full or disabled; keep the draft available for this session.
    }
  }
}
