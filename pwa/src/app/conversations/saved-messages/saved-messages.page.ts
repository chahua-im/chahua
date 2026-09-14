import { ChangeDetectorRef, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';
import { SavedMessageList } from '../../messages/saved-message-list/saved-message-list';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';

@Component({
  selector: 'app-saved-messages',
  templateUrl: './saved-messages.page.html',
  imports: [
    ContentScrollbars,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    SavedMessageList,
  ],
})
export class SavedMessagesPage {
  protected readonly active = signal(true);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly router = inject(Router);
  private visible = true;

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationEnd && !this.visible && this.router.url !== '/chats/saved') this.release();
    });
  }

  ionViewDidEnter() {
    this.visible = true;
    this.active.set(true);
    this.changeDetector.detectChanges();
  }
  ionViewDidLeave() {
    this.visible = false;
    this.release();
  }
  private release() {
    if (this.router.routerState.snapshot.root.firstChild?.data['modal']) return;
    this.active.set(false);
    this.changeDetector.detectChanges();
  }
}
