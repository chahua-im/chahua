import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { femaleOutline, maleOutline } from 'ionicons/icons';
import type { User } from '../../../generated/models';

@Component({
  selector: 'app-message-author',
  templateUrl: './message-author.html',
  styleUrl: './message-author.scss',
  imports: [IonIcon],
  host: { '[class.own]': 'own()' },
})
export class MessageAuthor {
  readonly sender = input.required<User>();
  readonly own = input(false);
  protected readonly icons = { femaleOutline, maleOutline };
}
