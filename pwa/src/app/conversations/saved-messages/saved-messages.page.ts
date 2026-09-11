import { ChangeDetectorRef, Component, inject, signal } from '@angular/core';
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

  ionViewDidEnter() {
    this.active.set(true);
    this.changeDetector.detectChanges();
  }
  ionViewDidLeave() {
    this.active.set(false);
    this.changeDetector.detectChanges();
  }
}
