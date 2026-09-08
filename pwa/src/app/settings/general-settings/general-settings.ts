import { Component, inject } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonList,
  IonNavLink,
  IonTitle,
  IonToggle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { chatbubblesOutline, chevronBackOutline, personCircleOutline } from 'ionicons/icons';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { Preferences } from '../preferences';

@Component({
  selector: 'app-general-settings',
  templateUrl: './general-settings.html',
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
    IonNavLink,
    IonTitle,
    IonToggle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class GeneralSettings {
  protected readonly preferences = inject(Preferences);
  protected readonly modals = inject(ModalController);
  protected readonly threadsIcon = chatbubblesOutline;
  protected readonly avatarsIcon = personCircleOutline;
  protected readonly backIcon = chevronBackOutline;
}
