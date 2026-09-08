import { DatePipe } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { SavedMessagesService } from '../../../generated/endpoints/saved-messages/saved-messages.service';
import type { SavedMessageResponse } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { Message } from '../../messages/message/message';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { savedMessageContent } from './saved-message-content';

@Component({
  selector: 'app-saved-messages',
  templateUrl: './saved-messages.page.html',
  styleUrl: './saved-messages.page.scss',
  imports: [
    ContentScrollbars,
    DatePipe,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToolbar,
    Message,
  ],
})
export class SavedMessagesPage {
  readonly id = input<string>();
  private readonly chatsApi = inject(ChatsService);
  protected readonly session = inject(SessionStore);
  private readonly savedApi = inject(SavedMessagesService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private active = false;
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
    effect(() => {
      this.id();
      untracked(() => this.activate());
    });

    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.active) this.activate();
      });
    this.destroyRef.onDestroy(() => this.leave());
  }
  private activate() {
    this.active = true;
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
  ionViewDidEnter() {
    if (!this.active) this.activate();
  }
  ionViewDidLeave() {
    this.leave();
    this.changeDetector.detectChanges();
  }
  private leave() {
    this.active = false;
    this.version++;
    this.cancelReads.next();
    this.saved.set([]);
  }
  protected async load(more = false) {
    if (this.loading() || (more && !this.nextCursor())) return;
    const version = this.version;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const page = await firstValueFrom(
        (this.id()
          ? this.chatsApi.listChatSavedMessages(encodeId(this.id()!), {
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
  protected locateSaved(saved: SavedMessageResponse) {
    if (saved.canLocateContext) this.locate(saved.originalChatId, saved.originalMessageId, saved.originalThreadRootId);
  }
  private locate(chatId: SnowflakeID, messageId: SnowflakeID, threadId?: SnowflakeID) {
    void this.router.navigate(['/chats/chat', decodeId(chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])], {
      queryParams: { message: decodeId(messageId) },
    });
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
