import { computed, inject, Service } from '@angular/core';
import type { LinkPreviewInput } from '../../generated/models';
import { decodeId, type SnowflakeID } from '../api/snowflake-id';
import { AccountStorage, AccountStore } from '../storage/account-storage';
import type { Draft } from '../storage/account-database';

@Service()
export class DraftStore {
  private readonly storage = inject(AccountStorage);
  private readonly items = computed(() => this.storage.entries(AccountStore.Drafts));

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
