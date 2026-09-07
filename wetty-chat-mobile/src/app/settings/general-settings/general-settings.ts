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
import { chevronBackOutline, chatbubblesOutline, personCircleOutline } from 'ionicons/icons';
import { Preferences } from '../preferences';

@Component({
  selector: 'app-general-settings',
  templateUrl: './general-settings.html',
  styleUrl: '../settings/settings.scss',
  imports: [
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
  protected readonly modal = inject(ModalController);
  protected readonly threadsIcon = chatbubblesOutline;
  protected readonly avatarsIcon = personCircleOutline;
  protected readonly backIcon = chevronBackOutline;
}
