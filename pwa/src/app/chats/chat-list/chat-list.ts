import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
  IonSpinner,
  IonTitle,
  IonToolbar,
  type SegmentCustomEvent,
} from '@ionic/angular';
import { addCircleOutline } from 'ionicons/icons';
import { Connection } from '../../api/connection';
import { PushNotifications } from '../../pwa/push-notifications';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { ChatListStore } from '../chat-list-store';
import { Preferences } from '../../settings/preferences';
import { AvatarColor, AvatarTextPipe } from '../avatar-text.pipe';
import { ChatListContent } from '../chat-list-content/chat-list-content';
import { DirectorySearch } from '../directory-search/directory-search';
import { isListTab, ListTab, type ListSelection } from '../list-tabs';

@Component({
  selector: 'app-chat-list',
  templateUrl: './chat-list.html',
  styleUrl: './chat-list.scss',
  host: { class: 'ion-page' },
  imports: [
    RouterLink,
    AvatarTextPipe,
    AvatarColor,
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
  protected readonly tabs = Object.values(ListTab);
  private readonly panels = viewChildren<ElementRef<HTMLElement>>('panel');
  private previousTab?: ListTab;
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
    afterRenderEffect((onCleanup) => {
      const tab = this.list().tab;
      const panels = this.panels().map((panel) => panel.nativeElement);
      const previous = this.previousTab;
      this.previousTab = tab;
      const from = panels.find((panel) => panel.dataset['tab'] === previous);
      const to = panels.find((panel) => panel.dataset['tab'] === tab);
      if (!from || !to || tab === previous || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      from.hidden = false;
      const direction = this.tabs.indexOf(tab) > this.tabs.indexOf(previous!) ? 1 : -1;
      const options = { duration: 200, easing: 'ease-out' };
      const animations = [
        from.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-direction * 100}%)` }], options),
        to.animate([{ transform: `translateX(${direction * 100}%)` }, { transform: 'translateX(0)' }], options),
      ];
      animations[0].onfinish = () => (from.hidden = true);
      onCleanup(() => {
        animations.forEach((animation) => animation.cancel());
        from.hidden = from.dataset['tab'] !== this.list().tab;
      });
    });
  }

  protected readonly realtime = inject(Connection);
  protected readonly session = inject(SessionStore);
  protected readonly searching = signal(false);
  protected readonly search = signal('');
  protected readonly ListTab = ListTab;
  protected readonly outlet = inject(IonRouterOutlet, { optional: true });
  protected readonly addIcon = addCircleOutline;
  private readonly router = inject(Router);
  private readonly notifications = inject(PushNotifications);

  protected back() {
    // The sidebar has no router outlet; returning there only changes its local selection.
    if (!this.outlet) {
      this.openList.emit({ tab: this.list().tab, archived: false, requestHistory: false });
    }
  }

  protected openSettings() {
    this.notifications.requestSettingsPermission();
    return this.router.navigateByUrl('/settings');
  }

  protected selectTab(event: SegmentCustomEvent) {
    const tab = event.detail.value;
    if (isListTab(tab) && tab !== this.list().tab) {
      this.openList.emit({ tab, archived: false, requestHistory: false });
    }
  }
}
