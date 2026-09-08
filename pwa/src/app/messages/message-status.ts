import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { checkmarkCircle, checkmarkCircleOutline } from 'ionicons/icons';

export enum MessageDelivery {
  Sending,
  Sent,
  Failed,
}

@Component({
  selector: 'app-message-status',
  imports: [IonIcon],
  template: `
    @switch (delivery()) {
      @case (Delivery.Sending) {
        <ion-icon [icon]="icons.checkmarkCircleOutline" />
      }
      @case (Delivery.Sent) {
        <ion-icon [icon]="icons.checkmarkCircle" />
      }
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      vertical-align: middle;
    }
    :host:empty {
      display: none;
    }
    ion-icon {
      font-size: 14px;
    }
  `,
})
export class MessageStatus {
  readonly delivery = input<MessageDelivery>();
  protected readonly Delivery = MessageDelivery;
  protected readonly icons = { checkmarkCircle, checkmarkCircleOutline };
}
