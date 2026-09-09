import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, linkedSignal, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import {
  IonApp,
  IonButton,
  IonContent,
  IonMenu,
  IonRouterOutlet,
  IonSpinner,
  IonSplitPane,
  iosTransitionAnimation,
} from '@ionic/angular';
import { filter, map } from 'rxjs';
import { ChatList } from '../chats/chat-list/chat-list';
import { listSelection, ListTab, type ListSelection } from '../chats/list-tabs';
import { NotificationBanner } from '../pwa/notification-banner/notification-banner';
import { ContentScrollbars } from '../scrolling/content-scrollbars';
import { SessionStore } from '../session/session-store';
import { SettingsModal } from '../settings/settings-modal/settings-modal';

enum StartupError {
  Expired,
  Unavailable,
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: { '(window:popstate)': 'browserTransition.set($event.hasUAVisualTransition)' },
  imports: [
    NotificationBanner,
    ContentScrollbars,
    IonApp,
    IonButton,
    IonContent,
    IonMenu,
    IonRouterOutlet,
    IonSpinner,
    IonSplitPane,
    ChatList,
    SettingsModal,
  ],
})
export class App {
  private readonly router = inject(Router);
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
  protected readonly expired = StartupError.Expired;
  protected readonly loading = signal(true);
  protected readonly error = signal<StartupError | undefined>(undefined);
  protected readonly splitPaneVisible = signal(false);

  constructor() {
    void this.initialize();
  }

  protected prepareTransition(outlet: IonRouterOutlet) {
    outlet.animated = !this.splitPaneVisible();
    // Finish Ionic's page visibility cleanup even when Safari already played the transition.
    outlet.animation =
      this.browserTransition() && this.router.currentNavigation()?.trigger === 'popstate'
        ? (baseEl, options) => iosTransitionAnimation(baseEl, options).duration(0)
        : iosTransitionAnimation;
  }

  protected async initialize() {
    this.loading.set(true);
    this.error.set(undefined);
    try {
      await this.session.initialize();
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse && error.status === 401 ? StartupError.Expired : StartupError.Unavailable,
      );
    } finally {
      this.loading.set(false);
    }
  }
}
