import { ModalButton } from '../../ui/modal-button';
import { Component, inject, input } from '@angular/core';
import { IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { GroupKind } from '../../../generated/models';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { NotificationCategory } from './notification-category';

@Component({
  selector: 'app-notification-category-page',
  imports: [
    ModalButton,
    TranslocoPipe,
    ContentScrollbars,
    NotificationCategory,
    IonButtons,
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <app-modal-button back (pressed)="panels.back()" />
        </ion-buttons>
        <ion-title>{{
          (kind() === Kind.dm ? 'notificationPreferences.directTitle' : 'notificationPreferences.groupTitle')
            | transloco
        }}</ion-title>
        <ion-buttons slot="end">
          <app-modal-button (pressed)="panels.close()" />
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content appScrollbars color="light"><app-notification-category [kind]="kind()" /></ion-content>
  `,
})
export class NotificationCategoryPage {
  readonly kind = input.required<GroupKind>();
  protected readonly Kind = GroupKind;
  protected readonly panels = inject(PanelNavigation);
}
