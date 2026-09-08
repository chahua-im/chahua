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
  IonToolbar,
} from '@ionic/angular';
import type { MessageResponse } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { ChatStore } from '../../chats/chat-store';
import { MessageMenu } from '../../messages/message-menu/message-menu';
import { Message } from '../../messages/message/message';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { messageRows } from '../message-rows';

@Component({
  selector: 'app-pinned-messages',
  templateUrl: './pinned-messages.page.html',
  styleUrl: './pinned-messages.page.scss',
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
    IonToolbar,
    Message,
    MessageMenu,
  ],
})
export class PinnedMessagesPage {
  readonly id = input.required<SnowflakeID, string>({ transform: encodeId });
  readonly threadId = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  private readonly chatInfo = inject(ChatStore);
  protected readonly pins = computed(() => this.chatInfo.pins(this.id(), this.threadId()));
  protected readonly messages = computed(() =>
    this.pins()
      .items()
      .map((pin) => pin.message)
      .filter((message) => !message.isDeleted)
      .sort((a, b) => a.id - b.id),
  );
  protected readonly rows = computed(() => messageRows(this.messages()));
  protected readonly session = inject(SessionStore);
  protected readonly preferences = inject(Preferences);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly menu = viewChild(MessageMenu);
  private active = false;
  private version = 0;
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly backHref = computed(
    () => `/chats/chat/${decodeId(this.id())}${this.threadId() ? `/thread/${decodeId(this.threadId()!)}` : ''}`,
  );
  constructor() {
    effect(() => {
      this.id();
      this.threadId();
      untracked(() => this.activate());
    });
    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.active) void this.load();
      });
    this.destroyRef.onDestroy(() => this.leave());
  }
  private activate() {
    this.active = true;
    this.version++;
    this.menu()?.reset();
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
    this.loading.set(false);
    this.menu()?.reset();
  }
  protected async load() {
    const version = this.version;
    this.loading.set(true);
    this.failed.set(false);
    try {
      await Promise.all([this.pins().ensure(), this.chatInfo.ensureDetails(this.id())]);
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
    const threadId = this.pins().get(message.id)?.threadRootId ?? message.replyRootId;
    return ['/chats/chat', decodeId(message.chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])];
  }
}
