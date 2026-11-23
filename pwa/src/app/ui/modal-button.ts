import { booleanAttribute, Component, input, output } from '@angular/core';
import { IonButton, IonIcon } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { chevronBackOutline, closeOutline } from 'ionicons/icons';

@Component({
  selector: 'app-modal-button',
  imports: [IonButton, IonIcon, TranslocoPipe],
  template: `
    <ion-button
      fill="clear"
      [disabled]="disabled()"
      [title]="(back() ? 'common.back' : 'common.close') | transloco"
      (click)="pressed.emit()"
    >
      <ion-icon slot="icon-only" [icon]="back() ? backIcon : closeIcon" />
    </ion-button>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      width: 44px;
      height: 44px;
    }
    ion-button {
      width: 100%;
      height: 100%;
      margin: 0;
      --padding-start: 0;
      --padding-end: 0;
      --padding-top: 0;
      --padding-bottom: 0;
      --border-radius: 50%;
      --color: var(--modal-button-color, var(--ion-text-color-step-250, var(--ion-color-medium)));
      --color-hover: var(--modal-button-highlight, var(--ion-text-color));
      --color-activated: var(--modal-button-highlight, var(--ion-text-color));
      --background: var(--modal-button-background, transparent);
      --background-hover: var(--modal-button-highlight, var(--ion-text-color));
      --background-hover-opacity: 0.08;
      --background-activated: var(--modal-button-highlight, var(--ion-text-color));
      --background-activated-opacity: 0.14;
    }
    ion-icon {
      width: 22px;
      height: 22px;
    }
  `,
})
export class ModalButton {
  readonly back = input(false, { transform: booleanAttribute });
  readonly disabled = input(false);
  readonly pressed = output<void>();
  protected readonly backIcon = chevronBackOutline;
  protected readonly closeIcon = closeOutline;
}
