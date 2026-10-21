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
import { TranslocoPipe } from '@jsverse/transloco';
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
  IonTitle,
  IonToolbar,
  type SegmentCustomEvent,
} from '@ionic/angular';
import { addCircleOutline } from 'ionicons/icons';
import { PushNotifications } from '../../pwa/push-notifications';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { VoiceBar } from '../../messages/voice-player/voice-bar';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { conversationView } from '../conversation-views';
import { ChatListStore } from '../chat-list-store';
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
    VoiceBar,
    IonSegment,
    IonSegmentButton,
    IonTitle,
    IonToolbar,
    TranslocoPipe,
  ],
})
export class ChatList {
  readonly selection = input.required<ListSelection>();
  readonly active = input(true);
  /** The desktop split-pane sidebar instance; its voice bar lives in the main column instead. */
  readonly sidebar = input(false);
  readonly openList = output<ListSelection>();
  protected readonly list = this.selection;
  protected readonly tabs = Object.values(ListTab);
  private readonly panels = viewChildren<ElementRef<HTMLElement>>('panel');
  private previousTab?: ListTab;
  protected readonly lists = inject(ChatListStore);
  private readonly preferences = inject(Preferences);
  private summary(tab: ListTab) {
    return this.lists.summary(conversationView({ ...this.list(), tab }, this.preferences.showThreadsInMessages()));
  }
  protected readonly messageUnread = computed(() => this.summary(ListTab.Messages)?.unreadUnmutedConversationCount);
  protected readonly groupUnread = computed(() => this.summary(ListTab.Groups)?.unreadUnmutedConversationCount);
  protected readonly friendUnread = computed(() => this.summary(ListTab.Friends)?.unreadUnmutedConversationCount);
  protected readonly threadUnread = computed(() => this.summary(ListTab.Threads)?.unreadUnmutedConversationCount);
  protected readonly tabMentions = computed(() => ({
    messages: !!this.summary(ListTab.Messages)?.unreadUnmutedAttentionCount,
    groups: !!this.summary(ListTab.Groups)?.unreadUnmutedAttentionCount,
    friends: !!this.summary(ListTab.Friends)?.unreadUnmutedAttentionCount,
    threads: !!this.summary(ListTab.Threads)?.unreadUnmutedAttentionCount,
  }));

  constructor() {
    effect((onCleanup) => {
      if (!this.active()) return;
      onCleanup(this.lists.viewUnread.activate());
    });
    effect(() => {
      if (this.active()) this.lists.selection.set(this.list());
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

  protected readonly session = inject(SessionStore);
  protected readonly canCreateGroup = computed(() => {
    const permissions = this.session.user()?.permissions;
    return !!permissions && (permissions.includes('permission.all') || permissions.includes('chat.create'));
  });
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
