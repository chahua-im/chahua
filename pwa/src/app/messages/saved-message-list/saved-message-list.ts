import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  IonButton,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonSpinner,
  IonToast,
  IonPopover,
  IonList,
  IonItem,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { SavedMessagesService } from '../../../generated/endpoints/saved-messages/saved-messages.service';
import type { SavedMessageResponse } from '../../../generated/models';
import { Connection } from '../../api/connection';
import type { SnowflakeID } from '../../api/snowflake-id';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { SessionStore } from '../../session/session-store';
import { Message, type MessageMenuSelection } from '../message/message';
import { savedMessageContent } from './saved-message-content';

@Component({
  selector: 'app-saved-message-list',
  templateUrl: './saved-message-list.html',
  styleUrl: './saved-message-list.scss',
  imports: [
    DatePipe,
    IonButton,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonSpinner,
    IonToast,
    IonPopover,
    IonList,
    IonItem,
    Message,
  ],
})
export class SavedMessageList {
  protected readonly session = inject(SessionStore);
  private readonly savedApi = inject(SavedMessagesService);
  private readonly navigation = inject(ConversationNavigation);
  private readonly destroyRef = inject(DestroyRef);
  private version = 0;
  private readonly cancelReads = new Subject<void>();
  protected readonly saved = signal<SavedMessageResponse[]>([]);
  protected readonly savedRows = computed(() =>
    this.saved().map((item) => ({ item, content: savedMessageContent(item) })),
  );
  protected readonly nextCursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly removing = signal(false);
  protected readonly removeFailed = signal(false);
  protected readonly menu = signal<{ item: SavedMessageResponse; event: MouseEvent } | undefined>(undefined);

  protected openMenu(item: SavedMessageResponse, selection: MessageMenuSelection) {
    const point = selection.point ?? { x: selection.rect.x + selection.rect.width / 2, y: selection.rect.y };
    this.menu.set({ item, event: new MouseEvent('contextmenu', { clientX: point.x, clientY: point.y }) });
  }
  constructor() {
    fillScrollViewport(this.loading, this.failed, this.nextCursor, () => this.load(true));
    this.reset();

    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => this.reset());
    this.destroyRef.onDestroy(() => this.version++);
  }
  private reset() {
    this.version++;
    this.menu.set(undefined);
    this.cancelReads.next();
    this.saved.set([]);
    this.nextCursor.set(undefined);
    this.loading.set(false);
    this.removing.set(false);
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
        this.savedApi
          .listSavedMessages({ limit: 50, ...(more ? { before: this.nextCursor()! } : {}) })
          .pipe(takeUntil(this.cancelReads), takeUntilDestroyed(this.destroyRef)),
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
    this.menu.set(undefined);
    await this.navigation.open(saved.originalChatId, saved.originalThreadRootId, saved.originalMessageId);
  }
  protected async removeSaved(saved: SavedMessageResponse) {
    if (this.removing()) return;
    const version = this.version;
    const index = this.saved().findIndex((item) => item.id === saved.id);
    this.menu.set(undefined);
    this.saved.update((items) => items.filter((item) => item.id !== saved.id));
    this.removing.set(true);
    this.removeFailed.set(false);
    try {
      await firstValueFrom(this.savedApi.deleteSavedMessageById(saved.id).pipe(takeUntilDestroyed(this.destroyRef)));
    } catch {
      if (version === this.version) {
        this.saved.update((items) => [...items.slice(0, index), saved, ...items.slice(index)]);
        this.removeFailed.set(true);
      }
    } finally {
      if (version === this.version) this.removing.set(false);
    }
  }
}
