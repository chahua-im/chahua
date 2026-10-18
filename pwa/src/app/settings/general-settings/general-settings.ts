import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { translateSignal, TranslocoPipe } from '@jsverse/transloco';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonTitle,
  IonToggle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import {
  chatbubblesOutline,
  chevronBackOutline,
  contrastOutline,
  languageOutline,
  moonOutline,
  personCircleOutline,
  personOutline,
  sunnyOutline,
} from 'ionicons/icons';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { ColorMode } from '../color-mode';
import { localeLabels } from '../locale';
import { Preferences } from '../preferences';

@Component({
  selector: 'app-general-settings',
  templateUrl: './general-settings.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    ContentScrollbars,
    RouterLink,
    TranslocoPipe,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    IonNote,
    IonRadio,
    IonRadioGroup,
    IonTitle,
    IonToggle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class GeneralSettings {
  protected readonly preferences = inject(Preferences);
  protected readonly modals = inject(ModalController);
  protected readonly ColorMode = ColorMode;
  protected readonly threadsIcon = chatbubblesOutline;
  protected readonly languageIcon = languageOutline;
  protected readonly avatarsIcon = personCircleOutline;
  protected readonly dmDetailsIcon = personOutline;
  protected readonly systemIcon = contrastOutline;
  protected readonly lightIcon = sunnyOutline;
  protected readonly darkIcon = moonOutline;
  protected readonly backIcon = chevronBackOutline;
  private readonly autoLabel = translateSignal('settings.language.auto');
  protected readonly localeLabel = computed(() => {
    const locale = this.preferences.selectedLocale();
    return locale ? localeLabels[locale] : this.autoLabel();
  });

  protected setColorMode(value: ColorMode) {
    this.preferences.setColorMode(value);
  }
}
