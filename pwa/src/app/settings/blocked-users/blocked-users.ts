import { Component, inject } from '@angular/core';
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
import { getBlocksResource } from '../../../generated/endpoints/blocks/blocks.resource';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';

@Component({
  selector: 'app-blocked-users',
  templateUrl: './blocked-users.html',
  imports: [
    ContentScrollbars,
    RouterLink,
    TranslocoPipe,
    LoadError,
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
    ChatAvatar,
  ],
  host: { class: 'ion-page' },
})
export class BlockedUsers {
  protected readonly panels = inject(PanelNavigation);
  protected readonly backIcon = chevronBackOutline;
  protected readonly blocks = getBlocksResource();
  panelResume() {
    this.blocks.reload();
  }
}
