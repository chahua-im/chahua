import { Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { chevronBackOutline, eyeOffOutline, peopleOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { ReadReceiptVisibility } from '../../../generated/models';
import { ChatStore } from '../../chats/chat-store';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';

@Component({
  selector: 'app-read-receipt-settings',
  templateUrl: './read-receipt-settings.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    ContentScrollbars,
    LoadError,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonRadio,
    IonRadioGroup,
    IonSpinner,
    IonTitle,
    IonToolbar,
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
})
export class ReadReceiptSettings {
  private readonly friends = inject(FriendsService);
  private readonly chats = inject(ChatStore);
  protected readonly modals = inject(ModalController);
  protected readonly friendsIcon = peopleOutline;
  protected readonly nobodyIcon = eyeOffOutline;
  protected readonly backIcon = chevronBackOutline;
  protected readonly Visibility = ReadReceiptVisibility;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly loadError = signal(false);
  protected readonly saveError = signal(false);
  protected readonly saved = signal(false);
  protected readonly visibility = signal(ReadReceiptVisibility.friends);

  constructor() {
    void this.loadReadReceiptSettings();
  }

  protected async loadReadReceiptSettings() {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const settings = await firstValueFrom(this.friends.getMyReadReceiptSettings());
      this.visibility.set(settings.visibility);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected chooseVisibility(value: unknown) {
    if (!Object.values(ReadReceiptVisibility).includes(value as ReadReceiptVisibility) || this.saving()) return;
    this.visibility.set(value as ReadReceiptVisibility);
    this.saved.set(false);
    this.saveError.set(false);
  }

  protected async saveReadReceiptSettings() {
    if (this.loading() || this.saving() || this.loadError()) return;
    this.saving.set(true);
    this.saved.set(false);
    this.saveError.set(false);
    try {
      const settings = await firstValueFrom(
        this.friends.updateMyReadReceiptSettings({ visibility: this.visibility() }),
      );
      this.visibility.set(settings.visibility);
      this.chats.invalidateReadReceiptPrivacy();
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
