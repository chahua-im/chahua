import { dismissChatOverlays } from '../../chats/dismiss-chat-overlays';
import { Component, effect, inject, input, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  IonSegment,
  IonSegmentButton,
  IonLabel,
  IonItem,
  IonList,
  IonButton,
  IonSpinner,
  ModalController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { ChatAttachmentKindFilter, type ChatAttachmentResponse, type SnowflakeID } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { MediaViewer } from '../../messages/media-viewer/media-viewer';
@Component({
  selector: 'app-chat-attachments',
  templateUrl: './chat-attachments.html',
  styles: [
    '.media{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px}.media button{padding:0;aspect-ratio:1;background:var(--ion-color-light);overflow:hidden}.media img,.media video{height:100%;width:100%;object-fit:cover}',
  ],
  imports: [IonSegment, IonSegmentButton, IonLabel, IonItem, IonList, IonButton, IonSpinner],
})
export class ChatAttachments {
  readonly chatId = input.required<SnowflakeID>();
  protected readonly Kind = ChatAttachmentKindFilter;
  protected readonly kind = signal(ChatAttachmentKindFilter.image);
  protected readonly items = signal<ChatAttachmentResponse[]>([]);
  protected readonly cursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly locating = signal<SnowflakeID | undefined>(undefined);
  protected readonly locateFailed = signal(false);
  protected readonly error = signal(false);
  private readonly api = inject(ChatsService);
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly destroy = inject(DestroyRef);
  private version = 0;
  constructor() {
    effect(() => {
      this.chatId();
      this.kind();
      void this.load();
    });
  }
  protected change(value: unknown) {
    if (Object.values(ChatAttachmentKindFilter).includes(value as ChatAttachmentKindFilter))
      this.kind.set(value as ChatAttachmentKindFilter);
  }
  protected async load(more = false) {
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
  protected async view(index: number) {
    const modal = await this.modals.create({
      component: MediaViewer,
      componentProps: { images: this.items(), initial: index },
    });
    await modal.present();
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
