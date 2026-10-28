import { PrivacyExceptions } from '../privacy-exceptions/privacy-exceptions';
import { PrivacyExceptionKind } from '../../../generated/models';
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
  IonToggle,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { chevronBackOutline } from 'ionicons/icons';
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
    PrivacyExceptions,
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
    IonToggle,
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
  protected readonly ExceptionKind = PrivacyExceptionKind;
  protected readonly modals = inject(ModalController);
  protected readonly backIcon = chevronBackOutline;
  protected readonly Visibility = ReadReceiptVisibility;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly loadError = signal(false);
  protected readonly saveError = signal(false);
  protected readonly visibility = signal(ReadReceiptVisibility.friends);

  private savedVisibility = this.visibility();
  private requestedVisibility = this.visibility();

  constructor() {
    void this.loadReadReceiptSettings();
  }

  protected async loadReadReceiptSettings() {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const settings = await firstValueFrom(this.friends.getMyReadReceiptSettings());
      this.visibility.set(settings.visibility);
      this.savedVisibility = settings.visibility;
      this.requestedVisibility = settings.visibility;
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected setEnabled(enabled: boolean) {
    if (this.loading() || this.saving() || this.loadError()) return;
    this.requestedVisibility = enabled ? ReadReceiptVisibility.friends : ReadReceiptVisibility.nobody;
    this.visibility.set(this.requestedVisibility);
    void this.saveReadReceiptSettings();
  }

  protected async saveReadReceiptSettings() {
    if (this.loading() || this.saving() || this.loadError()) return;
    this.visibility.set(this.requestedVisibility);
    this.saving.set(true);
    this.saveError.set(false);
    try {
      const settings = await firstValueFrom(
        this.friends.updateMyReadReceiptSettings({ visibility: this.visibility() }),
      );
      this.visibility.set(settings.visibility);
      this.savedVisibility = settings.visibility;
      this.requestedVisibility = settings.visibility;
      this.chats.invalidateReadReceiptPrivacy();
    } catch {
      this.visibility.set(this.savedVisibility);
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
