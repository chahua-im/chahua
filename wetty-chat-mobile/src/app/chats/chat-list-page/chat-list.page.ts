import { ChangeDetectorRef, Component, inject, signal } from '@angular/core';
import { IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';
import { chatbubblesOutline } from 'ionicons/icons';
import { ChatList } from '../chat-list/chat-list';

@Component({
  selector: 'app-chats',
  templateUrl: './chat-list.page.html',
  styleUrl: './chat-list.page.scss',
  imports: [ChatList, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar],
})
export class ChatListPage {
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly listActive = signal(true);
  protected readonly chatIcon = chatbubblesOutline;

  ionViewDidEnter() {
    this.listActive.set(true);
  }

  ionViewDidLeave() {
    this.listActive.set(false);
    // Ionic detaches cached pages; run the child query cleanups before leaving it hidden.
    this.changeDetector.detectChanges();
  }
}
