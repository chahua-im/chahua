import { DatePipe } from '@angular/common';
import { afterRenderEffect, Component, computed, ElementRef, inject, input, linkedSignal, signal } from '@angular/core';
import { IonBadge, IonIcon, ModalController } from '@ionic/angular';
import { documentAttachOutline, downloadOutline, playCircle } from 'ionicons/icons';
import { type MessageResponse, MessageType } from '../../../generated/models';
import type { SnowflakeID } from '../../api/snowflake-id';
import { openMediaViewer } from '../media-viewer/media-viewer';
import { MessageDelivery } from '../message-delivery';
import { MessageStatus } from '../message-status/message-status';
import { type AttachmentUpload, UploadStatus } from '../upload';
import { UploadProgress } from '../upload-progress/upload-progress';
import { VoicePlayer } from '../voice-player/voice-player';

import { albumLayout, canCrop } from './album-layout';
import { attachmentKind, MediaKind } from './media-kind';

type Attachment = MessageResponse['attachments'][number];
type Sticker = NonNullable<MessageResponse['sticker']>;
export type MessageAttachmentSource = Pick<MessageResponse, 'messageType' | 'createdAt'> & {
  attachments: readonly (Pick<Attachment, 'url' | 'kind' | 'fileName' | 'size' | 'width' | 'height'> &
    Partial<Pick<Attachment, 'id'>>)[];
  sticker?: Pick<Sticker, 'id' | 'emoji' | 'name'> & {
    media: Pick<Sticker['media'], 'url' | 'contentType' | 'width' | 'height'> & Partial<Pick<Sticker['media'], 'size'>>;
  };
};

@Component({
  selector: 'app-message-attachments',
  templateUrl: './message-attachments.html',
  styleUrl: './message-attachments.scss',
  imports: [VoicePlayer, DatePipe, IonBadge, IonIcon, UploadProgress, MessageStatus],
  host: { '[class.overlay-time]': 'overlayTime()', '[class.album]': 'album()' },
})
export class MessageAttachments {
  private readonly modals = inject(ModalController);
  protected async view(key: SnowflakeID | string, event: Event) {
    event.preventDefault();
    if (this.message().messageType === MessageType.sticker) return;
    event.stopPropagation();
    const media = this.items().filter((item) => item.kind === MediaKind.Image || item.kind === MediaKind.Video);
    await openMediaViewer(
      this.modals,
      media,
      media.findIndex((item) => (item.id ?? item.url) === key),
    );
  }
  readonly message = input.required<MessageAttachmentSource>();
  readonly overlayTime = input(false);
  readonly delivery = input<MessageDelivery>();
  readonly uploads = input<readonly AttachmentUpload[]>([]);
  protected readonly MediaKind = MediaKind;
  protected readonly canCrop = canCrop;
  protected readonly items = computed(() => {
    const message = this.message();
    const sticker = message.messageType === MessageType.sticker ? message.sticker : undefined;
    const attachments = sticker
      ? [
          {
            ...sticker.media,
            id: sticker.id,
            kind: sticker.media.contentType,
            fileName: sticker.name || sticker.emoji,
          },
        ]
      : message.attachments;
    return attachments.map((attachment) => {
      const upload = this.uploads().find((upload) => upload.url === attachment.url);
      const state = upload?.state();
      const width = state?.width ?? attachment.width;
      const height = state?.height ?? attachment.height;
      // Older animated stickers and uploads can lack dimensions. Keep their fallback frame after loading.
      const knownSize = width != null && height != null && width > 0 && height > 0;
      const dimensions = knownSize ? { width, height } : { width: 240, height: 240 };
      const limit = sticker ? 200 : 360;
      return {
        ...attachment,
        kind: attachmentKind(message.messageType, attachment.kind),
        sticker: !!sticker,
        knownSize,
        progress:
          state?.status === UploadStatus.Processing || state?.status === UploadStatus.Uploading
            ? state.progress
            : undefined,
        ...dimensions,
        displayWidth: Math.min(dimensions.width, limit, (limit * dimensions.width) / dimensions.height),
      };
    });
  });
  protected readonly album = computed(() => {
    const items = this.items();
    return items.length > 1 && items.every((item) => item.kind === MediaKind.Image || item.kind === MediaKind.Video);
  });
  protected readonly visibleItems = computed(() => (this.album() ? this.items().slice(0, 9) : this.items()));
  private readonly albumWidth = signal(360);
  private readonly albumSizes = linkedSignal({
    source: this.items,
    computation: (items, previous): { width: number; height: number }[] =>
      items.map((item, index) => {
        const old = previous?.source[index];
        // Keep the initial frame, including the square fallback, while local media is processed.
        return old && (old.id ?? old.url) === (item.id ?? item.url)
          ? previous!.value[index]
          : { width: item.width, height: item.height };
      }),
  });
  protected readonly layout = computed(() =>
    albumLayout(this.albumSizes().slice(0, 9), this.albumWidth(), window.devicePixelRatio),
  );

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterRenderEffect((onCleanup) => {
      if (!this.album()) return;
      const width = host.getBoundingClientRect().width;
      if (width) this.albumWidth.set(width);
      const observer = new ResizeObserver(([entry]) => {
        // Ionic also caches hidden pages whose measured width is zero.
        if (entry.contentRect.width) this.albumWidth.set(entry.contentRect.width);
      });
      observer.observe(host);
      onCleanup(() => observer.disconnect());
    });
  }

  protected readonly failed = linkedSignal(() => {
    this.message();
    return new Set<SnowflakeID | string>();
  });
  protected readonly playIcon = playCircle;
  protected readonly fileIcon = documentAttachOutline;
  protected readonly downloadIcon = downloadOutline;

  protected fail(key: SnowflakeID | string) {
    this.failed.update((failed) => new Set(failed).add(key));
  }
}
