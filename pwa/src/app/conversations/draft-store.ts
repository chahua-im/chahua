import { computed, inject, linkedSignal, Service } from '@angular/core';
import type { LinkPreviewInput, MessageResponse } from '../../generated/models';
import { decodeId, type SnowflakeID } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { AccountStorage, AccountStore } from '../storage/account-storage';
import type { Draft } from '../storage/account-database';

@Service()
export class DraftStore {
  private readonly session = inject(SessionStore);
  private readonly storage = inject(AccountStorage);
  private readonly account = computed(() => this.session.user()?.uid);
  // Forward drafts keep server message data, never upload tasks, and only survive within this session.
  private readonly forwards = linkedSignal({
    source: this.account,
    computation: (): Record<string, readonly MessageResponse[] | undefined> => ({}),
  });
  private readonly items = computed(() => this.storage.entries(AccountStore.Drafts));

  forward(chatId: SnowflakeID, threadId?: SnowflakeID) {
    return this.forwards()[this.key(chatId, threadId)];
  }

  setForward(chatId: SnowflakeID, threadId: SnowflakeID | undefined, sources?: readonly MessageResponse[]) {
    const key = this.key(chatId, threadId);
    this.forwards.update((items) => {
      const next = { ...items };
      if (sources) next[key] = sources;
      else delete next[key];
      return next;
    });
  }

  get(chatId: SnowflakeID, threadId?: SnowflakeID) {
    return this.items()[this.key(chatId, threadId)];
  }

  save(
    chatId: SnowflakeID,
    threadId: SnowflakeID | undefined,
    text: string,
    replyTo?: SnowflakeID,
    linkPreviews?: readonly LinkPreviewInput[],
  ) {
    const previous = this.get(chatId, threadId);
    const replyId = replyTo ? decodeId(replyTo) : undefined;
    if (!text.trim() && !replyId) {
      this.clear(chatId, threadId);
      return;
    }
    if (
      previous?.text === text &&
      previous?.replyTo === replyId &&
      JSON.stringify(previous?.linkPreviews) === JSON.stringify(linkPreviews?.length ? linkPreviews : undefined)
    )
      return;
    this.update(chatId, threadId, {
      text,
      replyTo: replyId,
      savedAt: Date.now(),
      ...(linkPreviews?.length ? { linkPreviews } : {}),
    });
  }

  clear(chatId: SnowflakeID, threadId?: SnowflakeID) {
    if (this.get(chatId, threadId)) this.update(chatId, threadId, undefined);
  }

  private key(chatId: SnowflakeID, threadId?: SnowflakeID) {
    return `${decodeId(chatId)}${threadId ? `/${decodeId(threadId)}` : ''}`;
  }

  private update(chatId: SnowflakeID, threadId: SnowflakeID | undefined, draft: Draft | undefined) {
    this.storage.set(AccountStore.Drafts, this.key(chatId, threadId), draft);
  }
}
