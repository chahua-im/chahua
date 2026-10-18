import { Component, CUSTOM_ELEMENTS_SCHEMA, computed, inject, output } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import 'emoji-picker-element';
import type { EmojiClickEvent } from 'emoji-picker-element/shared';
import { Localization } from '../../i18n/localization';

@Component({
  selector: 'app-emoji-picker',
  templateUrl: './emoji-picker.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  styles: `
    emoji-picker {
      width: 100%;
      height: min(400px, 65dvh);
      --emoji-font-family: inherit;
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
  private readonly transloco = inject(TranslocoService);
  private readonly localization = inject(Localization);

  protected readonly pickerLocale = computed(() => (this.localization.locale() === 'en' ? 'en' : 'zh'));
  protected readonly dataSource = computed(() =>
    this.pickerLocale() === 'en' ? '/emoji/en/data.json' : '/emoji/data.json',
  );
  protected readonly i18n = computed(() => {
    this.localization.locale();
    const t = (key: string) => this.transloco.translate(key);
    return {
      emojiUnsupportedMessage: t('emojiPicker.unsupported'),
      loadingMessage: t('emojiPicker.loading'),
      networkErrorMessage: t('emojiPicker.networkError'),
      searchLabel: t('emojiPicker.search'),
      skinToneLabel: t('emojiPicker.skinTone'),
      skinTones: [
        t('emojiPicker.skinTones.default'),
        t('emojiPicker.skinTones.light'),
        t('emojiPicker.skinTones.mediumLight'),
        t('emojiPicker.skinTones.medium'),
        t('emojiPicker.skinTones.mediumDark'),
        t('emojiPicker.skinTones.dark'),
      ],
      categories: {
        custom: t('emojiPicker.categories.custom'),
        'smileys-emotion': t('emojiPicker.categories.smileys'),
        'people-body': t('emojiPicker.categories.people'),
        'animals-nature': t('emojiPicker.categories.animals'),
        'food-drink': t('emojiPicker.categories.food'),
        'travel-places': t('emojiPicker.categories.travel'),
        activities: t('emojiPicker.categories.activities'),
        objects: t('emojiPicker.categories.objects'),
        symbols: t('emojiPicker.categories.symbols'),
        flags: t('emojiPicker.categories.flags'),
      },
    };
  });

  protected choose(event: Event) {
    const { unicode } = (event as EmojiClickEvent).detail;
    if (unicode) this.chosen.emit(unicode);
  }
}
