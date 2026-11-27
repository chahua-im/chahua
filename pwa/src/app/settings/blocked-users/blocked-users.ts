import { ModalButton } from '../../ui/modal-button';
import { Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { RpcApi } from '../../../generated/rpc-api';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';

@Component({
  selector: 'app-blocked-users',
  templateUrl: './blocked-users.html',
  imports: [
    ModalButton,
    ContentScrollbars,
    RouterLink,
    TranslocoPipe,
    LoadError,
    IonButtons,
    IonContent,
    IonHeader,
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
  private readonly api = inject(RpcApi);
  protected readonly blocks = rxResource({ stream: () => this.api.blocks.list() });
  panelResume() {
    this.blocks.reload();
  }
}
