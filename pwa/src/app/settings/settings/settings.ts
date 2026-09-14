import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { RouterLink, Router } from '@angular/router';
import { afterRenderEffect, Component, inject, signal, viewChild } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
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
import {
  bookmarkOutline,
  notificationsOutline,
  refreshOutline,
  settingsOutline,
  shieldCheckmarkOutline,
} from 'ionicons/icons';
import { AppUpdates, UpdateCheckResult } from '../../pwa/app-updates';
import { PushNotificationError, PushNotifications } from '../../pwa/push-notifications';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';

@Component({
  selector: 'app-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  imports: [
    ChatAvatar,
    RouterLink,
    ContentScrollbars,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonTitle,
    IonToast,
    IonToggle,
    IonSpinner,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class Settings {
  private readonly modals = inject(ModalController);
  private readonly permissionToast = viewChild.required(IonToast);
  private readonly router = inject(Router);
  protected readonly session = inject(SessionStore);
  protected readonly notifications = inject(PushNotifications);
  protected readonly updates = inject(AppUpdates);
  protected readonly PushError = PushNotificationError;
  protected readonly UpdateResult = UpdateCheckResult;
  protected readonly updateResult = signal<UpdateCheckResult | undefined>(undefined);
  protected readonly bookmarkIcon = bookmarkOutline;
  protected readonly generalIcon = settingsOutline;
  protected readonly verificationIcon = shieldCheckmarkOutline;
  protected readonly notificationIcon = notificationsOutline;
  protected readonly updateIcon = refreshOutline;

  constructor() {
    void this.notifications.refresh();
    afterRenderEffect(() => {
      if (this.notifications.error() === PushNotificationError.PermissionDenied) void this.permissionToast().present();
    });
  }

  protected close() {
    return this.modals.dismiss();
  }

  protected openSaved() {
    return this.router.navigateByUrl('/chats/saved', { replaceUrl: true });
  }

  protected async setNotifications(event: ToggleCustomEvent) {
    await this.notifications.setEnabled(event.detail.checked);
    event.target.checked = this.notifications.enabled();
  }

  protected async checkUpdates() {
    this.updateResult.set(undefined);
    this.updateResult.set(await this.updates.check());
  }
}
