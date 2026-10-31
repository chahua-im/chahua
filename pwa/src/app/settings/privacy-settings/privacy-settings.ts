import { Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
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
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { chevronBackOutline } from 'ionicons/icons';
import { RpcApi } from '../../../generated/rpc-api';
import { FriendAddVerificationMode, PresenceVisibility, ReadReceiptVisibility } from '../../../generated/models';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';

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
  protected readonly panels = inject(PanelNavigation);
  protected readonly backIcon = chevronBackOutline;
  private readonly api = inject(RpcApi);
  protected readonly blocks = rxResource({ stream: () => this.api.blocks.list() });
  protected readonly verification = rxResource({ stream: () => this.api.friends.getSettings() });
  protected readonly presence = rxResource({ stream: () => this.api.privacy.getPresenceSettings() });
  protected readonly readReceipts = rxResource({ stream: () => this.api.privacy.getReadReceiptSettings() });
  protected readonly ReceiptVisibility = ReadReceiptVisibility;
  protected readonly Mode = FriendAddVerificationMode;
  protected readonly Visibility = PresenceVisibility;
  panelResume() {
    this.blocks.reload();
    this.verification.reload();
    this.presence.reload();
    this.readReceipts.reload();
  }
}
