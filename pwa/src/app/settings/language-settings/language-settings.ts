import { Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonList,
  IonRadio,
  IonRadioGroup,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import type { RadioGroupCustomEvent } from '@ionic/core';
import { chevronBackOutline } from 'ionicons/icons';
import { Localization } from '../../i18n/localization';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { localeLabels, supportedLocales, type AppLocale } from '../locale';
import { Preferences } from '../preferences';

@Component({
  selector: 'app-language-settings',
  templateUrl: './language-settings.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    ContentScrollbars,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonList,
    IonRadio,
    IonRadioGroup,
    IonTitle,
    IonToolbar,
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
})
export class LanguageSettings {
  protected readonly preferences = inject(Preferences);
  private readonly localization = inject(Localization);
  protected readonly modals = inject(ModalController);
  protected readonly backIcon = chevronBackOutline;
  protected readonly locales = supportedLocales.map((locale) => ({ locale, label: localeLabels[locale] }));
  protected readonly current = computed(() => this.preferences.selectedLocale() ?? 'auto');

  protected async select(event: RadioGroupCustomEvent) {
    const value = event.detail.value as string;
    await this.localization.setLocale(value === 'auto' ? null : (value as AppLocale));
    void this.modals.dismiss();
  }
}
