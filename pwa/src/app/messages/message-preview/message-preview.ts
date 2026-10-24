import { Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouterLink } from '@angular/router';
import { MessageType, type MessageResponse } from '../../../generated/models';
import { MediaKind, attachmentKind } from '../message-attachments/media-kind';
import { messageLink } from '../message-link';
import { placeholderLabel } from '../forward-placeholder';
import { MarkdownSummary } from './markdown-summary';

type PreviewSource = Pick<MessageResponse, 'message' | 'messageType'> &
  Partial<Pick<MessageResponse, 'isDeleted' | 'mentions' | 'sender' | 'systemLinks' | 'chatId'>> & {
    attachments: readonly { kind: string }[];
  };

enum SystemMessageKind {
  Joined = 'joined',
  Left = 'left',
  Added = 'added',
  Removed = 'removed',
  Pinned = 'pinned',
  Unpinned = 'unpinned',
  ThreadPinned = 'threadPinned',
  ThreadUnpinned = 'threadUnpinned',
  Accepted = 'accepted',
}

// Backend protocol text, including legacy messages without link destinations.
const systemPhrases = new Map([
  ['joined the chat', SystemMessageKind.Joined],
  ['left the chat', SystemMessageKind.Left],
  ['pinned a message', SystemMessageKind.Pinned],
  ['unpinned a message', SystemMessageKind.Unpinned],
  ['pinned a message in this thread', SystemMessageKind.ThreadPinned],
  ['unpinned a message in this thread', SystemMessageKind.ThreadUnpinned],
]);

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
  protected readonly systemMessage = computed(() => {
    const text = this.message().message ?? '';
    const kind = systemPhrases.get(text);
    if (kind) return { kind, target: undefined };
    for (const kind of [SystemMessageKind.Added, SystemMessageKind.Removed]) {
      const prefix = kind + ' ';
      if (text.startsWith(prefix)) return { kind, target: text.slice(prefix.length) };
    }
    const accepted = /^accepted ([\s\S]+)'s friend request$/.exec(text);
    return accepted ? { kind: SystemMessageKind.Accepted, target: accepted[1] } : undefined;
  });
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
