import { computed, DestroyRef, effect, inject, Service, signal, type Signal, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { MessageType, type CreateMessageBody, type MessageResponse } from '../../generated/models';
import { Connection } from '../api/connection';
import type { SnowflakeID } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import type { Composition } from './message-composer/message-composer';
import type { MessageContent } from './message/message';
import { MessageDelivery } from './message-status';
import type { AttachmentUpload } from './upload';

export interface OutgoingMessage {
  readonly clientGeneratedId: string;
  readonly chatId: SnowflakeID;
  readonly threadId?: SnowflakeID;
  readonly message: Signal<MessageContent>;
  readonly uploads: readonly AttachmentUpload[];
  readonly delivery: WritableSignal<MessageDelivery>;
  readonly confirmed: WritableSignal<MessageResponse | undefined>;
  readonly published: WritableSignal<boolean>;
  readonly body: CreateMessageBody;
  operation?: Promise<void>;
  disposed: boolean;
}

/** Owns submitted content and uploads independently of the currently mounted conversation. */
@Service()
export class MessageOutbox {
  private readonly api = inject(ChatsService);
  private readonly connection = inject(Connection);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pending = signal<OutgoingMessage[]>([]);
  readonly items = this.pending.asReadonly();
  private readonly tails = new Map<string, Promise<void>>();

  constructor() {
    let owner = this.session.user()?.uid;
    effect(() => {
      const uid = this.session.user()?.uid;
      if (uid !== owner) {
        owner = uid;
        this.clear();
      }
    });
    this.connection.messages$.pipe(takeUntilDestroyed()).subscribe((message) => {
      const item = this.pending().find(
        (item) => item.clientGeneratedId === message.clientGeneratedId && item.chatId === message.chatId,
      );
      if (!item || item.message().sender.uid !== message.sender.uid) return;
      item.confirmed.set(message);
      item.published.set(true);
      item.delivery.set(MessageDelivery.Sent);
    });
    this.connection.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      for (const item of this.pending()) {
        const message = item.confirmed();
        if (message && !item.published()) void this.checkPublished(item, message.id);
      }
    });
    this.destroyRef.onDestroy(() => this.clear());
  }

  enqueue(
    chatId: SnowflakeID,
    threadId: SnowflakeID | undefined,
    text: string,
    composition: Composition,
    replyTo?: MessageResponse,
    replyToId = replyTo?.id,
  ) {
    const user = this.session.user()!;
    const sender = { uid: user.uid, name: user.username, gender: user.gender, avatarUrl: user.avatarUrl };
    const createdAt = new Date().toISOString();
    const uploads = composition.uploads ?? [];
    const body: CreateMessageBody = {
      clientGeneratedId: crypto.randomUUID(),
      messageType: composition.messageType,
      message: composition.messageType === MessageType.text ? text : undefined,
      attachmentIds: [...composition.attachmentIds],
      stickerId: composition.sticker?.id,
      replyToId,
    };
    const confirmed = signal<MessageResponse | undefined>(undefined);
    const published = signal(false);
    const message = computed<MessageContent>(() => {
      const response = confirmed();
      // Audio's HTTP response acknowledges the job; its published URL arrives after transcoding.
      if (response && (body.messageType !== MessageType.audio || published())) return response;
      return {
        sender,
        createdAt,
        message: body.message,
        messageType: body.messageType,
        mentions: composition.mentions,
        replyToMessage: replyTo && { ...replyTo, mentions: replyTo.mentions ?? [] },
        sticker: composition.sticker,
        attachments: uploads.map((upload) => {
          const state = upload.state();
          return {
            url: upload.url,
            fileName: upload.file.name,
            kind: upload.file.type,
            size: upload.file.size,
            width: state.width,
            height: state.height,
          };
        }),
      };
    });
    const item: OutgoingMessage = {
      clientGeneratedId: body.clientGeneratedId,
      chatId,
      threadId,
      body,
      message,
      uploads,
      confirmed,
      published,
      delivery: signal(MessageDelivery.Sending),
      disposed: false,
    };
    this.pending.update((items) => [...items, item]);
    void this.retry(item);
    return item;
  }

  retry(item: OutgoingMessage): Promise<void> {
    if (item.operation) return item.operation;
    if (item.disposed || item.confirmed()) return Promise.resolve();
    item.delivery.set(MessageDelivery.Sending);
    const key = `${item.chatId}/${item.threadId ?? ''}`;
    const previous = this.tails.get(key);
    // Uploads run in parallel; message creation preserves submission order within each conversation.
    const operation = previous ? previous.then(() => this.send(item)) : this.send(item);
    item.operation = operation;
    this.tails.set(key, operation);
    void operation.then(() => {
      item.operation = undefined;
      if (this.tails.get(key) === operation) this.tails.delete(key);
    });
    return operation;
  }

  private async send(item: OutgoingMessage) {
    if (item.disposed || item.confirmed()) return;
    try {
      if (item.uploads.length) {
        const ids = await Promise.all(item.uploads.map((upload) => upload.retry()));
        if (item.disposed) return;
        if (ids.some((id) => id == null)) throw new Error('Attachment upload failed');
        item.body.attachmentIds = ids as SnowflakeID[];
      }
      const response = await firstValueFrom(
        (item.threadId
          ? this.api.postThreadMessage(item.chatId, item.threadId, item.body)
          : this.api.postMessage(item.chatId, item.body)
        ).pipe(takeUntilDestroyed(this.destroyRef)),
      );
      if (item.disposed) return;
      // A WebSocket acknowledgement can precede an older HTTP response (notably for audio).
      if (!item.published()) item.confirmed.set(response);
      item.delivery.set(MessageDelivery.Sent);
      if (item.body.messageType !== MessageType.audio) {
        item.published.set(true);
        this.connection.accept(response);
      }
    } catch {
      if (!item.disposed && !item.confirmed()) item.delivery.set(MessageDelivery.Failed);
    }
  }

  private async checkPublished(item: OutgoingMessage, id: SnowflakeID) {
    try {
      const message = await firstValueFrom(
        this.api.getMessage(item.chatId, id).pipe(takeUntilDestroyed(this.destroyRef)),
      );
      if (!item.disposed && !item.published()) this.connection.accept(message);
    } catch {
      // Unpublished audio returns 404; keep its acknowledgement and local playback until publication.
    }
  }

  /** Release local resources only after a visible server range owns the same messages. */
  release(messages: readonly MessageResponse[]) {
    const known = new Set(messages.map((message) => `${message.chatId}/${message.clientGeneratedId}`));
    const removed = this.pending().filter((item) => known.has(`${item.chatId}/${item.clientGeneratedId}`));
    if (!removed.length) return;
    for (const item of removed) this.dispose(item);
    this.pending.update((items) => items.filter((item) => !item.disposed));
  }

  private dispose(item: OutgoingMessage) {
    item.disposed = true;
    for (const upload of item.uploads) upload.dispose();
  }

  private clear() {
    for (const item of this.pending()) this.dispose(item);
    this.pending.set([]);
    this.tails.clear();
  }
}
