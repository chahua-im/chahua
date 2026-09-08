import { DatePipe } from '@angular/common';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { IonBadge, IonIcon, IonSpinner, ModalController } from '@ionic/angular';
import { documentAttachOutline, downloadOutline, playCircle } from 'ionicons/icons';
import { type MessageResponse, MessageType } from '../../../generated/models';
import type { SnowflakeID } from '../../api/snowflake-id';
import { openMediaViewer } from '../media-viewer/media-viewer';
import { MessageDelivery } from '../message-delivery';
import { MessageStatus } from '../message-status/message-status';
import { type AttachmentUpload, UploadStatus } from '../upload';
import { VoicePlayer } from '../voice-player/voice-player';

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
  imports: [VoicePlayer, DatePipe, IonBadge, IonIcon, IonSpinner, MessageStatus],
  host: { '[class.overlay-time]': 'overlayTime()' },
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
      const dimensions = width && height && width > 0 && height > 0 ? { width, height } : { width: 240, height: 240 };
      const limit = sticker ? 200 : 360;
      return {
        ...attachment,
        kind: attachmentKind(message.messageType, attachment.kind),
        sticker: !!sticker,
        uploading: state?.status === UploadStatus.Processing || state?.status === UploadStatus.Uploading,
        ...dimensions,
        displayWidth: Math.min(dimensions.width, limit, (limit * dimensions.width) / dimensions.height),
      };
    });
  });
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
