import { RpcError, RpcErrorCode } from '../../api/rpc-error';
import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonList,
  IonSpinner,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import { ThreadOrder, type MessageResponse, type SnowflakeID } from '../../../generated/models';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { ChatListItem } from '../chat-list-item/chat-list-item';
import { LoadError } from '../../ui/load-error/load-error';

@Component({
  selector: 'app-chat-threads',
  templateUrl: './chat-threads.html',
  imports: [
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonList,
    IonSpinner,
    LoadError,
    ChatListItem,
    MessagePreview,
    TranslocoPipe,
  ],
})
export class ChatThreads {
  readonly chatId = input.required<SnowflakeID>();
  protected readonly items = signal<MessageResponse[]>([]);
  protected readonly cursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly loaded = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly retryable = signal(true);
  protected readonly opening = signal(false);
  protected readonly openFailed = signal(false);
  protected retryMore = false;
  private readonly api = inject(RpcApi);
  private readonly navigation = inject(ConversationNavigation);
  private readonly destroy = inject(DestroyRef);
  private readonly cancel = new Subject<void>();
  private version = 0;

  constructor() {
    effect((onCleanup) => {
      this.chatId();
      this.version++;
      this.items.set([]);
      this.cursor.set(undefined);
      this.loaded.set(false);
      this.retryable.set(true);
      this.error.set(false);
      this.loading.set(false);
      untracked(() => void this.load());
      onCleanup(() => {
        this.version++;
        this.cancel.next();
      });
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
    const cursor = this.cursor();
    if (more && (this.loading() || cursor == null)) return;
    const version = ++this.version;
    this.loading.set(true);
    this.error.set(false);
    this.retryMore = more;
    this.retryable.set(true);
    try {
      const page = await firstValueFrom(
        this.api.threads
          .listForChat({
            chatId: this.chatId(),
            limit: 50,
            cursor: more && cursor != null ? cursor : undefined,
            order: ThreadOrder.newest,
          })
          .pipe(takeUntil(this.cancel), takeUntilDestroyed(this.destroy)),
      );
      if (version !== this.version || this.destroy.destroyed) return;
      this.items.update((items) => (more ? [...items, ...page.threads] : page.threads));
      this.cursor.set(page.nextCursor);
      this.loaded.set(true);
    } catch (error) {
      if (version === this.version && !this.destroy.destroyed) {
        const retryable = !(
          error instanceof RpcError &&
          [RpcErrorCode.Unauthorized, RpcErrorCode.Forbidden, RpcErrorCode.NotFound, RpcErrorCode.Gone].includes(
            error.code,
          )
        );
        if (!retryable) {
          this.items.set([]);
          this.cursor.set(undefined);
        }
        this.retryable.set(retryable);
        this.error.set(true);
      }
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
