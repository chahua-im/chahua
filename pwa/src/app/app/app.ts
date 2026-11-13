import { NgOptimizedImage } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  inject,
  isDevMode,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import {
  IonApp,
  IonButton,
  IonContent,
  IonMenu,
  NavController,
  IonRouterOutlet,
  IonSpinner,
  IonSplitPane,
  IonToast,
  iosTransitionAnimation,
  isPlatform,
} from '@ionic/angular';
import { translateSignal, TranslocoPipe } from '@jsverse/transloco';
import { filter, map, TimeoutError } from 'rxjs';
import { ChatLink } from '../chats/chat-link/chat-link';
import { ChatList } from '../chats/chat-list/chat-list';
import { listSelection, ListTab, type ListSelection } from '../chats/list-tabs';
import { PanelNavigation } from '../navigation/panel-navigation';
import { AppUpdates } from '../pwa/app-updates';
import { NotificationPrompt } from '../pwa/notification-prompt/notification-prompt';
import { PushNotifications } from '../pwa/push-notifications';
import { ContentScrollbars } from '../scrolling/content-scrollbars';
import { SessionStore } from '../session/session-store';
import { RpcError, RpcErrorCode, RpcTransportError } from '../api/rpc-error';
import { EscapePriority, registerEscape } from '../navigation/escape-navigation';

enum EntryState {
  Loading = 'loading',
  Slow = 'slow',
  Missing = 'missing',
  Expired = 'expired',
  Network = 'network',
  Server = 'server',
  Failed = 'failed',
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: {
    '(window:popstate)': 'browserTransition.set($event.hasUAVisualTransition)',
  },
  imports: [
    NgOptimizedImage,
    ContentScrollbars,
    IonApp,
    IonButton,
    IonContent,
    IonMenu,
    IonRouterOutlet,
    IonSpinner,
    IonSplitPane,
    IonToast,
    ChatList,
    ChatLink,
    NotificationPrompt,
    TranslocoPipe,
  ],
})
export class App {
  private readonly router = inject(Router);
  private readonly nav = inject(NavController);
  private readonly panels = inject(PanelNavigation);
  private readonly notifications = inject(PushNotifications);
  protected readonly landingPage = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => /^\/landing(?:[?/#]|$)/.test(this.router.url)),
    ),
    { initialValue: /^\/landing(?:[?/#]|$)/.test(location.pathname) },
  );
  private readonly routeSelection = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => listSelection(this.router.routerState.snapshot.root)),
    ),
    {
      initialValue: listSelection(this.router.routerState.snapshot.root),
      equal: (a, b) => a?.tab === b?.tab && a?.archived === b?.archived && a?.requestHistory === b?.requestHistory,
    },
  );
  protected readonly sidebarSelection = linkedSignal({
    source: this.routeSelection,
    computation: (selection, previous): ListSelection =>
      selection ?? previous?.value ?? { tab: ListTab.Messages, archived: false, requestHistory: false },
  });
  protected readonly browserTransition = signal(false);
  protected readonly session = inject(SessionStore);
  protected readonly loading = signal(false);
  private readonly slow = signal(false);
  private readonly error = signal<EntryState | undefined>(undefined);
  protected readonly entryState = computed(() => {
    if (this.loading()) return this.slow() ? EntryState.Slow : EntryState.Loading;
    if (this.session.expired()) return EntryState.Expired;
    return this.error() ?? EntryState.Missing;
  });
  protected readonly needsLogin = computed(() => [EntryState.Missing, EntryState.Expired].includes(this.entryState()));
  protected readonly EntryState = EntryState;
  private initializationEpoch = 0;
  private slowTimer?: ReturnType<typeof setTimeout>;
  protected readonly updates = inject(AppUpdates);
  protected readonly updateReady = translateSignal('app.updateReady');
  private readonly updateLater = translateSignal('app.updateLater');
  private readonly updateNow = translateSignal('app.updateNow');
  protected readonly updateButtons = computed(() => [
    { text: this.updateLater(), role: 'cancel' },
    { text: this.updateNow(), handler: this.updates.reload },
  ]);
  protected readonly splitPaneVisible = signal(false);

  constructor() {
    registerEscape(() => this.escapeKey(), EscapePriority.Navigation);
    inject(DestroyRef).onDestroy(() => clearTimeout(this.slowTimer));
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationEnd) void this.panels.dismissTransientOverlays();
    });
    afterRenderEffect(() => this.updates.setInteractive(!this.landingPage() && !!this.session.user()));
    this.session.restoreToken();
    if ((!this.session.token() && !isDevMode()) || (this.landingPage() && !isPlatform('pwa'))) {
      this.loading.set(false);
    } else {
      void this.initialize();
    }
  }

  protected prepareTransition(outlet: IonRouterOutlet) {
    outlet.animated = !this.splitPaneVisible();
    // Finish Ionic's page visibility cleanup even when Safari already played the transition.
    outlet.animation =
      this.browserTransition() && this.router.currentNavigation()?.trigger === 'popstate'
        ? (baseEl, options) => iosTransitionAnimation(baseEl, options).duration(0)
        : iosTransitionAnimation;
  }

  protected async escapeKey() {
    const segments = this.router.parseUrl(this.router.url).root.children['primary']?.segments.map((s) => s.path);
    if (segments?.length === 5 && segments[0] === 'chats' && segments[1] === 'chat' && segments[3] === 'thread')
      await this.nav.navigateBack(['/chats/chat', segments[2]], { replaceUrl: true, fragment: `msg=${segments[4]}` });
    else if (segments?.length === 3 && segments[0] === 'chats' && segments[1] === 'chat')
      await this.nav.navigateBack(['/chats'], { replaceUrl: true });
    else return false;
    return true;
  }

  protected async initialize() {
    if (this.loading()) return;
    const epoch = ++this.initializationEpoch;
    this.loading.set(true);
    this.slow.set(false);
    this.error.set(undefined);
    this.slowTimer = setTimeout(() => this.slow.set(true), 10000);
    try {
      await this.session.initialize();
      if (epoch === this.initializationEpoch && this.session.user()) this.notifications.start();
    } catch (error) {
      if (epoch !== this.initializationEpoch) return;
      this.error.set(
        error instanceof TimeoutError || error instanceof RpcTransportError
          ? EntryState.Network
          : error instanceof RpcError && error.code === RpcErrorCode.Unauthorized
            ? EntryState.Expired
            : error instanceof RpcError && [RpcErrorCode.Unavailable, RpcErrorCode.Internal].includes(error.code)
              ? EntryState.Server
              : EntryState.Failed,
      );
    } finally {
      if (epoch !== this.initializationEpoch) return;
      clearTimeout(this.slowTimer);
      this.loading.set(false);
    }
  }
}
