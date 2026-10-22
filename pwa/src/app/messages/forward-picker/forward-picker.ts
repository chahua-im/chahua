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
import { TranslocoPipe, translateSignal } from '@jsverse/transloco';
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
  MAX_FORWARD_MESSAGES,
  type ForwardSource,
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
  readonly messages = input.required<readonly ForwardSource[]>();
  readonly closed = output<void>();
  readonly forwarded = output<void>();
  private readonly lists = inject(ChatListStore);
  private readonly metadata = inject(ChatStore);
  private readonly outbox = inject(MessageOutbox);
  private readonly toasts = inject(ToastController);
  private readonly sendingLabel = translateSignal('messages.forward.sending');
  protected readonly chats = this.lists.chats(false);
  protected readonly threads = this.lists.threads(false);
  protected readonly query = signal('');
  protected readonly invalid = signal(false);
  protected readonly submitted = signal(false);
  protected readonly confirmation = signal<{ target: ForwardTarget; prompt: string } | undefined>(undefined);
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
        const sources = this.messages();
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
          this.invalid.set(true);
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
  protected select(target: ForwardTarget) {
    if (this.submitted() || this.invalid() || this.confirmation() || !this.open()) return;
    const sources = this.messages().map(forwardSourceMessage);
    if (
      !sources.length ||
      sources.length > MAX_FORWARD_MESSAGES ||
      sources.some((message) => !message || !canForward(message))
    ) {
      this.invalid.set(true);
      return;
    }
    const replacements = forwardPlaceholders(this.messages());
    if (replacements.size) {
      const reasons = new Set(replacements.values());
      const prompt =
        reasons.size > 1
          ? 'messages.forward.confirmBoth'
          : reasons.has(ForwardPlaceholder.PendingAudio)
            ? 'messages.forward.confirmPendingAudio'
            : 'messages.forward.confirmNested';
      this.confirmation.set({ target, prompt });
      return;
    }
    void this.submit(target, false);
  }
  protected confirm(event: CustomEvent<{ role?: string }>) {
    const confirmation = this.confirmation();
    this.confirmation.set(undefined);
    if (confirmation && event.detail.role === 'confirm') void this.submit(confirmation.target, true);
  }
  private async submit(target: ForwardTarget, allowPlaceholders: boolean) {
    if (this.submitted() || this.invalid() || !this.open()) return;
    const selection = this.messages();
    const sources = selection.map(forwardSourceMessage);
    if (
      !sources.length ||
      sources.length > MAX_FORWARD_MESSAGES ||
      sources.some((message) => !message || !canForward(message))
    ) {
      this.invalid.set(true);
      return;
    }
    this.submitted.set(true);
    this.outbox.enqueueForward(
      target.chatId,
      target.threadId,
      sources.filter((message) => message != null),
      {
        allowPlaceholders,
        placeholders: forwardPlaceholders(selection),
      },
    );
    this.forwarded.emit();
    this.open.set(false);
    const toast = await this.toasts.create({ message: this.sendingLabel(), duration: 2500 });
    await toast.present();
  }
}
