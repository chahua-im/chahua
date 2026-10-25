import { Component, DestroyRef, inject, signal } from '@angular/core';
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
  IonListHeader,
  IonNote,
  IonRange,
  IonRadio,
  IonRadioGroup,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
  ModalController,
  type ToggleCustomEvent,
} from '@ionic/angular';
import {
  chatbubblesOutline,
  chevronBackOutline,
  contrastOutline,
  moonOutline,
  personCircleOutline,
  personOutline,
  peopleOutline,
  sunnyOutline,
} from 'ionicons/icons';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { ChatFontSize, chatFontSizes } from '../chat-font-size';
import { ColorMode } from '../color-mode';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../preferences';

@Component({
  selector: 'app-general-settings',
  templateUrl: './general-settings.html',
  styleUrl: './general-settings.scss',
  imports: [
    ContentScrollbars,
    TranslocoPipe,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    IonNote,
    IonRange,
    IonRadio,
    IonRadioGroup,
    IonSpinner,
    IonTitle,
    IonToggle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class GeneralSettings {
  protected readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly saving = signal(false);
  protected readonly saveError = signal(false);
  protected readonly membershipIcon = peopleOutline;
  protected readonly preferences = inject(Preferences);
  protected readonly modals = inject(ModalController);
  protected readonly ColorMode = ColorMode;
  protected readonly threadsIcon = chatbubblesOutline;
  protected readonly FontSize = ChatFontSize;
  protected readonly fontSizes = chatFontSizes;
  protected readonly avatarsIcon = personCircleOutline;
  protected readonly dmDetailsIcon = personOutline;
  protected readonly systemIcon = contrastOutline;
  protected readonly lightIcon = sunnyOutline;
  protected readonly darkIcon = moonOutline;
  protected readonly backIcon = chevronBackOutline;

  protected setFontSize(value: number | { lower: number; upper: number }) {
    if (typeof value === 'number') this.preferences.setChatFontSize(value);
  }

  protected setColorMode(value: ColorMode) {
    this.preferences.setColorMode(value);
  }

  protected async saveMembershipMessages(event: ToggleCustomEvent) {
    if (this.saving() || !this.session.user()) return;
    const uid = this.session.user()!.uid;
    this.saving.set(true);
    this.saveError.set(false);
    try {
      await this.preferences.setShowMembershipMessages(event.detail.checked);
    } catch {
      if (!this.destroyRef.destroyed && this.session.user()?.uid === uid) this.saveError.set(true);
    } finally {
      if (!this.destroyRef.destroyed) {
        event.target.checked = this.preferences.showMembershipMessages();
        this.saving.set(false);
      }
    }
  }
}
