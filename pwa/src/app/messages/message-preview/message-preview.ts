import { Component, computed, input } from '@angular/core';
import { MessageType, type MessageResponse } from '../../../generated/models';
import { MediaKind, mediaKind } from '../message-attachments/media-kind';
import { MessageText } from '../message-text/message-text';

type PreviewSource = Pick<MessageResponse, 'message' | 'messageType'> &
  Partial<Pick<MessageResponse, 'isDeleted' | 'mentions' | 'sender'>> & {
    attachments: readonly { kind: string }[];
  };

// These phrases are protocol values, not display text. Member actions append the target's name.
enum SystemMessageKind {
  Joined = 'joined the chat',
  Left = 'left the chat',
  Added = 'added ',
  Removed = 'removed ',
  Pinned = 'pinned a message',
  Unpinned = 'unpinned a message',
  ThreadPinned = 'pinned a message in this thread',
  ThreadUnpinned = 'unpinned a message in this thread',
}

@Component({
  selector: 'app-message-preview',
  templateUrl: './message-preview.html',
  imports: [MessageText],
  host: {
    '[class.action]':
      'message().isDeleted || message().messageType === MessageType.system || message().messageType === MessageType.invite || !message().message?.trim()',
  },
  styles: ':host(.action) { color: var(--message-action-color, inherit); }',
})
export class MessagePreview {
  readonly message = input.required<PreviewSource>();
  protected readonly MessageType = MessageType;
  protected readonly SystemMessageKind = SystemMessageKind;
  protected readonly systemMessage = computed(() => {
    const text = this.message().message ?? '';
    for (const kind of Object.values(SystemMessageKind)) {
      const hasTarget = kind === SystemMessageKind.Added || kind === SystemMessageKind.Removed;
      if (hasTarget ? text.startsWith(kind) : text === kind)
        return { kind, target: hasTarget ? text.slice(kind.length) : undefined };
    }
    return undefined;
  });
  protected readonly MediaKind = MediaKind;
  protected readonly media = computed(() => mediaKind(this.message().attachments[0]?.kind));
}
