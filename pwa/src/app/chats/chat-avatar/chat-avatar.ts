import { Component, input } from '@angular/core';
import { IonAvatar, IonIcon } from '@ionic/angular';
import { chatbubbles } from 'ionicons/icons';
import { GroupKind, type MessagePreview } from '../../../generated/models';
import type { ChatInfo } from '../chat-store';
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

export function conversationAvatar(
  chat: ChatInfo | undefined,
  root?: Pick<MessagePreview, 'sender'>,
  thread = false,
): ChatAvatarData {
  const dm = chat?.kind === GroupKind.dm;
  return {
    avatar: dm ? chat.peer?.avatarUrl : chat?.avatar,
    avatarName: dm ? chat.peer?.username : chat?.name,
    badgeName: thread && !dm && root ? (root.sender.name ?? String(root.sender.uid)) : undefined,
    badgeAvatar: thread && !dm ? root?.sender.avatarUrl : undefined,
    badgeIcon: thread && dm ? chatbubbles : undefined,
  };
}
