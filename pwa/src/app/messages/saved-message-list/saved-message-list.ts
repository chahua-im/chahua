import { Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import { MessageDatePipe } from '../message-date.pipe';
import {
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
import { RpcApi } from '../../../generated/rpc-api';
import type { SavedMessageResponse } from '../../../generated/models';
import { Connection } from '../../api/connection';
import type { SnowflakeID } from '../../api/snowflake-id';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { SessionStore } from '../../session/session-store';
import { LoadError } from '../../ui/load-error/load-error';
import { Message, type MessageMenuSelection } from '../message/message';
import { savedMessageContent } from './saved-message-content';
import { readPages } from '../../api/query';
import { RpcError, RpcErrorCode } from '../../api/rpc-error';

@Component({
  selector: 'app-saved-message-list',
  host: { '[class.load-error-page]': 'failed() && !savedRows().length' },
  templateUrl: './saved-message-list.html',
  styleUrl: './saved-message-list.scss',
  imports: [
    MessageDatePipe,
    TranslocoPipe,
    LoadError,
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
  private readonly savedApi = inject(RpcApi);
  private readonly navigation = inject(ConversationNavigation);
  private readonly destroyRef = inject(DestroyRef);
  private version = 0;
  private refreshPending = false;
  private retryMore = false;
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
    let owner = this.session.user()?.uid;
    effect(() => {
      const uid = this.session.user()?.uid;
      if (uid === owner) return;
      owner = uid;
      untracked(() => this.reset());
    });

    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => this.refresh());
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
    this.refreshPending = false;
    if (this.session.user()) void this.load();
  }
  private refresh() {
    // A refreshed snapshot must not resurrect an optimistic deletion still in flight.
    if (this.removing()) {
      this.refreshPending = true;
      return;
    }
    this.refreshPending = false;
    this.version++;
    this.cancelReads.next();
    this.loading.set(false);
    if (this.session.user()) void this.load();
  }
  protected retry() {
    void this.load(this.retryMore);
  }
  protected async more(event: InfiniteScrollCustomEvent) {
    try {
      await this.load(true);
    } finally {
      await event.target.complete();
    }
  }
  protected async load(more = false) {
    if (this.loading() || this.removing() || (more && !this.nextCursor())) return;
    const version = this.version;
    this.retryMore = more;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const read = async (before?: SnowflakeID) => {
        const page = await firstValueFrom(
          this.savedApi.savedMessages
            .list({ limit: 50, ...(before ? { before } : {}) })
            .pipe(takeUntil(this.cancelReads), takeUntilDestroyed(this.destroyRef)),
        );
        return { items: page.savedMessages, cursor: page.nextCursor };
      };
      const page = more
        ? await read(this.nextCursor())
        : await readPages(read, this.saved().length, () => version === this.version);
      if (version !== this.version) return;
      this.saved.update((items) => [
        ...new Map([...(more ? items : []), ...page.items].map((item) => [item.id, item])).values(),
      ]);
      this.menu.update((selection) => {
        if (!selection) return undefined;
        const item = this.saved().find((item) => item.id === selection.item.id);
        return item ? { ...selection, item } : undefined;
      });
      this.nextCursor.set(page.cursor);
    } catch (error) {
      if (version === this.version) {
        this.failed.set(true);
        if (
          error instanceof RpcError &&
          (error.code === RpcErrorCode.Unauthorized || error.code === RpcErrorCode.Forbidden)
        ) {
          this.saved.set([]);
          this.nextCursor.set(undefined);
          this.menu.set(undefined);
          this.retryMore = false;
        }
      }
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
  protected async locateSaved(saved: SavedMessageResponse) {
    if (!saved.canLocateContext) return;
    this.menu.set(undefined);
    await this.navigation.open(saved.originalChatId, saved.originalThreadRootId, saved.originalMessageId);
  }
  protected async removeSaved(item: SavedMessageResponse) {
    if (this.removing()) return;
    const version = this.version;
    const index = this.saved().findIndex((saved) => saved.id === item.id);
    this.menu.set(undefined);
    if (index < 0) return;
    const saved = this.saved()[index];
    this.saved.update((items) => items.filter((item) => item.id !== saved.id));
    this.removing.set(true);
    this.removeFailed.set(false);
    try {
      await firstValueFrom(
        this.savedApi.savedMessages.delete({ savedMessageId: saved.id }).pipe(takeUntilDestroyed(this.destroyRef)),
      );
    } catch {
      if (version === this.version) {
        this.saved.update((items) => [...items.slice(0, index), saved, ...items.slice(index)]);
        this.removeFailed.set(true);
      }
    } finally {
      if (version === this.version) {
        this.removing.set(false);
        if (this.refreshPending) this.refresh();
      }
    }
  }
}
