import { Component, inject, signal } from '@angular/core';
import { applyWhen, disabled, form, FormField, maxLength, pattern, required } from '@angular/forms/signals';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNavLink,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { chevronBackOutline, personAddOutline, chatbubbleOutline, helpCircleOutline, banOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { FriendAddVerificationMode } from '../../../generated/models';

@Component({
  selector: 'app-friend-verification-settings',
  templateUrl: './friend-verification-settings.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    FormField,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNavLink,
    IonNote,
    IonRadio,
    IonRadioGroup,
    IonSpinner,
    IonTextarea,
    IonTitle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class FriendVerificationSettings {
  private readonly friends = inject(FriendsService);
  protected readonly modals = inject(ModalController);
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
  }

  protected async loadVerification() {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const settings = await firstValueFrom(this.friends.getMyFriendSettings());
      this.verification.set({ mode: settings.mode, question: settings.question ?? '' });
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
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
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
