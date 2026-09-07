import { Component, computed, input } from '@angular/core';
import { MessageType, type MessageResponse } from '../../../generated/models';
import { MediaKind, mediaKind } from '../message-attachments/media-kind';

type PreviewSource = Pick<MessageResponse, 'message' | 'messageType'> &
  Partial<Pick<MessageResponse, 'isDeleted'>> & {
    attachments: readonly { kind: string }[];
  };

@Component({
  selector: 'app-message-preview',
  templateUrl: './message-preview.html',
})
export class MessagePreview {
  readonly message = input.required<PreviewSource>();
  protected readonly MessageType = MessageType;
  protected readonly MediaKind = MediaKind;
  protected readonly media = computed(() => mediaKind(this.message().attachments[0]?.kind));
}
