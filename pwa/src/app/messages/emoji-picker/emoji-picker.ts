import {
  afterNextRender,
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  EmojiDataService,
  EmojiFlagCacheService,
  EmojiPickerComponent,
  EmojiSearchService,
} from '@nicematic/emoji-picker';
import { Localization } from '../../i18n/localization';
import { PickerData, PickerSearch } from './picker-data';
import { PickerFlags } from './picker-flags';

@Component({
  selector: 'app-emoji-picker',
  templateUrl: './emoji-picker.html',
  imports: [EmojiPickerComponent],
  providers: [
    { provide: EmojiDataService, useFactory: () => new PickerData() },
    { provide: EmojiSearchService, useFactory: () => new PickerSearch() },
    { provide: EmojiFlagCacheService, useFactory: () => new PickerFlags() },
  ],
  styles: `
    :host {
      display: block;
      height: min(400px, 65dvh);
    }
    nicematic-picker {
      --nicematic-picker-bg: var(--ion-background-color, var(--ion-color-dark-contrast));
      --nicematic-picker-nav-bg: var(--ion-color-light);
      --nicematic-picker-text: var(--ion-text-color, var(--ion-color-dark));
      --nicematic-picker-text-muted: var(--ion-color-medium-shade);
      --nicematic-picker-border: var(--ion-color-light-shade);
      --nicematic-picker-hover: var(--ion-color-light);
      --nicematic-picker-input-bg: var(--ion-background-color, var(--ion-color-dark-contrast));
      --nicematic-picker-input-border: var(--ion-color-medium);
      --nicematic-picker-accent: var(--ion-color-primary);
      --nicematic-picker-radius: 0;
    }
  `,
})
export class EmojiPicker {
  readonly chosen = output<string>();
  private readonly localization = inject(Localization);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly picker = viewChild(EmojiPickerComponent);
  protected readonly pickerLocale = computed(() => (this.localization.locale() === 'en' ? 'en' : 'zh'));
  protected readonly height = signal(400);

  constructor() {
    afterRenderEffect(() => {
      if (!this.picker()?.grid?.skinToneEmoji()) return;
      // The library positions this element in viewport coordinates. The top layer
      // keeps those coordinates valid inside transformed/clipped Ionic overlays.
      const popover = this.element.nativeElement.querySelector<HTMLElement>('nicematic-skin-tone-popover > div')!;
      popover.setAttribute('popover', 'manual');
      popover.style.margin = '0';
      popover.showPopover();
    });
    afterNextRender(() => {
      const observer = new ResizeObserver(([entry]) => this.height.set(entry.contentRect.height));
      observer.observe(this.element.nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
