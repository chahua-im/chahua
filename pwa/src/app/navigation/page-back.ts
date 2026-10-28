import { Component, inject, input } from '@angular/core';
import { IonButton, IonIcon, IonRouterOutlet, NavController } from '@ionic/angular';
import { chevronBack } from 'ionicons/icons';

/** Match browser Back instead of pushing the previous Ionic page URL into history again. */
@Component({
  selector: 'app-page-back',
  imports: [IonButton, IonIcon],
  host: { style: 'display: contents' },
  template: `<ion-button (click)="back()"><ion-icon slot="icon-only" [icon]="icon" /></ion-button>`,
})
export class PageBack {
  readonly fallback = input.required<string>();
  private readonly outlet = inject(IonRouterOutlet, { optional: true });
  private readonly nav = inject(NavController);
  protected readonly icon = chevronBack;
  protected back() {
    if (this.outlet?.canGoBack()) this.nav.back();
    else void this.nav.navigateBack(this.fallback(), { replaceUrl: true });
  }
}
