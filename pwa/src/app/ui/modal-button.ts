import { booleanAttribute, Component, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { chevronBackOutline, closeOutline } from 'ionicons/icons';

@Component({
  selector: 'app-modal-button',
  imports: [IonIcon, TranslocoPipe],
  template: `
    <button
      type="button"
      [disabled]="disabled()"
      [title]="(back() ? 'common.back' : 'common.close') | transloco"
      (click)="pressed.emit()"
    >
      <ion-icon [icon]="back() ? backIcon : closeIcon" />
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      width: 44px;
      height: 44px;
    }
    button {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      color: var(--modal-button-color, var(--ion-text-color-step-250, var(--ion-color-medium)));
      background: var(--modal-button-background, transparent);
    }
    button:disabled {
      cursor: default;
      opacity: 0.5;
    }
    @media (hover: hover) {
      button:enabled:hover {
        color: var(--modal-button-highlight, var(--ion-text-color));
        box-shadow: inset 0 0 0 22px color-mix(in srgb, currentColor 8%, transparent);
      }
    }
    button:enabled:active {
      color: var(--modal-button-highlight, var(--ion-text-color));
      box-shadow: inset 0 0 0 22px color-mix(in srgb, currentColor 14%, transparent);
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
