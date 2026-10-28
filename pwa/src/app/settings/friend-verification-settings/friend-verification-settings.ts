import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { applyWhen, disabled, form, FormField, maxLength, pattern, required } from '@angular/forms/signals';
import {
  AlertController,
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
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { banOutline, chatbubbleOutline, chevronBackOutline, helpCircleOutline, personAddOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { FriendAddVerificationMode } from '../../../generated/models';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';

@Component({
  selector: 'app-friend-verification-settings',
  templateUrl: './friend-verification-settings.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    ContentScrollbars,
    FormField,
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
    IonTextarea,
    IonTitle,
    IonToolbar,
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
})
export class FriendVerificationSettings {
  private readonly friends = inject(FriendsService);
  private readonly alerts = inject(AlertController);
  private readonly transloco = inject(TranslocoService);
  protected readonly panels = inject(PanelNavigation);
  protected readonly allowIcon = personAddOutline;
  protected readonly messageIcon = chatbubbleOutline;
  protected readonly questionIcon = helpCircleOutline;
  protected readonly forbidIcon = banOutline;
  protected readonly backIcon = chevronBackOutline;
  protected readonly Mode = FriendAddVerificationMode;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly loadError = signal(false);
  protected readonly saveError = signal(false);
  protected readonly saved = signal(false);
  protected readonly verification = signal({ mode: FriendAddVerificationMode.direct, question: '' });
  private readonly applied = signal({ mode: FriendAddVerificationMode.direct, question: '' });
  protected readonly dirty = computed(() => {
    const value = this.verification();
    return (
      value.mode === FriendAddVerificationMode.question &&
      (value.mode !== this.applied().mode || value.question.trim() !== this.applied().question)
    );
  });
  private discardConfirmation?: Promise<boolean>;
  protected readonly verificationForm = form(this.verification, (fields) => {
    disabled(fields, () => this.loading() || this.saving() || this.loadError());
    applyWhen(
      fields,
      ({ value }) => value().mode === FriendAddVerificationMode.question,
      (questionFields) => {
        required(questionFields.question);
        pattern(questionFields.question, /\S/);
        maxLength(questionFields.question, 100);
      },
    );
  });

  constructor() {
    void this.loadVerification();
    inject(DestroyRef).onDestroy(
      this.panels.registerLeaveCheck('/settings/friend-verification', () => this.canDismiss()),
    );
  }

  async canDismiss(role?: string): Promise<boolean> {
    if (role === 'saved') return true;
    if (this.saving()) return false;
    if (!this.dirty()) return true;
    this.discardConfirmation ??= this.confirmDiscard().finally(() => {
      this.discardConfirmation = undefined;
    });
    return this.discardConfirmation;
  }

  private async confirmDiscard() {
    const alert = await this.alerts.create({
      header: this.transloco.translate('settings.friendVerification.discardTitle'),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('settings.friendVerification.discard'), role: 'destructive' },
      ],
    });
    await alert.present();
    const discard = (await alert.onDidDismiss()).role === 'destructive';
    if (discard) this.verification.set(this.applied());
    return discard;
  }

  protected async loadVerification() {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const settings = await firstValueFrom(this.friends.getMyFriendSettings());
      this.verification.set({ mode: settings.mode, question: settings.question ?? '' });
      this.applied.set(this.verification());
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected chooseMode(mode: FriendAddVerificationMode) {
    if (this.saving() || mode === this.verification().mode) return;
    this.verification.update((value) => ({ ...value, mode }));
    this.saved.set(false);
    this.saveError.set(false);
    if (mode !== FriendAddVerificationMode.question) void this.saveVerification();
  }

  protected async saveVerification() {
    if (this.verificationForm().disabled() || this.verificationForm().invalid()) return;
    this.saving.set(true);
    this.saved.set(false);
    this.saveError.set(false);
    const { mode, question } = this.verification();
    try {
      const settings = await firstValueFrom(
        this.friends.updateMyFriendSettings({
          mode,
          ...(mode === FriendAddVerificationMode.question ? { question: question.trim() } : {}),
        }),
      );
      this.verification.set({ mode: settings.mode, question: settings.question ?? '' });
      this.applied.set(this.verification());
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
    if (this.saved() && mode === FriendAddVerificationMode.question) await this.panels.back();
  }
}
