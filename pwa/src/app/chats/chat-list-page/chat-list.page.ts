import { ChangeDetectorRef, Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { IonContent, IonHeader, IonIcon, IonTitle, IonToolbar, NavController } from '@ionic/angular';
import { chatbubblesOutline } from 'ionicons/icons';
import { filter, fromEvent, map } from 'rxjs';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { ChatList } from '../chat-list/chat-list';
import { listSelection, ListTab, type ListSelection } from '../list-tabs';

@Component({
  selector: 'app-chats',
  templateUrl: './chat-list.page.html',
  styleUrl: './chat-list.page.scss',
  imports: [ContentScrollbars, ChatList, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar, RouterOutlet],
})
export class ChatListPage {
  private readonly nav = inject(NavController);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly selection = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      // Ionic's cached ActivatedRoute proxy does not refresh its snapshot for child-only navigation.
      map(() => this.router.routerState.snapshot.root.firstChild),
      filter((route) => route?.routeConfig === this.route.snapshot.routeConfig),
      map((route) => listSelection(route!)!),
    ),
    {
      initialValue: listSelection(this.router.routerState.snapshot.root) ?? {
        tab: ListTab.Messages,
        archived: false,
        requestHistory: false,
      },
    },
  );
  private readonly desktop = window.matchMedia('(min-width: 768px)');
  protected readonly wide = toSignal(
    fromEvent<MediaQueryListEvent>(this.desktop, 'change').pipe(map((event) => event.matches)),
    { initialValue: this.desktop.matches },
  );
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly listActive = signal(true);
  protected readonly chatIcon = chatbubblesOutline;

  protected openList(selection: ListSelection) {
    const url = ['/chats', selection.tab];
    if (selection.archived) url.push('archived');
    if (selection.requestHistory) url.push('archived-requests');
    return this.selection().archived || this.selection().requestHistory
      ? this.nav.navigateBack(url)
      : this.nav.navigateForward(url);
  }

  ionViewDidEnter() {
    this.listActive.set(true);
  }

  ionViewDidLeave() {
    this.listActive.set(false);
    // Ionic detaches cached pages; run the child query cleanups before leaving it hidden.
    this.changeDetector.detectChanges();
  }
}
