import { Component, inject, signal, viewChild } from '@angular/core';
import { IonActionSheet } from '@ionic/angular';
import type { SnowflakeID } from '../../api/snowflake-id';
import { ChatStore } from '../chat-store';

@Component({
  selector: 'app-chat-mute',
  imports: [IonActionSheet],
  templateUrl: './chat-mute.html',
})
export class ChatMute {
  private readonly store = inject(ChatStore);
  private readonly sheet = viewChild.required(IonActionSheet);
  private readonly choosing = signal(false);

  async toggle(chatId: SnowflakeID) {
    if (this.choosing()) return;
    if (this.store.isMuted(chatId)) return this.store.setMuted(chatId, false);
    this.choosing.set(true);
    try {
      const sheet = this.sheet();
      await sheet.present();
      const { data, role } = await sheet.onDidDismiss<{ seconds?: number }>();
      if (role === 'selected') await this.store.setMuted(chatId, true, data?.seconds);
    } finally {
      this.choosing.set(false);
    }
  }
}
