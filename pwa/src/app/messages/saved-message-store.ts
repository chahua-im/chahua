import { Service, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { SavedMessagesService } from '../../generated/endpoints/saved-messages/saved-messages.service';
import type { MessageResponse } from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';

/**
 * Which messages the current user saved, per chat. The message payload carries no saved flag, so the
 * first menu open in a chat loads the chat's saved ids; mutations apply to this set before the request
 * and revert it when the request fails.
 */
@Service()
export class SavedMessageStore {
  private readonly chatsApi = inject(ChatsService);
  private readonly savedApi = inject(SavedMessagesService);
  private readonly scopes = signal<ReadonlyMap<SnowflakeID, ReadonlySet<SnowflakeID>>>(new Map());
  private readonly loadingScopes = signal<ReadonlySet<SnowflakeID>>(new Set());
  private readonly ensures = new Map<SnowflakeID, Promise<void>>();

  isSaved(chatId: SnowflakeID, messageId: SnowflakeID) {
    return this.scopes().get(chatId)?.has(messageId) ?? false;
  }

  loading(chatId: SnowflakeID) {
    return this.loadingScopes().has(chatId);
  }

  ensure(chatId: SnowflakeID): Promise<void> {
    if (this.scopes().has(chatId)) return Promise.resolve();
    const pending = this.ensures.get(chatId);
    if (pending) return pending;
    const promise = this.load(chatId).finally(() => this.ensures.delete(chatId));
    this.ensures.set(chatId, promise);
    return promise;
  }

  async save(message: MessageResponse) {
    await this.mutate(message, true);
  }

  async unsave(message: MessageResponse) {
    await this.mutate(message, false);
  }

  private async mutate(message: MessageResponse, saved: boolean) {
    const previous = this.isSaved(message.chatId, message.id);
    this.write(message.chatId, message.id, saved);
    try {
      if (saved) await firstValueFrom(this.savedApi.putSavedMessage(message.id));
      else await firstValueFrom(this.savedApi.deleteSavedMessageByOriginal(message.id));
    } catch (error) {
      this.write(message.chatId, message.id, previous);
      throw error;
    }
  }

  private async load(chatId: SnowflakeID) {
    this.loadingScopes.update((scopes) => new Set(scopes).add(chatId));
    try {
      const ids = new Set<SnowflakeID>();
      let before: SnowflakeID | undefined;
      for (;;) {
        const page = await firstValueFrom(
          this.chatsApi.listChatSavedMessages(chatId, { limit: 50, ...(before ? { before } : {}) }),
        );
        for (const item of page.savedMessages) ids.add(item.originalMessageId);
        const next = page.nextCursor;
        if (!next || next === before) break;
        before = next;
      }
      this.scopes.update((scopes) => new Map(scopes).set(chatId, ids));
    } finally {
      this.loadingScopes.update((scopes) => {
        const next = new Set(scopes);
        next.delete(chatId);
        return next;
      });
    }
  }

  private write(chatId: SnowflakeID, messageId: SnowflakeID, saved: boolean) {
    const current = this.scopes().get(chatId) ?? new Set<SnowflakeID>();
    const next = new Set(current);
    if (saved) next.add(messageId);
    else next.delete(messageId);
    this.scopes.update((scopes) => new Map(scopes).set(chatId, next));
  }
}
