import { Component, computed, inject, isDevMode, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { translateSignal, TranslocoPipe } from '@jsverse/transloco';
import {
  chatbubblesOutline,
  constructOutline,
  eyeOutline,
  happyOutline,
  languageOutline,
  notificationsOutline,
  refreshOutline,
} from 'ionicons/icons';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { AppUpdates, UpdateCheckResult } from '../../pwa/app-updates';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { devBackendEnabled, SessionStore } from '../../session/session-store';
import { localeLabels } from '../locale';
import { Preferences } from '../preferences';

@Component({
  selector: 'app-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  imports: [
    ChatAvatar,
    RouterLink,
    ContentScrollbars,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonInput,
    IonTitle,
    IonSpinner,
    IonToolbar,
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
})
export class Settings {
  private readonly panels = inject(PanelNavigation);

  protected readonly session = inject(SessionStore);
  protected readonly updates = inject(AppUpdates);
  protected readonly UpdateResult = UpdateCheckResult;
  protected readonly updateResult = signal<UpdateCheckResult | undefined>(undefined);
  protected readonly languageIcon = languageOutline;
  private readonly preferences = inject(Preferences);
  private readonly autoLabel = translateSignal('settings.language.auto');
  protected readonly localeLabel = computed(() => {
    const locale = this.preferences.selectedLocale();
    return locale ? localeLabels[locale] : this.autoLabel();
  });
  protected readonly generalIcon = chatbubblesOutline;

  protected readonly presenceIcon = eyeOutline;
  protected readonly stickerIcon = happyOutline;
  protected readonly notificationIcon = notificationsOutline;
  protected readonly updateIcon = refreshOutline;
  protected readonly devIcon = constructOutline;
  protected readonly devMode = isDevMode() && devBackendEnabled();
  protected readonly devUidInput = signal('');
  protected readonly devUidValid = computed(() => {
    const uid = Number(this.devUidInput());
    return Number.isInteger(uid) && uid > 0;
  });

  constructor() {
    if (this.devMode) this.devUidInput.set(String(this.session.devUid()));
  }

  protected editDevUid(event: Event) {
    this.devUidInput.set(String((event.target as HTMLIonInputElement).value ?? ''));
  }

  protected switchDevUid() {
    if (!this.devUidValid()) return;
    this.session.switchDevUid(Number(this.devUidInput()));
    window.location.reload();
  }

  protected close() {
    return this.panels.close();
  }

  protected async checkUpdates() {
    this.updateResult.set(undefined);
    this.updateResult.set(await this.updates.check());
  }
}
