import { dismissChatOverlays } from '../../chats/dismiss-chat-overlays';
import { Component, effect, inject, input, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonLabel,
  IonButton,
  IonSpinner,
  ModalController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { MessageSearchSort, type SnowflakeID, type MessageResponse } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { Message } from '../../messages/message/message';
@Component({
  selector: 'app-chat-search',
  templateUrl: './chat-search.html',
  imports: [IonSearchbar, IonSegment, IonSegmentButton, IonLabel, IonButton, IonSpinner, Message],
})
export class ChatSearch {
  readonly chatId = input.required<SnowflakeID>();
  protected readonly query = signal('');
  protected readonly sort = signal(MessageSearchSort.relevance);
  protected readonly Sort = MessageSearchSort;
  protected readonly messages = signal<MessageResponse[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly cursor = signal<number | undefined>(undefined);
  private readonly api = inject(ChatsService);
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly destroy = inject(DestroyRef);
  private version = 0;
  constructor() {
    effect(() => {
      this.chatId();
      this.query();
      this.sort();
      void this.load();
    });
  }
  protected async load(more = false) {
    const version = ++this.version;
    const q = this.query().trim();
    if (!more) {
      this.messages.set([]);
      this.cursor.set(undefined);
    }
    if (!q) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set(false);
    try {
      const page = await firstValueFrom(
        this.api
          .searchMessages(this.chatId(), { q, sort: this.sort(), limit: 40, offset: more ? this.cursor() : undefined })
          .pipe(takeUntilDestroyed(this.destroy)),
      );
      if (version !== this.version) return;
      this.messages.update((items) => (more ? [...items, ...page.messages] : page.messages));
      this.cursor.set(page.nextOffset);
    } catch {
      if (version === this.version) this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
  protected async locate(message: MessageResponse) {
    await dismissChatOverlays(this.modals);
    await this.router.navigate(
      [
        '/chats/chat',
        decodeId(message.chatId),
        ...(message.replyRootId ? ['thread', decodeId(message.replyRootId)] : []),
      ],
      { queryParams: { message: decodeId(message.id) } },
    );
  }
}
