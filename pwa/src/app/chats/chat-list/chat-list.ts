import { Component, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonAvatar,
  IonBadge,
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
import { PushNotifications } from '../../pwa/push-notifications';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { ChatListStore } from '../chat-list-store';
import { Preferences } from '../../settings/preferences';
import { AvatarTextPipe } from '../avatar-text.pipe';
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
    AvatarTextPipe,
    ChatListContent,
    ContentScrollbars,
    DirectorySearch,
    IonAvatar,
    IonBadge,
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
  protected readonly lists = inject(ChatListStore);
  private readonly preferences = inject(Preferences);
  protected readonly messageUnread = computed(() => {
    const chats = this.lists.unread.value()?.unreadChatCount;
    const threads = this.preferences.showThreadsInMessages() ? this.lists.threadUnread.value()?.unreadThreadCount : 0;
    return chats == null || threads == null ? undefined : chats + threads;
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.active()) return;
      onCleanup(this.lists.unread.activate());
      onCleanup(this.lists.threadUnread.activate());
    });
  }

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
  private readonly notifications = inject(PushNotifications);
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
    this.notifications.requestSettingsPermission();
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
