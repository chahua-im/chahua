import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
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
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { chevronBackOutline } from 'ionicons/icons';
import { getBlocksResource } from '../../../generated/endpoints/blocks/blocks.resource';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';

import {
  getMyFriendSettingsResource,
  getMyPresenceSettingsResource,
  getMyReadReceiptSettingsResource,
} from '../../../generated/endpoints/friends/friends.resource';
import { FriendAddVerificationMode, PresenceVisibility, ReadReceiptVisibility } from '../../../generated/models';

@Component({
  selector: 'app-privacy-settings',
  templateUrl: './privacy-settings.html',
  styleUrl: './privacy-settings.scss',
  imports: [
    ContentScrollbars,
    RouterLink,
    TranslocoPipe,
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
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class PrivacySettings {
  protected readonly modals = inject(ModalController);
  protected readonly backIcon = chevronBackOutline;
  protected readonly blocks = getBlocksResource();
  protected readonly verification = getMyFriendSettingsResource();
  protected readonly presence = getMyPresenceSettingsResource();
  protected readonly readReceipts = getMyReadReceiptSettingsResource();
  protected readonly ReceiptVisibility = ReadReceiptVisibility;
  protected readonly Mode = FriendAddVerificationMode;
  protected readonly Visibility = PresenceVisibility;
}
