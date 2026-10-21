import { Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
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
  IonRange,
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
  moonOutline,
  personCircleOutline,
  personOutline,
  sunnyOutline,
} from 'ionicons/icons';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { ChatFontSize, chatFontSizes } from '../chat-font-size';
import { ColorMode } from '../color-mode';
import { Preferences } from '../preferences';

@Component({
  selector: 'app-general-settings',
  templateUrl: './general-settings.html',
  styleUrl: './general-settings.scss',
  imports: [
    ContentScrollbars,
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
    IonRange,
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
  protected readonly FontSize = ChatFontSize;
  protected readonly fontSizes = chatFontSizes;
  protected readonly avatarsIcon = personCircleOutline;
  protected readonly dmDetailsIcon = personOutline;
  protected readonly systemIcon = contrastOutline;
  protected readonly lightIcon = sunnyOutline;
  protected readonly darkIcon = moonOutline;
  protected readonly backIcon = chevronBackOutline;

  protected setFontSize(value: number | { lower: number; upper: number }) {
    if (typeof value === 'number') this.preferences.setChatFontSize(value);
  }

  protected setColorMode(value: ColorMode) {
    this.preferences.setColorMode(value);
  }
}
