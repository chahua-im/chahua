import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { arrowRedoOutline } from 'ionicons/icons';

@Component({
  selector: 'app-forwarded-label',
  imports: [IonIcon, TranslocoPipe],
  template: `<ion-icon [icon]="icon" />{{
      'messages.forward.from' | transloco: { name: name() ?? ('messages.forward.unknown' | transloco) }
    }}`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      font-size: 0.85em;
      font-style: italic;
      font-weight: normal;
      color: var(--forward-muted, var(--ion-color-medium));
    }
    ion-icon {
      flex-shrink: 0;
    }
  `,
})
export class ForwardedLabel {
  readonly name = input<string>();
  protected readonly icon = arrowRedoOutline;
}
