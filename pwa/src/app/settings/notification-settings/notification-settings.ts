import { afterRenderEffect, Component, DestroyRef, inject, viewChild } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonList,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToggle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import type { ToggleCustomEvent } from '@ionic/core';
import { chevronBackOutline, notificationsOutline, refreshOutline } from 'ionicons/icons';
import { PushNotificationError, PushNotifications } from '../../pwa/push-notifications';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';

@Component({
  selector: 'app-notification-settings',
  templateUrl: './notification-settings.html',
  imports: [
    ContentScrollbars,
    TranslocoPipe,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonList,
    IonNote,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToggle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class NotificationSettings {
  protected readonly modals = inject(ModalController);
  protected readonly notifications = inject(PushNotifications);
  protected readonly PushError = PushNotificationError;
  protected readonly backIcon = chevronBackOutline;
  protected readonly updateIcon = refreshOutline;
  protected readonly notificationIcon = notificationsOutline;
  private readonly permissionToast = viewChild.required(IonToast);

  constructor() {
    const refresh = () => {
      if (!document.hidden) void this.notifications.refresh();
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    });
    afterRenderEffect(() => {
      if (this.notifications.error() === PushNotificationError.PermissionDenied) void this.permissionToast().present();
    });
  }

  protected retry() {
    return this.notifications.setEnabled(this.notifications.enabled());
  }

  protected async setNotifications(event: ToggleCustomEvent) {
    await this.notifications.setEnabled(event.detail.checked);
    event.target.checked = this.notifications.enabled();
  }
}
