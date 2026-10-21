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
import { LoadError } from '../../ui/load-error/load-error';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';

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
  protected readonly modals = inject(ModalController);
  protected readonly backIcon = chevronBackOutline;
  protected readonly blocks = getBlocksResource();
}
