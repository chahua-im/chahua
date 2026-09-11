import { Component, forwardRef, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  IonButton,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonLabel,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { MessageSearchSort, type MessageResponse, type SnowflakeID } from '../../../generated/models';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { Message } from '../../messages/message/message';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
@Component({
  selector: 'app-chat-search',
  templateUrl: './chat-search.html',
  imports: [
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonButton,
    IonSpinner,
    forwardRef(() => Message),
  ],
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
  private readonly navigation = inject(ConversationNavigation);
  private readonly destroy = inject(DestroyRef);
  private version = 0;
  constructor() {
    fillScrollViewport(this.loading, this.error, this.cursor, () => this.load(true));
    effect(() => {
      this.chatId();
      this.query();
      this.sort();
      void this.load();
    });
  }
  protected async more(event: InfiniteScrollCustomEvent) {
    try {
      await this.load(true);
    } finally {
      await event.target.complete();
    }
  }
  protected async load(more = false) {
    if (more && (this.loading() || this.cursor() == null)) return;
    const version = ++this.version;
    const q = this.query().trim();
    if (!more) {
      this.messages.set([]);
      this.cursor.set(undefined);
    }
    this.error.set(false);
    this.loading.set(!!q);
    if (!q) return;
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
    await this.navigation.open(message.chatId, message.replyRootId, message.id);
  }
}
