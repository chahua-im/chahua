import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  IonButton,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonSpinner,
  ModalController,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { ChatAttachmentKindFilter, type ChatAttachmentResponse, type SnowflakeID } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { openMediaViewer } from '../../messages/media-viewer/media-viewer';
import { mediaKind, MediaKind } from '../../messages/message-attachments/media-kind';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { dismissChatOverlays } from '../dismiss-chat-overlays';
@Component({
  selector: 'app-chat-attachments',
  templateUrl: './chat-attachments.html',
  styleUrl: './chat-attachments.scss',
  imports: [IonInfiniteScroll, IonInfiniteScrollContent, IonLabel, IonItem, IonList, IonButton, IonSpinner],
})
export class ChatAttachments {
  readonly chatId = input.required<SnowflakeID>();
  protected readonly Kind = ChatAttachmentKindFilter;
  readonly kind = input(ChatAttachmentKindFilter.image);
  protected readonly items = signal<ChatAttachmentResponse[]>([]);
  protected readonly cursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly locating = signal<SnowflakeID | undefined>(undefined);
  protected readonly locateFailed = signal(false);
  protected readonly opening = signal<SnowflakeID | undefined>(undefined);
  protected readonly openFailed = signal(false);
  protected readonly error = signal(false);
  private readonly api = inject(ChatsService);
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly destroy = inject(DestroyRef);
  private version = 0;
  constructor() {
    fillScrollViewport(this.loading, this.error, this.cursor, () => this.load(true));
    effect(() => {
      this.chatId();
      this.kind();
      void this.load();
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
    if (more && (this.loading() || this.cursor() == null)) return;
    const version = ++this.version;
    if (!more) {
      this.items.set([]);
      this.cursor.set(undefined);
    }
    this.loading.set(true);
    this.error.set(false);
    try {
      const page = await firstValueFrom(
        this.api
          .getChatAttachments(this.chatId(), { kind: this.kind(), limit: 36, before: more ? this.cursor() : undefined })
          .pipe(takeUntilDestroyed(this.destroy)),
      );
      if (version !== this.version) return;
      this.items.update((items) => (more ? [...items, ...page.attachments] : page.attachments));
      this.cursor.set(page.olderCursor);
    } catch {
      if (version === this.version) this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
  protected async view(item: ChatAttachmentResponse, event?: Event) {
    event?.preventDefault();
    if (this.opening()) return;
    const chatId = this.chatId();
    const kind = this.kind();
    this.opening.set(item.id);
    this.openFailed.set(false);
    try {
      const message = await firstValueFrom(
        this.api.getMessage(chatId, item.messageId).pipe(takeUntilDestroyed(this.destroy)),
      );
      if (this.destroy.destroyed || this.chatId() !== chatId || this.kind() !== kind) return;
      const media = message.attachments
        .map((attachment) => ({ ...attachment, kind: mediaKind(attachment.kind) }))
        .filter((item) => item.kind === MediaKind.Image || item.kind === MediaKind.Video);
      // A stale media summary can outlive a recalled message; its original file still opens.
      if (!media.length) media.push({ ...item, kind: mediaKind(item.kind) });
      await openMediaViewer(
        this.modals,
        media,
        media.findIndex((attachment) => attachment.id === item.id),
      );
    } catch {
      if (!this.destroy.destroyed && this.chatId() === chatId && this.kind() === kind) this.openFailed.set(true);
    } finally {
      this.opening.set(undefined);
    }
  }
  protected async locate(item: ChatAttachmentResponse) {
    if (this.locating()) return;
    this.locating.set(item.id);
    this.locateFailed.set(false);
    try {
      const message = await firstValueFrom(
        this.api.getMessage(this.chatId(), item.messageId).pipe(takeUntilDestroyed(this.destroy)),
      );
      await dismissChatOverlays(this.modals);
      await this.router.navigate(
        [
          '/chats/chat',
          decodeId(this.chatId()),
          ...(message.replyRootId ? ['thread', decodeId(message.replyRootId)] : []),
        ],
        {
          queryParams: { message: decodeId(item.messageId) },
        },
      );
    } catch {
      this.locateFailed.set(true);
    } finally {
      this.locating.set(undefined);
    }
  }
}
