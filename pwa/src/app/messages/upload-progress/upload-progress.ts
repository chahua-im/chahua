import { Component, input } from '@angular/core';

@Component({
  selector: 'app-upload-progress',
  template: `
    <svg viewBox="0 0 32 32">
      <circle class="track" cx="16" cy="16" r="13" />
      <circle
        class="progress"
        cx="16"
        cy="16"
        r="13"
        pathLength="100"
        stroke-dasharray="100"
        [attr.stroke-dashoffset]="100 * (1 - value())"
      />
    </svg>
  `,
  styles: `
    :host {
      display: block;
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
  `,
})
export class UploadProgress {
  readonly value = input.required<number>();
}
