import { Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  IonAlert,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ToastController,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { TranslocoPipe, TranslocoService, translateSignal } from '@jsverse/transloco';
import { chatbubblesOutline } from 'ionicons/icons';
import { ServerWsMessageType, type MessagePreview as Preview } from '../../../generated/models';
import { Connection } from '../../api/connection';
import type { SnowflakeID } from '../../api/snowflake-id';
import { ChatListStore } from '../../chats/chat-list-store';
import { ChatStore } from '../../chats/chat-store';
import { ChatAvatar, conversationAvatar, type ChatAvatarData } from '../../chats/chat-avatar/chat-avatar';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';
import { MessagePreview } from '../message-preview/message-preview';
import { MessageOutbox } from '../message-outbox';
import {
  canForward,
  forwardSourceMessage,
  forwardPlaceholders,
  ForwardSelectionError,
  MAX_FORWARD_MESSAGES,
  type ForwardSource,
  type ForwardSourcesLoader,
  type ForwardSourcesResult,
} from '../forwarding';
import { ForwardPlaceholder } from '../forward-placeholder';

interface ForwardTarget {
  chatId: SnowflakeID;
  threadId?: SnowflakeID;
  name?: string;
  avatar: ChatAvatarData;
  preview?: Preview;
  replies?: number;
  time: number;
}

@Component({
  selector: 'app-forward-picker',
  templateUrl: './forward-picker.html',
  imports: [
    TranslocoPipe,
    ContentScrollbars,
    LoadError,
    ChatAvatar,
    MessagePreview,
    IonAlert,
    IonModal,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonSearchbar,
    IonSpinner,
    IonList,
    IonItem,
    IonLabel,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
  ],
})
export class ForwardPicker {
  readonly messages = input<readonly ForwardSource[]>([]);
  /** Replaces the fixed selection with the sources read when a target is chosen. */
  readonly load = input<ForwardSourcesLoader>();
  readonly closed = output<void>();
  readonly forwarded = output<void>();
  private readonly lists = inject(ChatListStore);
  private readonly metadata = inject(ChatStore);
  private readonly outbox = inject(MessageOutbox);
  private readonly toasts = inject(ToastController);
  private readonly i18n = inject(TranslocoService);
  private readonly sendingLabel = translateSignal('messages.forward.sending');
  protected readonly chats = this.lists.chats(false);
  protected readonly threads = this.lists.threads(false);
  protected readonly query = signal('');
  protected readonly maxForwardMessages = MAX_FORWARD_MESSAGES;
  protected readonly failure = signal<ForwardSelectionError | undefined>(undefined);
  protected readonly resolving = signal(false);
  /** Only a fixed selection that became stale or unsupported blocks the target list. */
  protected readonly invalid = computed(
    () => this.failure() === ForwardSelectionError.Stale || this.failure() === ForwardSelectionError.Unavailable,
  );
  protected readonly submitted = signal(false);
  protected readonly confirmation = signal<
    { target: ForwardTarget; prompt: string; selection: readonly ForwardSource[] } | undefined
  >(undefined);
  protected readonly open = signal(true);
  protected readonly mobile = !matchMedia('(min-width: 768px)').matches;
  protected readonly failed = computed(() => !!this.chats.error() || this.threads.error());
  protected readonly loading = computed(() => this.chats.loading() || this.threads.loading());
  protected readonly paging = signal(false);
  protected readonly moreAvailable = computed(
    () => (!this.chats.error() && this.chats.hasMore()) || (!this.threads.error() && this.threads.hasMore()),
  );
  protected readonly targets = computed(() => {
    const targets: ForwardTarget[] = [
      ...this.chats.items().map((chat) => ({
        chatId: chat.id,
        name: chat.peer?.username ?? chat.name,
        avatar: conversationAvatar(this.metadata.get(chat.id)),
        time: Date.parse(chat.lastMessageAt ?? '') || -Infinity,
      })),
      ...this.threads.items().map((thread) => ({
        chatId: thread.chatId,
        threadId: thread.threadRootMessage.id,
        name: thread.chatName,
        preview: thread.threadRootMessage,
        replies: thread.replyCount,
        avatar: { avatar: thread.chatAvatar, avatarName: thread.chatName, badgeIcon: chatbubblesOutline },
        time: Date.parse(thread.lastReplyAt),
      })),
    ];
    const query = this.query().trim().toLocaleLowerCase();
    return targets
      .filter(
        (target) =>
          !query || `${target.name ?? ''} ${target.preview?.message ?? ''}`.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) => b.time - a.time);
  });
  constructor() {
    const destroyRef = inject(DestroyRef);
    const releaseChats = this.chats.activate();
    const releaseThreads = this.threads.activate();
    destroyRef.onDestroy(() => {
      releaseChats();
      releaseThreads();
    });
    inject(Connection)
      .changes$.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        const sources = this.confirmation()?.selection ?? this.messages();
        if (event.payload.chatId !== sources[0]?.chatId) return;
        const removed =
          event.type === ServerWsMessageType.messageDeleted
            ? [event.payload.id]
            : event.type === ServerWsMessageType.messagesBulkDeleted
              ? event.payload.messageIds
              : [];
        if (
          sources.some((source) => {
            const id = forwardSourceMessage(source)?.id;
            return id != null && removed.includes(id);
          })
        )
          this.failure.set(ForwardSelectionError.Stale);
      });
  }
  protected async more(event?: InfiniteScrollCustomEvent) {
    if (this.paging()) {
      await event?.target.complete();
      return;
    }
    this.paging.set(true);
    try {
      const chatBoundary = this.chats.loadedThrough();
      const threadBoundary = this.threads.loadedThrough();
      const chats = !this.chats.error() && this.chats.hasMore();
      const threads = !this.threads.error() && this.threads.hasMore();
      await Promise.all([
        ...(chats && (!threads || chatBoundary >= threadBoundary) ? [this.chats.loadMore()] : []),
        ...(threads && (!chats || threadBoundary >= chatBoundary) ? [this.threads.loadMore()] : []),
      ]);
    } finally {
      this.paging.set(false);
      await event?.target.complete();
    }
  }
  protected async select(target: ForwardTarget) {
    if (this.submitted() || this.invalid() || this.confirmation() || !this.open() || this.resolving()) return;
    this.resolving.set(true);
    try {
      const result = await this.resolveSources();
      if (!this.open() || this.submitted() || this.invalid()) return;
      if ('error' in result) {
        this.failure.set(result.error);
        await this.report(result.error);
        return;
      }
      const selection = result.sources;
      if (!this.forwardable(selection)) {
        this.failure.set(this.load() ? ForwardSelectionError.TopicUnavailable : ForwardSelectionError.Unavailable);
        if (this.load()) await this.report(ForwardSelectionError.TopicUnavailable);
        return;
      }
      this.failure.set(undefined);
      const replacements = forwardPlaceholders(selection);
      if (replacements.size) {
        const reasons = new Set(replacements.values());
        const prompt =
          reasons.size > 1
            ? 'messages.forward.confirmBoth'
            : reasons.has(ForwardPlaceholder.PendingAudio)
              ? 'messages.forward.confirmPendingAudio'
              : 'messages.forward.confirmNested';
        this.confirmation.set({ target, prompt, selection });
        return;
      }
      void this.submit(target, selection, false);
    } finally {
      this.resolving.set(false);
    }
  }
  protected confirm(event: CustomEvent<{ role?: string }>) {
    const confirmation = this.confirmation();
    this.confirmation.set(undefined);
    if (confirmation && event.detail.role === 'confirm')
      void this.submit(confirmation.target, confirmation.selection, true);
  }
  private async resolveSources(): Promise<ForwardSourcesResult> {
    const load = this.load();
    if (!load) return { sources: this.messages() };
    try {
      return await load();
    } catch {
      return { error: ForwardSelectionError.LoadFailed };
    }
  }
  private async report(error: ForwardSelectionError) {
    const toast = await this.toasts.create({
      message: this.i18n.translate(error, { max: MAX_FORWARD_MESSAGES }),
      duration: 3000,
    });
    await toast.present();
  }
  /** Every source needs a server ID and must be allowed in a forward request. */
  private forwardable(selection: readonly ForwardSource[]): boolean {
    const messages = selection.map(forwardSourceMessage);
    return (
      !!messages.length &&
      messages.length <= MAX_FORWARD_MESSAGES &&
      messages.every((message) => !!message && canForward(message))
    );
  }
  private async submit(target: ForwardTarget, selection: readonly ForwardSource[], allowPlaceholders: boolean) {
    if (this.submitted() || this.invalid() || !this.open()) return;
    if (!this.forwardable(selection)) {
      this.failure.set(this.load() ? ForwardSelectionError.TopicUnavailable : ForwardSelectionError.Unavailable);
      return;
    }
    const sources = selection.flatMap((source) => {
      const message = forwardSourceMessage(source);
      return message ? [message] : [];
    });
    this.submitted.set(true);
    this.outbox.enqueueForward(target.chatId, target.threadId, sources, {
      allowPlaceholders,
      placeholders: forwardPlaceholders(selection),
    });
    this.forwarded.emit();
    this.open.set(false);
    const toast = await this.toasts.create({ message: this.sendingLabel(), duration: 2500 });
    await toast.present();
  }
}
