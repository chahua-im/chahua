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
import { RouterLink } from '@angular/router';
import {
  IonAvatar,
  IonBadge,
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
  NavController,
  type SegmentCustomEvent,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { addCircleOutline, bookmarkOutline, chevronBack, downloadOutline, settingsOutline } from 'ionicons/icons';
import { VoiceBar } from '../../messages/voice-player/voice-bar';
import { AppInstall } from '../../pwa/app-install';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { AvatarColor, AvatarTextPipe } from '../avatar-text.pipe';
import { ChatListContent } from '../chat-list-content/chat-list-content';
import { ChatListStore } from '../chat-list-store';
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
  protected readonly tabBadges = computed(() => this.lists.tabBadges(this.preferences.showThreadsInMessages()));

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
  private readonly nav = inject(NavController);
  protected readonly backIcon = chevronBack;
  protected readonly addIcon = addCircleOutline;
  protected readonly installer = inject(AppInstall);
  protected readonly savedIcon = bookmarkOutline;
  protected readonly settingsIcon = settingsOutline;
  protected readonly installIcon = downloadOutline;

  protected back() {
    // The sidebar has no router outlet; returning there only changes its local selection.
    if (!this.outlet) {
      this.openList.emit({ tab: this.list().tab, archived: false, requestHistory: false });
    } else if (this.outlet.canGoBack()) this.nav.back();
    else void this.nav.navigateBack(['/chats', this.list().tab], { replaceUrl: true });
  }

  protected selectTab(event: SegmentCustomEvent) {
    const tab = event.detail.value;
    if (isListTab(tab) && tab !== this.list().tab) {
      this.openList.emit({ tab, archived: false, requestHistory: false });
    }
  }
}
