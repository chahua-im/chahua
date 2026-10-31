import { RpcError, RpcErrorCode } from '../../api/rpc-error';
import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { RouterLink } from '@angular/router';
import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonSpinner,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import type { SnowflakeID, User } from '../../../generated/models';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { LoadError } from '../../ui/load-error/load-error';

@Component({
  selector: 'app-thread-participants',
  templateUrl: './thread-participants.html',
  imports: [
    RouterLink,
    ChatAvatar,
    LoadError,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonItem,
    IonLabel,
    IonList,
    IonSpinner,
    TranslocoPipe,
  ],
})
export class ThreadParticipants {
  readonly chatId = input.required<SnowflakeID>();
  readonly rootId = input.required<SnowflakeID>();
  private readonly api = inject(RpcApi);
  private readonly destroy = inject(DestroyRef);
  private readonly cancel = new Subject<void>();
  private version = 0;
  private retryMore = false;
  protected readonly participants = signal<User[]>([]);
  protected readonly cursor = signal<number | undefined>(undefined);
  protected readonly loaded = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly retryable = signal(true);

  constructor() {
    fillScrollViewport(this.loading, this.error, this.cursor, () => this.load(true));
    effect((onCleanup) => {
      this.chatId();
      this.rootId();
      this.version++;
      this.loaded.set(false);
      this.loading.set(false);
      this.participants.set([]);
      this.cursor.set(undefined);
      this.error.set(false);
      this.retryable.set(true);
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

  protected retry() {
    void this.load(this.retryMore);
  }

  protected async load(more = false) {
    const cursor = this.cursor();
    if (more && (this.loading() || cursor == null)) return;
    const version = ++this.version;

    this.loading.set(true);
    this.error.set(false);
    this.retryable.set(true);
    this.retryMore = more;
    try {
      const page = await firstValueFrom(
        this.api.threads
          .listParticipants({
            chatId: this.chatId(),
            threadRootId: this.rootId(),
            limit: 100,
            cursor: more && cursor != null ? cursor : undefined,
          })
          .pipe(takeUntilDestroyed(this.destroy), takeUntil(this.cancel)),
      );
      if (version !== this.version || this.destroy.destroyed) return;
      this.participants.update((items) => (more ? [...items, ...page.participants] : page.participants));
      this.cursor.set(page.nextCursor);
      this.loaded.set(true);
    } catch (error) {
      if (version !== this.version || this.destroy.destroyed) return;
      if (
        error instanceof RpcError &&
        [RpcErrorCode.Unauthorized, RpcErrorCode.Forbidden, RpcErrorCode.NotFound, RpcErrorCode.Gone].includes(
          error.code,
        )
      ) {
        this.participants.set([]);
        this.cursor.set(undefined);
        this.retryable.set(false);
      }
      this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
}
