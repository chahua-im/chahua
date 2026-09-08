import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { closeOutline } from 'ionicons/icons';
import { GroupKind } from '../../../generated/models';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { ChatStore } from '../../chats/chat-store';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { PushNotifications } from '../push-notifications';

@Component({
  selector: 'app-notification-banner',
  imports: [IonIcon, ChatAvatar, MessagePreview],
  templateUrl: './notification-banner.html',
  styleUrl: './notification-banner.scss',
})
export class NotificationBanner {
  readonly enabled = input.required<boolean>();
  protected readonly notifications = inject(PushNotifications);
  private readonly chats = inject(ChatStore);
  protected readonly closeIcon = closeOutline;
  protected readonly entry = computed(() => {
    const message = this.notifications.banner();
    const chat = message && this.chats.get(message.chatId);
    const dm = chat?.kind === GroupKind.dm;
    const title = (dm ? chat.peer?.username : chat?.name) ?? message?.sender.name;
    return {
      title,
      avatarName: title,
      avatar: dm ? chat.peer?.avatarUrl : chat?.avatar,
      sender: !dm ? message?.sender.name : undefined,
    };
  });
  constructor() {
    this.notifications.start();
    effect(() => {
      if (!this.enabled() && this.notifications.banner()) untracked(() => this.notifications.dismiss());
    });
  }
}
