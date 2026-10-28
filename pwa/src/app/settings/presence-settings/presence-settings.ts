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
  IonRadio,
  IonRadioGroup,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { chevronBackOutline, eyeOutline, peopleOutline, eyeOffOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { PresenceVisibility } from '../../../generated/models';
import { Presence } from '../../presence/presence';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';

@Component({
  selector: 'app-presence-settings',
  templateUrl: './presence-settings.html',
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
    IonRadio,
    IonRadioGroup,
    IonSpinner,
    IonTitle,
    IonToolbar,
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
})
export class PresenceSettings {
  private readonly friends = inject(FriendsService);
  private readonly presence = inject(Presence);
  protected readonly ExceptionKind = PrivacyExceptionKind;
  protected readonly modals = inject(ModalController);
  protected readonly everyoneIcon = eyeOutline;
  protected readonly friendsIcon = peopleOutline;
  protected readonly nobodyIcon = eyeOffOutline;
  protected readonly backIcon = chevronBackOutline;
  protected readonly Visibility = PresenceVisibility;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly loadError = signal(false);
  protected readonly saveError = signal(false);
  protected readonly saved = signal(false);
  protected readonly visibility = signal(PresenceVisibility.everyone);

  private savedVisibility = this.visibility();
  private requestedVisibility = this.visibility();

  constructor() {
    void this.loadPresenceSettings();
  }

  protected async loadPresenceSettings() {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const settings = await firstValueFrom(this.friends.getMyPresenceSettings());
      this.visibility.set(settings.visibility);
      this.savedVisibility = settings.visibility;
      this.requestedVisibility = settings.visibility;
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected chooseVisibility(value: unknown) {
    if (!Object.values(PresenceVisibility).includes(value as PresenceVisibility) || this.saving()) return;
    if (value === this.visibility()) return;
    this.requestedVisibility = value as PresenceVisibility;
    this.visibility.set(this.requestedVisibility);
    this.saved.set(false);
    this.saveError.set(false);
    void this.savePresenceSettings();
  }

  protected async savePresenceSettings() {
    if (this.loading() || this.saving() || this.loadError()) return;
    this.visibility.set(this.requestedVisibility);
    this.saving.set(true);
    this.saved.set(false);
    this.saveError.set(false);
    try {
      const settings = await firstValueFrom(this.friends.updateMyPresenceSettings({ visibility: this.visibility() }));
      this.visibility.set(settings.visibility);
      this.savedVisibility = settings.visibility;
      this.requestedVisibility = settings.visibility;
      this.presence.invalidateUsers();
      this.saved.set(true);
    } catch {
      this.visibility.set(this.savedVisibility);
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
