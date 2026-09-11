import { ChangeDetectorRef, Component, computed, inject, input, signal } from '@angular/core';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';
import { encodeId } from '../../api/snowflake-id';
import { SavedMessageList } from '../../messages/saved-message-list/saved-message-list';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';

@Component({
  selector: 'app-saved-messages',
  templateUrl: './saved-messages.page.html',
  styleUrl: './saved-messages.page.scss',
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
  readonly id = input<string>();
  protected readonly chatId = computed(() => (this.id() ? encodeId(this.id()!) : undefined));
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
