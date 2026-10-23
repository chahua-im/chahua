import { DestroyRef, inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, type Observable } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { ServerWsMessageType, type MessageResponse } from '../../generated/models';
import { Connection } from '../api/connection';
import { SessionStore } from '../session/session-store';
import type { SnowflakeID } from '../api/snowflake-id';
@Injectable()
export class MessageActions {
  private readonly chatsApi = inject(ChatsService);

  private readonly realtime = inject(Connection);
  private readonly session = inject(SessionStore);

  private readonly destroyRef = inject(DestroyRef);

  async recall(message: MessageResponse) {
    await this.response(this.chatsApi.deleteMessage(message.chatId, message.id));
    this.realtime.acceptChange({
      type: ServerWsMessageType.messageDeleted,
      payload: {
        ...message,
        isDeleted: true,
        message: undefined,
        attachments: [],
        hasAttachments: false,
        sticker: undefined,
        reactions: [],
      },
    });
  }

  async recallMany(chatId: SnowflakeID, messageIds: SnowflakeID[]) {
    const payload = await this.response(this.chatsApi.bulkDeleteMessages(chatId, { messageIds }));
    this.realtime.acceptChange({ type: ServerWsMessageType.messagesBulkDeleted, payload });
    return payload;
  }

  async toggleReaction(message: MessageResponse, emoji: string): Promise<void> {
    const previous = message.reactions;
    const existing = previous.find((reaction) => reaction.emoji === emoji);
    const reacted = !existing?.reactedByMe;
    const user = this.session.user()!;
    const reactors = (existing?.reactors ?? []).filter((reactor) => reactor.uid !== user.uid);
    if (reacted) reactors.push({ uid: user.uid, name: user.username, avatarUrl: user.avatarUrl });
    const reactions = previous.map((reaction) =>
      reaction.emoji === emoji
        ? { ...reaction, count: reaction.count + (reacted ? 1 : -1), reactedByMe: reacted, reactors }
        : reaction,
    );
    if (!existing) reactions.push({ emoji, count: 1, reactedByMe: true, reactors });
    // Publish the personal selection and avatar now; broadcasts replace totals and avatars, preserving the selection.
    this.realtime.acceptChange({
      type: ServerWsMessageType.reactionUpdated,
      payload: {
        chatId: message.chatId,
        messageId: message.id,
        reactions: reactions.filter((reaction) => reaction.count > 0),
      },
    });
    try {
      await this.response(
        reacted
          ? this.chatsApi.putReaction(message.chatId, message.id, encodeURIComponent(emoji))
          : this.chatsApi.deleteReaction(message.chatId, message.id, encodeURIComponent(emoji)),
      );
    } catch (error) {
      // The menu closes before the request runs, so a rejected reaction has to undo its own optimistic change.
      this.realtime.acceptChange({
        type: ServerWsMessageType.reactionUpdated,
        payload: { chatId: message.chatId, messageId: message.id, reactions: previous },
      });
      throw error;
    }
  }

  private response<T>(request: Observable<T>) {
    return firstValueFrom(request.pipe(takeUntilDestroyed(this.destroyRef)));
  }
}
