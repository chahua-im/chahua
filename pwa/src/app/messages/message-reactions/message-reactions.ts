import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import type { ReactionSummary } from '../../../generated/models';
import { AvatarTextPipe } from '../../chats/avatar-text.pipe';

@Component({
  selector: 'app-message-reactions',
  imports: [AvatarTextPipe, NgTemplateOutlet],
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
