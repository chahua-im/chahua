import { Component, inject, input, output, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonAvatar,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover,
  IonRouterOutlet,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSegmentContent,
  IonSegmentView,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
  type SegmentCustomEvent,
} from '@ionic/angular';
import { addCircleOutline } from 'ionicons/icons';
import { Connection } from '../../api/connection';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { ChatListContent } from '../chat-list-content/chat-list-content';
import { DirectorySearch } from '../directory-search/directory-search';
import { isListTab, ListTab, type ListSelection } from '../list-tabs';
import { StartChat, StartChatKind } from '../start-chat/start-chat';

let nextContentId = 0;

@Component({
  selector: 'app-chat-list',
  templateUrl: './chat-list.html',
  styleUrl: './chat-list.scss',
  host: { class: 'ion-page' },
  imports: [
    ChatListContent,
    ContentScrollbars,
    DirectorySearch,
    IonAvatar,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonPopover,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonSegmentContent,
    IonSegmentView,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class ChatList {
  readonly selection = input.required<ListSelection>();
  readonly active = input(true);
  readonly openList = output<ListSelection>();
  protected readonly list = this.selection;
  // Ionic resolves segment content IDs across the document, including cached pages and the sidebar.
  protected readonly contentPrefix = `chat-list-${nextContentId++}-`;
  protected readonly realtime = inject(Connection);
  protected readonly session = inject(SessionStore);
  protected readonly searching = signal(false);
  protected readonly search = signal('');
  protected readonly ListTab = ListTab;
  protected readonly StartKind = StartChatKind;
  protected readonly outlet = inject(IonRouterOutlet, { optional: true });
  protected readonly addIcon = addCircleOutline;
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly addMenu = viewChild<IonPopover>('addMenu');

  protected back() {
    // The sidebar has no router outlet; returning there only changes its local selection.
    if (!this.outlet) {
      this.openList.emit({ tab: this.list().tab, archived: false, requestHistory: false });
    }
  }

  protected async start(kind: StartChatKind) {
    await this.addMenu()?.dismiss();
    const modal = await this.modals.create({ component: StartChat, componentProps: { kind } });
    await modal.present();
  }

  protected openSettings() {
    const url = this.router.parseUrl(this.router.url);
    url.queryParams['settings'] = '1';
    return this.router.navigateByUrl(url, { browserUrl: '/settings', state: { settingsEntry: true } });
  }

  protected selectTab(event: SegmentCustomEvent) {
    const tab = event.detail.value;
    if (isListTab(tab) && tab !== this.list().tab) {
      this.openList.emit({ tab, archived: false, requestHistory: false });
    }
  }
}
