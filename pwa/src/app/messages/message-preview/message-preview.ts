import { Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouterLink } from '@angular/router';
import { MessageType, type MessageResponse } from '../../../generated/models';
import { MediaKind, attachmentKind } from '../message-attachments/media-kind';
import { messageLink } from '../message-link';
import { placeholderLabel } from '../forward-placeholder';
import { systemMessagePresentation } from '../system-message';
import { MarkdownSummary } from './markdown-summary';

type PreviewSource = Pick<MessageResponse, 'message' | 'messageType'> &
  Partial<Pick<MessageResponse, 'isDeleted' | 'mentions' | 'sender' | 'systemLinks' | 'systemKind' | 'chatId'>> & {
    attachments: readonly { kind: string }[];
  };

@Component({
  selector: 'app-message-preview',
  templateUrl: './message-preview.html',
  imports: [MarkdownSummary, RouterLink, TranslocoPipe],
  host: {
    '[class.action]':
      'message().isDeleted || message().messageType === MessageType.placeholder || message().messageType === MessageType.system || message().messageType === MessageType.invite || !message().message?.trim()',
  },
  styles: `
    :host(.action) {
      color: var(--message-action-color, inherit);
    }
    a {
      color: var(--ion-color-primary);
      text-decoration: none;
    }
  `,
})
export class MessagePreview {
  readonly message = input.required<PreviewSource>();
  readonly interactive = input(false);
  protected readonly MessageType = MessageType;
  protected readonly placeholderLabel = placeholderLabel;
  protected readonly systemMessage = computed(() => systemMessagePresentation(this.message()));
  protected readonly messageRoute = computed(() => {
    const { chatId, systemLinks } = this.message();
    return chatId != null && systemLinks?.messageId != null ? messageLink(chatId, systemLinks.messageId) : undefined;
  });
  protected readonly MediaKind = MediaKind;
  protected readonly media = computed(() => [
    ...new Set(
      this.message().attachments.map((attachment) => attachmentKind(this.message().messageType, attachment.kind)),
    ),
  ]);
}
