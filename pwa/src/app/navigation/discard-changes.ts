import { inject, Service } from '@angular/core';
import { AlertController } from '@ionic/angular';
import { TranslocoService } from '@jsverse/transloco';

export enum DiscardReason {
  Changes = 'changes',
  Attachments = 'attachments',
  Recording = 'recording',
}

@Service()
export class DiscardChanges {
  private readonly alerts = inject(AlertController);
  private readonly transloco = inject(TranslocoService);

  async confirm(reason = DiscardReason.Changes) {
    const alert = await this.alerts.create({
      header: this.transloco.translate(`common.discard.${reason}`),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('common.discard.confirm'), role: 'destructive' },
      ],
    });
    await alert.present();
    return (await alert.onDidDismiss()).role === 'destructive';
  }
}
