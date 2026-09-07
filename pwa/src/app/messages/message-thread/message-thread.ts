import { Component, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { chatbubbles, chevronForward } from 'ionicons/icons';
import type { ThreadInfo } from '../../../generated/models';

@Component({
  selector: 'app-message-thread',
  templateUrl: './message-thread.html',
  styleUrl: './message-thread.scss',
  imports: [IonIcon],
})
export class MessageThread {
  readonly info = input.required<ThreadInfo>();
  readonly preview = input(false);
  readonly open = output<void>();
  protected readonly icons = { chatbubbles, chevronForward };
}
