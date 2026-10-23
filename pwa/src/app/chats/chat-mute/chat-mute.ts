import { ChangeDetectorRef, Component, computed, inject, signal, viewChild } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ActionSheetButton } from '@ionic/core';
import { notificationPermanentlyMuted } from '../notification-setting';
import { IonActionSheet } from '@ionic/angular';
import type { SnowflakeID } from '../../api/snowflake-id';
import { NotificationSettingMode, type UpdateNotificationSettingRequest } from '../../../generated/models';
import { SessionStore } from '../../session/session-store';
import { ChatStore } from '../chat-store';

@Component({
  selector: 'app-chat-mute',
  imports: [IonActionSheet, TranslocoPipe],
  templateUrl: './chat-mute.html',
})
export class ChatMute {
  private readonly store = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly sheet = viewChild.required(IonActionSheet);
  private readonly choosing = signal(false);
  private readonly view = inject(ChangeDetectorRef);
  private readonly chatId = signal<SnowflakeID | undefined>(undefined);
  private readonly permanentlyMuted = computed(() => {
    const chatId = this.chatId();
    return (
      chatId != null &&
      notificationPermanentlyMuted(
        this.store.get(chatId)?.kind,
        this.store.chatState(chatId),
        this.store.notificationDefaults(),
      )
    );
  });
  protected notificationButtons(buttons: ActionSheetButton<UpdateNotificationSettingRequest>[]) {
    return this.permanentlyMuted()
      ? buttons.filter((button) => button.data?.mode !== NotificationSettingMode.temporarilyMuted)
      : buttons;
  }
  protected readonly Mode = NotificationSettingMode;

  async toggle(chatId: SnowflakeID) {
    if (this.choosing()) return;
    const uid = this.session.user()?.uid;
    this.choosing.set(true);
    this.chatId.set(chatId);
    try {
      // Bind this chat’s current choices before Ionic presents the overlay.
      this.view.detectChanges();
      const sheet = this.sheet();
      await sheet.present();
      const { data, role } = await sheet.onDidDismiss<UpdateNotificationSettingRequest>();
      if (role === 'selected' && data && this.session.user()?.uid === uid)
        await this.store.setNotificationSetting(chatId, data);
    } finally {
      this.choosing.set(false);
    }
  }
}
