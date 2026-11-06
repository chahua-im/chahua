import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import type { ReactionSummary } from '../../../generated/models';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';

@Component({
  selector: 'app-message-reactions',
  imports: [ChatAvatar, NgTemplateOutlet],
  templateUrl: './message-reactions.html',
  styleUrl: './message-reactions.scss',
  host: {
    class: 'reactions',
    '[class.own]': 'own()',
  },
})
export class MessageReactions {
  readonly reactions = input.required<ReactionSummary[]>();
  readonly own = input(false);
  readonly preview = input(false);
  readonly react = output<string>();
}
