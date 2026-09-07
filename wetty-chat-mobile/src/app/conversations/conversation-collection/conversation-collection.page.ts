import { Preferences } from '../../settings/preferences';
import { ConversationStore } from '../conversation-store';
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
  viewChild,
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
import { type MessageResponse, type SavedMessageResponse } from '../../../generated/models';
import { SavedMessagesService } from '../../../generated/endpoints/saved-messages/saved-messages.service';
import { Message } from '../../messages/message/message';
import { MessageMenu } from '../../messages/message-menu/message-menu';
import { ChatStore } from '../../chats/chat-store';
import { Connection } from '../../api/connection';
import { SessionStore } from '../../session/session-store';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { ConversationCollectionKind } from '../conversation-collection-kind';
import { savedMessageContent } from './saved-message-content';
import { messageRows } from '../message-rows';

@Component({
  selector: 'app-conversation-collection',
  templateUrl: './conversation-collection.page.html',
  styleUrl: './conversation-collection.page.scss',
  providers: [ConversationStore],
  imports: [
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
    MessageMenu,
  ],
})
export class ConversationCollectionPage {
  readonly collection = input.required<ConversationCollectionKind>();
  readonly id = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  readonly threadId = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  protected readonly Kind = ConversationCollectionKind;
  protected readonly conversation = inject(ConversationStore);
  protected readonly session = inject(SessionStore);
  protected readonly preferences = inject(Preferences);
  private readonly savedApi = inject(SavedMessagesService);
  private readonly chatInfo = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly menu = viewChild(MessageMenu);
  private active = false;
  private version = 0;
  protected readonly saved = signal<SavedMessageResponse[]>([]);
  protected readonly savedRows = computed(() =>
    this.saved().map((item) => ({ item, content: savedMessageContent(item) })),
  );
  protected readonly nextCursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly removingSavedId = signal<SnowflakeID | undefined>(undefined);
  protected readonly removeFailed = signal(false);
  protected readonly rows = computed(() =>
    messageRows(
      this.conversation
        .pins()
        .map((pin) => pin.message)
        .sort((a, b) => a.id - b.id),
    ),
  );
  protected readonly backHref = computed(() =>
    this.collection() === ConversationCollectionKind.Saved
      ? '/chats'
      : `/chats/chat/${decodeId(this.id()!)}${this.threadId() ? `/thread/${decodeId(this.threadId()!)}` : ''}`,
  );

  constructor() {
    effect(() => {
      this.collection();
      this.id();
      this.threadId();
      untracked(() => this.activate());
    });
    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.active) this.activate();
      });
    this.destroyRef.onDestroy(() => this.leave());
  }

  private readonly cancelReads = new Subject<void>();

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
    this.menu()?.reset();
    this.conversation.reset(
      this.collection() === ConversationCollectionKind.Pins ? this.id() : undefined,
      this.threadId(),
    );
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
    this.menu()?.reset();
    this.conversation.reset();
    this.saved.set([]);
  }

  protected async load(more = false) {
    if (this.loading() || (more && !this.nextCursor())) return;
    const version = this.version;
    this.loading.set(true);
    this.failed.set(false);
    try {
      if (this.collection() === ConversationCollectionKind.Pins) {
        await Promise.all([this.conversation.ensurePins(), this.chatInfo.ensureDetails(this.id()!)]);
      } else {
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
      }
    } catch {
      if (version === this.version) this.failed.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }

  protected locateMessage(message: MessageResponse, messageId: SnowflakeID) {
    void this.router.navigate(this.originalCommands(message), { queryParams: { message: decodeId(messageId) } });
  }

  protected replyTo(message: MessageResponse) {
    void this.router.navigate(this.originalCommands(message), { queryParams: { reply: decodeId(message.id) } });
  }

  protected openThread(chatId: SnowflakeID, rootId: SnowflakeID) {
    void this.router.navigate(['/chats/chat', decodeId(chatId), 'thread', decodeId(rootId)]);
  }

  private originalCommands(message: MessageResponse) {
    const threadId = this.conversation.pinFor(message.id)?.threadRootId ?? message.replyRootId;
    return ['/chats/chat', decodeId(message.chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])];
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
