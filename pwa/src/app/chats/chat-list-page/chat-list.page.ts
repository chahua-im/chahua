import { booleanAttribute, ChangeDetectorRef, Component, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { IonContent, IonHeader, IonIcon, IonTitle, IonToolbar, NavController } from '@ionic/angular';
import { chatbubblesOutline } from 'ionicons/icons';
import { fromEvent, map } from 'rxjs';
import { ChatList } from '../chat-list/chat-list';
import { ListTab, type ListSelection } from '../list-tabs';
import { ContentScrollbars } from '../../content-scrollbars';

@Component({
  selector: 'app-chats',
  templateUrl: './chat-list.page.html',
  styleUrl: './chat-list.page.scss',
  imports: [ContentScrollbars, ChatList, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar],
})
export class ChatListPage {
  private readonly nav = inject(NavController);
  readonly tab = input(ListTab.Messages);
  readonly archived = input(false, { transform: booleanAttribute });
  readonly requestHistory = input(false, { transform: booleanAttribute });
  protected readonly selection = computed(() => ({
    tab: this.tab(),
    archived: this.archived(),
    requestHistory: this.requestHistory(),
  }));
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
    return this.archived() || this.requestHistory() ? this.nav.navigateBack(url) : this.nav.navigateForward(url);
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
