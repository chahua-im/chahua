import { MediaViewer } from '../media-viewer/media-viewer';
import { ModalController } from '@ionic/angular';
import { inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Component, computed, input, linkedSignal } from '@angular/core';
import { IonBadge, IonIcon } from '@ionic/angular';
import { documentAttachOutline, downloadOutline } from 'ionicons/icons';
import { type MessageResponse, MessageType } from '../../../generated/models';
import type { SnowflakeID } from '../../api/snowflake-id';

import { attachmentKind, MediaKind } from './media-kind';

type Attachment = MessageResponse['attachments'][number];
type Sticker = NonNullable<MessageResponse['sticker']>;
export type MessageAttachmentSource = Pick<MessageResponse, 'messageType' | 'createdAt'> & {
  attachments: readonly Pick<Attachment, 'id' | 'url' | 'kind' | 'fileName' | 'size' | 'width' | 'height'>[];
  sticker?: Pick<Sticker, 'id' | 'emoji' | 'name'> & {
    media: Pick<Sticker['media'], 'url' | 'contentType' | 'width' | 'height'> & Partial<Pick<Sticker['media'], 'size'>>;
  };
};

@Component({
  selector: 'app-message-attachments',
  templateUrl: './message-attachments.html',
  styleUrl: './message-attachments.scss',
  imports: [DatePipe, IonBadge, IonIcon],
  host: { '[class.overlay-time]': 'overlayTime()' },
})
export class MessageAttachments {
  private readonly modals = inject(ModalController);
  protected async view(id: SnowflakeID, event: Event) {
    event.preventDefault();
    if (this.message().messageType === MessageType.sticker) return;
    event.stopPropagation();
    const images = this.items().filter((item) => item.kind === MediaKind.Image);
    const modal = await this.modals.create({
      component: MediaViewer,
      componentProps: { images, initial: images.findIndex((item) => item.id === id) },
    });
    await modal.present();
  }
  readonly message = input.required<MessageAttachmentSource>();
  readonly overlayTime = input(false);
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
      const { width, height } = attachment;
      // Older animated stickers and uploads can lack dimensions. Keep their fallback frame after loading.
      const dimensions = width && height && width > 0 && height > 0 ? { width, height } : { width: 240, height: 240 };
      const limit = sticker ? 200 : 360;
      return {
        ...attachment,
        kind: attachmentKind(message.messageType, attachment.kind),
        sticker: !!sticker,
        ...dimensions,
        displayWidth: Math.min(dimensions.width, limit, (limit * dimensions.width) / dimensions.height),
      };
    });
  });
  protected readonly failed = linkedSignal(() => {
    this.items();
    return new Set<SnowflakeID>();
  });
  protected readonly fileIcon = documentAttachOutline;
  protected readonly downloadIcon = downloadOutline;

  protected fail(id: SnowflakeID) {
    this.failed.update((failed) => new Set(failed).add(id));
  }
}
