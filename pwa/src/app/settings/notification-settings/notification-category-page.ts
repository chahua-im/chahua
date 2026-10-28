import { Component, inject, input } from '@angular/core';
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { chevronBackOutline } from 'ionicons/icons';
import { GroupKind } from '../../../generated/models';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { NotificationCategory } from './notification-category';

@Component({
  selector: 'app-notification-category-page',
  imports: [
    TranslocoPipe,
    ContentScrollbars,
    NotificationCategory,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonTitle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
  template: `
    <ion-header
      ><ion-toolbar>
        <ion-buttons slot="start"
          ><ion-button (click)="panels.back()"><ion-icon slot="icon-only" [icon]="backIcon" /></ion-button
        ></ion-buttons>
        <ion-title>{{
          (kind() === Kind.dm ? 'notificationPreferences.directTitle' : 'notificationPreferences.groupTitle')
            | transloco
        }}</ion-title>
      </ion-toolbar></ion-header
    >
    <ion-content appScrollbars color="light"><app-notification-category [kind]="kind()" /></ion-content>
  `,
})
export class NotificationCategoryPage {
  readonly kind = input.required<GroupKind>();
  protected readonly Kind = GroupKind;
  protected readonly panels = inject(PanelNavigation);
  protected readonly backIcon = chevronBackOutline;
}
