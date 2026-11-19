import { Component } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { returnDownBackOutline, returnUpForwardOutline } from 'ionicons/icons';

@Component({
  selector: 'app-forward-target-icon',
  imports: [IonIcon],
  host: { class: 'forward-target-icon' },
  template: `
    <ion-icon [icon]="upper" />
    <ion-icon [icon]="lower" />
  `,
  styles: `
    :host {
      display: grid;
      place-items: center;
    }

    ion-icon {
      grid-area: 1 / 1;
    }

    ion-icon:first-child {
      transform: translateY(-12.5%);
    }

    ion-icon:last-child {
      transform: translateY(12.5%);
    }
  `,
})
export class ForwardTargetIcon {
  protected readonly upper = returnUpForwardOutline;
  protected readonly lower = returnDownBackOutline;
}
