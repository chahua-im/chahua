import { Component, input, model } from '@angular/core';
import { IonSelect, IonSelectOption } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { SpeakingMode } from '../../generated/models';

@Component({
  selector: 'app-speaking-mode-select',
  imports: [IonSelect, IonSelectOption, TranslocoPipe],
  template: `
    <ion-select
      [label]="label()"
      labelPlacement="stacked"
      interface="alert"
      [cancelText]="'common.cancel' | transloco"
      [okText]="'common.confirm' | transloco"
      [value]="value()"
      [disabled]="disabled()"
      (ionChange)="value.set($event.detail.value)"
    >
      <ion-select-option [value]="Mode.unrestricted">{{ 'speaking.modes.unrestricted' | transloco }}</ion-select-option>
      <ion-select-option [value]="Mode.threadsOnly">{{ 'speaking.modes.threadsOnly' | transloco }}</ion-select-option>
      <ion-select-option [value]="Mode.repliesOnly">{{ 'speaking.modes.repliesOnly' | transloco }}</ion-select-option>
      <ion-select-option [value]="Mode.readOnly">{{ 'speaking.modes.readOnly' | transloco }}</ion-select-option>
    </ion-select>
  `,
  styles: ':host { display: block; width: 100%; }',
})
export class SpeakingModeSelect {
  readonly value = model<SpeakingMode>();
  readonly label = input.required<string>();
  readonly disabled = input(false);
  protected readonly Mode = SpeakingMode;
}
