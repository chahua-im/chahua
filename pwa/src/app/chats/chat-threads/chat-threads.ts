import { Component, forwardRef, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  IonButton,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonList,
  IonSpinner,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import type { MessageResponse, SnowflakeID } from '../../../generated/models';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { ChatListItem } from '../chat-list-item/chat-list-item';

@Component({
  selector: 'app-chat-threads',
  templateUrl: './chat-threads.html',
  imports: [
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonButton,
    IonList,
    IonSpinner,
    ChatListItem,
    forwardRef(() => MessagePreview),
  ],
})
export class ChatThreads {
  readonly chatId = input.required<SnowflakeID>();
  protected readonly items = signal<MessageResponse[]>([]);
  protected readonly cursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly opening = signal(false);
  protected readonly openFailed = signal(false);
  private readonly api = inject(ChatsService);
  private readonly navigation = inject(ConversationNavigation);
  private readonly destroy = inject(DestroyRef);
  private version = 0;

  constructor() {
    effect(() => {
      this.chatId();
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
    if (!more) {
      this.items.set([]);
      this.cursor.set(undefined);
    }
    this.loading.set(true);
    this.error.set(false);
    try {
      // The protocol has no per-chat topic list; continue through pages of root messages.
      const page = await firstValueFrom(
        this.api
          .getMessages(this.chatId(), {
            max: 50,
            before: more ? this.cursor() : undefined,
          })
          .pipe(takeUntilDestroyed(this.destroy)),
      );
      if (version !== this.version || this.destroy.destroyed) return;
      const topics = page.messages.filter((message) => message.threadInfo).reverse();
      this.items.update((items) => (more ? [...items, ...topics] : topics));
      this.cursor.set(page.olderCursor);
    } catch {
      if (version === this.version && !this.destroy.destroyed) this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }

  protected async open(root: MessageResponse) {
    if (this.opening()) return;
    this.opening.set(true);
    this.openFailed.set(false);
    try {
      await this.navigation.open(root.chatId, root.id);
    } catch {
      if (!this.destroy.destroyed) this.openFailed.set(true);
    } finally {
      this.opening.set(false);
    }
  }
}
