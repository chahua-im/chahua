import { Component, input } from '@angular/core';

@Component({
  selector: 'app-message-selection-mark',
  template: `
    @if (selected()) {
      <svg viewBox="0 0 16 16">
        <path
          d="M3 7.5 6.5 11 13 4.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="square"
          stroke-linejoin="miter"
        />
      </svg>
    }
  `,
  styles: `
    :host {
      display: grid;
      place-items: center;
      position: absolute;
      inset-inline-start: 5px;
      top: 50%;
      translate: 0 -50%;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 1px solid var(--ion-color-medium);
      color: var(--ion-color-primary-contrast);

      svg {
        display: block;
        width: 14px;
        height: 14px;
      }
    }
    :host(.selected) {
      background: var(--ion-color-primary);
      border-color: var(--ion-color-primary);
    }
  `,
  host: { class: 'selection-mark', '[class.selected]': 'selected()' },
})
export class MessageSelectionMark {
  readonly selected = input(false);
}
