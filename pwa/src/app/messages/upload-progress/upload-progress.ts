import { Component, input } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular';
import { cloudUploadOutline, filmOutline } from 'ionicons/icons';

@Component({
  selector: 'app-upload-progress',
  imports: [IonIcon, IonSpinner],
  template: `
    @let progress = value();
    @if (progress != null) {
      <svg viewBox="0 0 32 32">
        <circle class="track" cx="16" cy="16" r="13" />
        <circle
          class="progress"
          cx="16"
          cy="16"
          r="13"
          pathLength="100"
          stroke-dasharray="100"
          [attr.stroke-dashoffset]="100 * (1 - progress)"
        />
      </svg>
    }
    @if (progress == null || progress === 1) {
      <ion-spinner name="circular" [class.inner]="progress === 1" />
    }
    @if (progress != null && progress < 1) {
      <ion-icon [icon]="processing() ? icons.filmOutline : icons.cloudUploadOutline" />
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      flex-shrink: 0;
      width: 28px;
      height: 28px;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.5;
      transform: rotate(-90deg);
    }
    .track {
      opacity: 0.25;
    }
    .progress {
      stroke-linecap: round;
      transition: stroke-dashoffset 120ms linear;
    }
    ion-spinner {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      color: inherit;
    }
    ion-spinner.inner,
    ion-icon {
      position: absolute;
      inset: 7px;
      width: 14px;
      height: 14px;
    }
  `,
})
export class UploadProgress {
  readonly value = input<number>();
  readonly processing = input(false);
  protected readonly icons = { filmOutline, cloudUploadOutline };
}
