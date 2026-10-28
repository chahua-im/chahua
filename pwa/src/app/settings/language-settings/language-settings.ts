import { Component, computed, inject, signal, viewChild } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonList,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import type { RadioGroupCustomEvent } from '@ionic/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { chevronBackOutline } from 'ionicons/icons';
import { Localization } from '../../i18n/localization';
import { PanelNavigation } from '../../navigation/panel-navigation';
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
    IonNote,
    IonSpinner,
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
  protected readonly panels = inject(PanelNavigation);
  protected readonly backIcon = chevronBackOutline;
  protected readonly locales = supportedLocales.map((locale) => ({ locale, label: localeLabels[locale] }));
  protected readonly saving = signal(false);
  protected readonly failed = signal(false);
  private readonly radios = viewChild(IonRadioGroup);
  private requested: AppLocale | null = null;
  protected readonly current = computed(() => this.preferences.selectedLocale() ?? 'auto');

  protected async select(event: RadioGroupCustomEvent) {
    if (this.saving()) return;
    const value = event.detail.value as string;
    this.requested = value === 'auto' ? null : (value as AppLocale);
    await this.save();
  }

  protected async save() {
    if (this.saving()) return;
    this.saving.set(true);
    this.failed.set(false);
    try {
      await this.localization.setLocale(this.requested);
    } catch {
      this.failed.set(true);
    } finally {
      this.saving.set(false);
      const radios = this.radios();
      if (radios) radios.value = this.current();
    }
  }
}
