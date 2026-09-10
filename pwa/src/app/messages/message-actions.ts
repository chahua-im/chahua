import { DestroyRef, inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, type Observable } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { SavedMessagesService } from '../../generated/endpoints/saved-messages/saved-messages.service';
import { ServerWsMessageType, type MessageResponse } from '../../generated/models';
import { Connection } from '../api/connection';
import { SessionStore } from '../session/session-store';
@Injectable()
export class MessageActions {
  private readonly chatsApi = inject(ChatsService);

  private readonly savedApi = inject(SavedMessagesService);

  private readonly realtime = inject(Connection);
  private readonly session = inject(SessionStore);

  private readonly destroyRef = inject(DestroyRef);

  async save(message: MessageResponse) {
    await this.response(this.savedApi.putSavedMessage(message.id));
  }

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

  async toggleReaction(message: MessageResponse, emoji: string): Promise<void> {
    const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
    const reacted = !existing?.reactedByMe;
    const user = this.session.user()!;
    const reactors = (existing?.reactors ?? []).filter((reactor) => reactor.uid !== user.uid);
    if (reacted) reactors.push({ uid: user.uid, name: user.username, avatarUrl: user.avatarUrl });
    const reactions = message.reactions.map((reaction) =>
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
    await this.response(
      reacted
        ? this.chatsApi.putReaction(message.chatId, message.id, encodeURIComponent(emoji))
        : this.chatsApi.deleteReaction(message.chatId, message.id, encodeURIComponent(emoji)),
    );
  }

  private response<T>(request: Observable<T>) {
    return firstValueFrom(request.pipe(takeUntilDestroyed(this.destroyRef)));
  }
}
