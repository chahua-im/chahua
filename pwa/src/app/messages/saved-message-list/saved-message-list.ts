import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  IonButton,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonSpinner,
  IonToast,
  ModalController,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { SavedMessagesService } from '../../../generated/endpoints/saved-messages/saved-messages.service';
import type { SavedMessageResponse } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { decodeId, type SnowflakeID } from '../../api/snowflake-id';
import { dismissChatOverlays } from '../../chats/dismiss-chat-overlays';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { SessionStore } from '../../session/session-store';
import { Message } from '../message/message';
import { savedMessageContent } from './saved-message-content';

@Component({
  selector: 'app-saved-message-list',
  templateUrl: './saved-message-list.html',
  styleUrl: './saved-message-list.scss',
  imports: [DatePipe, IonButton, IonInfiniteScroll, IonInfiniteScrollContent, IonSpinner, IonToast, Message],
})
export class SavedMessageList {
  readonly chatId = input<SnowflakeID>();
  private readonly chatsApi = inject(ChatsService);
  protected readonly session = inject(SessionStore);
  private readonly savedApi = inject(SavedMessagesService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly modals = inject(ModalController);
  private version = 0;
  private readonly cancelReads = new Subject<void>();
  protected readonly saved = signal<SavedMessageResponse[]>([]);
  protected readonly savedRows = computed(() =>
    this.saved().map((item) => ({ item, content: savedMessageContent(item) })),
  );
  protected readonly nextCursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly removingSavedId = signal<SnowflakeID | undefined>(undefined);
  protected readonly removeFailed = signal(false);
  constructor() {
    fillScrollViewport(this.loading, this.failed, this.nextCursor, () => this.load(true));
    effect(() => {
      this.chatId();
      untracked(() => this.reset());
    });

    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => this.reset());
    this.destroyRef.onDestroy(() => this.version++);
  }
  private reset() {
    this.version++;
    this.cancelReads.next();
    this.saved.set([]);
    this.nextCursor.set(undefined);
    this.loading.set(false);
    this.removingSavedId.set(undefined);
    this.failed.set(false);
    this.removeFailed.set(false);
    void this.load();
  }
  protected async more(event: InfiniteScrollCustomEvent) {
    try {
      await this.load(true);
    } finally {
      await event.target.complete();
    }
  }
  protected async load(more = false) {
    if (this.loading() || (more && !this.nextCursor())) return;
    const version = this.version;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const page = await firstValueFrom(
        (this.chatId()
          ? this.chatsApi.listChatSavedMessages(this.chatId()!, {
              limit: 50,
              before: more ? this.nextCursor() : undefined,
            })
          : this.savedApi.listSavedMessages({ limit: 50, ...(more ? { before: this.nextCursor()! } : {}) })
        ).pipe(takeUntil(this.cancelReads), takeUntilDestroyed(this.destroyRef)),
      );
      if (version !== this.version) return;
      this.saved.update((items) => [
        ...new Map([...(more ? items : []), ...page.savedMessages].map((item) => [item.id, item])).values(),
      ]);
      this.nextCursor.set(page.nextCursor);
    } catch {
      if (version === this.version) this.failed.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
  protected async locateSaved(saved: SavedMessageResponse) {
    if (!saved.canLocateContext) return;
    await dismissChatOverlays(this.modals);
    await this.router.navigate(
      [
        '/chats/chat',
        decodeId(saved.originalChatId),
        ...(saved.originalThreadRootId ? ['thread', decodeId(saved.originalThreadRootId)] : []),
      ],
      { queryParams: { message: decodeId(saved.originalMessageId) } },
    );
  }
  protected async removeSaved(saved: SavedMessageResponse) {
    if (this.removingSavedId()) return;
    const version = this.version;
    this.removingSavedId.set(saved.id);
    this.removeFailed.set(false);
    try {
      await firstValueFrom(this.savedApi.deleteSavedMessageById(saved.id).pipe(takeUntilDestroyed(this.destroyRef)));
      if (version === this.version) this.saved.update((items) => items.filter((item) => item.id !== saved.id));
    } catch {
      if (version === this.version) this.removeFailed.set(true);
    } finally {
      if (version === this.version) this.removingSavedId.set(undefined);
    }
  }
}
