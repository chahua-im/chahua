import { Component, input, output } from '@angular/core';
import { IonButton, IonIcon } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { arrowDownOutline, arrowUpOutline } from 'ionicons/icons';
import { PageDirection } from '../conversation-store';

@Component({
  selector: 'app-selection-range-button',
  imports: [IonButton, IonIcon, TranslocoPipe],
  styleUrl: './selection-range-button.scss',
  host: {
    '[class.ion-display-none]': '!range()',
    '[class.selection-range-top]': 'range()?.direction === PageDirection.Older',
    '[class.selection-range-bottom]': 'range()?.direction === PageDirection.Newer',
  },
  template: `
    @let target = range();
    <ion-button size="small" [disabled]="target?.overLimit ?? false" (click)="target && extend.emit(target.direction)">
      <ion-icon slot="start" [icon]="target?.direction === PageDirection.Older ? arrowDown : arrowUp" />
      @if (target) {
        {{
          (target.overLimit ? 'messages.selection.remaining' : 'messages.selection.extend')
            | transloco: { count: target.overLimit ? target.remaining : target.count }
        }}
      }
    </ion-button>
  `,
})
export class SelectionRangeButton {
  readonly range = input<{ direction: PageDirection; count: number; remaining: number; overLimit: boolean }>();
  readonly extend = output<PageDirection>();
  protected readonly PageDirection = PageDirection;
  protected readonly arrowDown = arrowDownOutline;
  protected readonly arrowUp = arrowUpOutline;
}
