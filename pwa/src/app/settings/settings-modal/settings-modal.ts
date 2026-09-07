import { Location } from '@angular/common';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { IonModal, IonNav } from '@ionic/angular';
import type { OverlayEventDetail } from '@ionic/core';
import { filter, map } from 'rxjs';
import { Settings, SettingsDismissRole } from '../settings/settings';

@Component({
  selector: 'app-settings-modal',
  imports: [IonModal, IonNav],
  template: `
    <ion-modal [isOpen]="open()" (didDismiss)="dismissed($event.detail)">
      <ng-template><ion-nav [root]="settingsPage"></ion-nav></ng-template>
    </ion-modal>
  `,
})
export class SettingsModal {
  protected readonly settingsPage = Settings;
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  protected readonly open = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.isOpen()),
    ),
    { initialValue: this.isOpen() },
  );

  private isOpen() {
    return this.router.parseUrl(this.router.url).queryParams['settings'] === '1';
  }

  protected dismissed({ role }: OverlayEventDetail) {
    // A browser Back has already left settings; do not go back twice.
    if (!this.isOpen()) return;
    if (role === SettingsDismissRole.Saved) {
      return this.router.navigateByUrl('/chats/saved', { replaceUrl: true });
    }
    if ((this.location.getState() as { settingsEntry?: boolean } | null)?.settingsEntry) {
      this.location.back();
      return;
    }
    // Direct links have no preceding in-app entry to return to.
    return this.router.navigateByUrl('/chats', { replaceUrl: true });
  }
}
