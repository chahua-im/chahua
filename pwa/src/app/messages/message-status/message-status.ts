import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { checkmarkDoneOutline, checkmarkOutline, cloudUploadOutline, timeOutline } from 'ionicons/icons';

import { MessageDelivery } from '../message-delivery';

@Component({
  selector: 'app-message-status',
  imports: [IonIcon],
  template: `
    @switch (delivery()) {
      @case (Delivery.Uploading) {
        <ion-icon [icon]="icons.cloudUploadOutline" />
      }
      @case (Delivery.Sending) {
        <ion-icon [icon]="icons.timeOutline" />
      }
      @case (Delivery.Sent) {
        <ion-icon [icon]="read() ? icons.checkmarkDoneOutline : icons.checkmarkOutline" />
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
      font-size: 13px;
    }
  `,
})
export class MessageStatus {
  readonly delivery = input<MessageDelivery>();
  readonly read = input(false);
  protected readonly Delivery = MessageDelivery;
  protected readonly icons = {
    cloudUploadOutline,
    timeOutline,
    checkmarkOutline,
    checkmarkDoneOutline,
  };
}
