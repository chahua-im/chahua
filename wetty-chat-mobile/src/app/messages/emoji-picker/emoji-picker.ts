import { Component, CUSTOM_ELEMENTS_SCHEMA, output } from '@angular/core';
import 'emoji-picker-element';
import type { EmojiClickEvent } from 'emoji-picker-element/shared';

@Component({
  selector: 'app-emoji-picker',
  templateUrl: './emoji-picker.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  styles: `
    emoji-picker {
      width: 100%;
      height: min(400px, 65dvh);
      --background: var(--ion-background-color, #fff);
      --border-color: var(--ion-color-light-shade);
      --button-hover-background: var(--ion-color-light);
      --input-font-color: var(--ion-text-color);
      --input-border-color: var(--ion-color-medium);
      --input-placeholder-color: var(--ion-color-medium-shade);
      --indicator-color: var(--ion-color-primary);
    }
  `,
})
export class EmojiPicker {
  readonly chosen = output<string>();

  protected choose(event: Event) {
    const { unicode } = (event as EmojiClickEvent).detail;
    if (unicode) this.chosen.emit(unicode);
  }
}
