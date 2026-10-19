import { Router } from '@angular/router';
import { afterRenderEffect, Component, computed, ElementRef, inject, input, linkedSignal, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { LocalDatePipe } from '../../i18n/local-date.pipe';
import { IonBadge, IonIcon } from '@ionic/angular';
import { documentAttachOutline, downloadOutline, playCircle } from 'ionicons/icons';
import { type MessageResponse, MessageType } from '../../../generated/models';
import type { SnowflakeID } from '../../api/snowflake-id';
import { openMediaViewer } from '../media-viewer/media-viewer';
import { MessageDelivery } from '../message-delivery';
import { MessageStatus } from '../message-status/message-status';
import { type AttachmentUpload, UploadStatus } from '../upload';
import { UploadProgress } from '../upload-progress/upload-progress';
import { type VoiceDock } from '../voice-player/voice-playback';
import { VoicePlayer } from '../voice-player/voice-player';

import { albumLayout } from './album-layout';
import { attachmentKind, MediaKind } from './media-kind';

type Attachment = MessageResponse['attachments'][number];
type Sticker = NonNullable<MessageResponse['sticker']>;
export type MessageAttachmentSource = Pick<MessageResponse, 'messageType' | 'createdAt' | 'sender' | 'chatId'> & {
  id?: SnowflakeID;
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
  imports: [VoicePlayer, IonBadge, IonIcon, UploadProgress, MessageStatus, LocalDatePipe, TranslocoPipe],
  host: {
    '[class.overlay-time]': 'overlayTime()',
    '[class.album]': 'album()',
    '[class.visual]': 'visual()',
    '[class.fill]': 'fill()',
    '[style.width.px]': 'album() ? layout().intrinsicWidth : fillWidth()',
  },
})
export class MessageAttachments {
  private readonly router = inject(Router);
  protected async view(key: SnowflakeID | string, event: Event) {
    event.preventDefault();
    if (this.message().messageType === MessageType.sticker) return;
    event.stopPropagation();
    const media = this.items().filter((item) => item.kind === MediaKind.Image || item.kind === MediaKind.Video);
    await openMediaViewer(
      this.router,
      media,
      media.findIndex((item) => (item.id ?? item.url) === key),
    );
  }
  readonly message = input.required<MessageAttachmentSource>();
  readonly overlayTime = input(false);
  readonly outgoing = input(false);
  readonly delivery = input<MessageDelivery>();
  readonly uploads = input<readonly AttachmentUpload[]>([]);
  /** Confirmed messages hand their identity to the voice player so the docked bar can label and locate them. */
  protected readonly dock = computed<VoiceDock | undefined>(() => {
    const { id, chatId, sender, createdAt } = this.message();
    return id ? { messageId: id, chatId, label: sender.name ?? String(sender.uid), createdAt } : undefined;
  });
  protected readonly MediaKind = MediaKind;
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
      const limit = sticker ? 200 : 420;
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
    return items.length > 1 && this.visual();
  });
  /** Images and videos stretch with the bubble; audio and files keep their own width. */
  protected readonly visual = computed(() =>
    this.items().every((item) => item.kind === MediaKind.Image || item.kind === MediaKind.Video),
  );
  /** A single known-size image or video fills the bubble width; images blur only the side gutters. */
  protected readonly fill = computed(() => {
    const items = this.items();
    return !this.album() && items.length === 1 && this.visual() && items[0].knownSize && !items[0].sticker;
  });
  /** The unstretched display width gives the bubble its intrinsic size; flex-grow stretches beyond it.
   *  A real width (not flex-basis) is required: flex-basis is ignored when sizing the flex container,
   *  and the absolutely-positioned media contributes zero, collapsing media-only bubbles. */
  protected readonly fillWidth = computed(() => (this.fill() ? this.items()[0].displayWidth : null));
  protected readonly visibleItems = computed(() => (this.album() ? this.items().slice(0, 9) : this.items()));
  private readonly viewport = signal(
    {
      parentWidth: window.innerWidth,
      displayHeight: window.innerHeight,
      displayWidth: window.innerWidth,
      scale: window.devicePixelRatio,
    },
    {
      equal: (a, b) =>
        a.parentWidth === b.parentWidth &&
        a.displayHeight === b.displayHeight &&
        a.displayWidth === b.displayWidth &&
        a.scale === b.scale,
    },
  );
  private readonly albumWidth = signal<number | undefined>(undefined);
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
  protected readonly layout = computed(() => {
    const viewport = this.viewport();
    return albumLayout(
      this.albumSizes().slice(0, 9),
      this.albumWidth(),
      viewport.scale,
      {
        displayMin: Math.min(viewport.displayWidth, viewport.displayHeight) * viewport.scale,
        density: viewport.scale,
        outgoing: this.outgoing(),
        needShare: false,
      },
      viewport,
    );
  });

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterRenderEffect((onCleanup) => {
      if (!this.album()) return;
      const parent = host.closest('.chat-row');
      const updateViewport = () =>
        this.viewport.set({
          parentWidth: parent?.getBoundingClientRect().width || window.innerWidth,
          displayHeight: window.innerHeight,
          displayWidth: window.innerWidth,
          scale: window.devicePixelRatio,
        });
      updateViewport();
      const width = host.getBoundingClientRect().width;
      if (width) this.albumWidth.set(width);
      const observer = new ResizeObserver((entries) => {
        updateViewport();
        const entry = entries.find((entry) => entry.target === host);
        // Ionic also caches hidden pages whose measured width is zero.
        if (entry?.contentRect.width) this.albumWidth.set(entry.contentRect.width);
      });
      observer.observe(host);
      if (parent) observer.observe(parent);
      window.addEventListener('resize', updateViewport);
      onCleanup(() => {
        observer.disconnect();
        window.removeEventListener('resize', updateViewport);
      });
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
