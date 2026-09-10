import { Component, input } from '@angular/core';
import { IonAvatar, IonIcon } from '@ionic/angular';
import { AvatarTextPipe } from '../avatar-text.pipe';

export interface ChatAvatarData {
  title?: string;
  avatarName?: string;
  avatar?: string;
  icon?: string;
  badgeName?: string;
  badgeAvatar?: string;
  badgeIcon?: string;
}

@Component({
  selector: 'app-chat-avatar',
  templateUrl: './chat-avatar.html',
  styleUrl: './chat-avatar.scss',
  imports: [AvatarTextPipe, IonAvatar, IonIcon],
  host: { '[style.--avatar-size.px]': 'size()' },
})
export class ChatAvatar {
  readonly entry = input.required<ChatAvatarData>();
  readonly size = input<number>();
}
