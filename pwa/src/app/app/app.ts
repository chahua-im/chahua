import { DOCUMENT } from '@angular/common';
import { afterRenderEffect, Component, inject, linkedSignal, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import {
  IonApp,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonMenu,
  IonRouterOutlet,
  IonSpinner,
  IonSplitPane,
  IonToolbar,
  IonToast,
  iosTransitionAnimation,
  isPlatform,
} from '@ionic/angular';
import { filter, map } from 'rxjs';
import { ChatList } from '../chats/chat-list/chat-list';
import { listSelection, ListTab, type ListSelection } from '../chats/list-tabs';
import { PushNotifications } from '../pwa/push-notifications';
import { NotificationPrompt } from '../pwa/notification-prompt/notification-prompt';
import { AppUpdates } from '../pwa/app-updates';
import { ContentScrollbars } from '../scrolling/content-scrollbars';
import { SessionStore } from '../session/session-store';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: {
    '(window:popstate)': 'browserTransition.set($event.hasUAVisualTransition)',
    '(document:keydown)': 'escapeKey($event)',
  },
  imports: [
    ContentScrollbars,
    IonApp,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonMenu,
    IonRouterOutlet,
    IonSpinner,
    IonSplitPane,
    IonToolbar,
    IonToast,
    ChatList,
    NotificationPrompt,
  ],
})
export class App {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
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
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly splitPaneVisible = signal(false);
  protected readonly updates = inject(AppUpdates);

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationStart) {
        // Snapshot existing overlays so a newly opened page cannot be dismissed by an older transition.
        this.document
          .querySelectorAll<
            HTMLIonModalElement | HTMLIonPopoverElement | HTMLIonAlertElement | HTMLIonActionSheetElement
          >('ion-modal, ion-popover, ion-alert, ion-action-sheet')
          .forEach((overlay) => void overlay.dismiss(undefined, 'navigate'));
      }
    });
    afterRenderEffect(() => this.updates.setInteractive(!this.landingPage() && !!this.session.user()));
    this.session.restoreToken();
    if (!this.session.token() || (this.landingPage() && !isPlatform('pwa'))) {
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

  /**
   * Page-level Escape: in a thread → parent chat positioned at the thread root message, in a chat →
   * the chat list. Defers to inputs and Ionic overlays, which handle Escape themselves.
   */
  protected escapeKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    const active = this.document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
    // A closed inline toast or alert stays in the DOM as .overlay-hidden, and a split-pane menu is
    // permanently visible without it, so each overlay needs its own "presented" marker.
    if (
      this.document.querySelector(
        'ion-alert:not(.overlay-hidden), ion-action-sheet:not(.overlay-hidden), ion-menu.show-menu, ion-modal:not(.overlay-hidden), ion-toast:not(.overlay-hidden)',
      )
    )
      return;
    const segments = this.router.parseUrl(this.router.url).root.children['primary']?.segments.map((s) => s.path);
    if (segments?.length === 5 && segments[0] === 'chats' && segments[1] === 'chat' && segments[3] === 'thread')
      void this.router.navigate(['/chats/chat', segments[2]], { replaceUrl: true, fragment: `msg=${segments[4]}` });
    else if (segments?.length === 3 && segments[0] === 'chats' && segments[1] === 'chat')
      void this.router.navigate(['/chats'], { replaceUrl: true });
  }

  protected async initialize() {
    this.loading.set(true);
    this.error.set(false);
    try {
      await this.session.initialize();
      if (this.session.user()) this.notifications.start();
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
