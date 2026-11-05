import { booleanAttribute, Component, inject, input, signal } from '@angular/core';
import { IonButton, IonIcon, IonItem, IonLabel, ToastController } from '@ionic/angular';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { copyOutline } from 'ionicons/icons';
import { Diagnostics } from './diagnostics';

@Component({
  selector: 'app-diagnostics-copy',
  imports: [IonButton, IonIcon, IonItem, IonLabel, TranslocoPipe],
  template: `
    @if (row()) {
      <ion-item [button]="true" [detail]="false" [disabled]="pending()" lines="none" (click)="copy()">
        <ion-icon slot="start" [icon]="icon" color="primary" />
        <ion-label>{{ 'diagnostics.copy' | transloco }}</ion-label>
      </ion-item>
    } @else {
      <ion-button fill="clear" size="small" [disabled]="pending()" (click)="copy()">
        {{ 'diagnostics.copy' | transloco }}
      </ion-button>
    }
  `,
})
export class DiagnosticsCopy {
  private readonly diagnostics = inject(Diagnostics);
  private readonly toasts = inject(ToastController);
  private readonly i18n = inject(TranslocoService);
  readonly row = input(false, { transform: booleanAttribute });
  protected readonly pending = signal(false);
  protected readonly icon = copyOutline;

  constructor() {
    void this.diagnostics.captureWorker().catch(() => {});
  }

  protected async copy() {
    this.pending.set(true);
    let message: string;
    try {
      await this.diagnostics.copy();
      message = 'diagnostics.copied';
    } catch {
      message = 'diagnostics.copyFailed';
    } finally {
      this.pending.set(false);
    }
    const toast = await this.toasts.create({
      message: this.i18n.translate(message),
      duration: 3000,
      position: 'bottom',
    });
    await toast.present();
  }
}
