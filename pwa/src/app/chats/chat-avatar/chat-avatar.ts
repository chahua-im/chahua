import { afterRenderEffect, Component, computed, ElementRef, input, linkedSignal, viewChild } from '@angular/core';
import { IonAvatar, IonIcon } from '@ionic/angular';
import { chatbubbles } from 'ionicons/icons';
import { GroupKind, type MessagePreview, type ThreadListItem } from '../../../generated/models';
import type { ChatInfo } from '../chat-store';
import { AvatarColor, AvatarTextPipe } from '../avatar-text.pipe';

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
  imports: [AvatarColor, AvatarTextPipe, IonAvatar, IonIcon],
  host: { '[style.--avatar-size.px]': 'size()' },
})
export class ChatAvatar {
  readonly entry = input.required<ChatAvatarData>();
  readonly size = input<number>();
  readonly textLength = input(1);
  readonly online = input(false);
  protected readonly name = computed(() => this.entry().avatarName || this.entry().title || '?');
  private readonly avatarUrl = computed(() => this.entry().avatar);
  private readonly badgeUrl = computed(() => this.entry().badgeAvatar);
  protected readonly avatarLoaded = linkedSignal({ source: this.avatarUrl, computation: () => false });
  protected readonly badgeLoaded = linkedSignal({ source: this.badgeUrl, computation: () => false });
  private readonly avatarImage = viewChild<ElementRef<HTMLImageElement>>('avatarImage');
  private readonly badgeImage = viewChild<ElementRef<HTMLImageElement>>('badgeImage');

  constructor() {
    afterRenderEffect({
      read: () => {
        // Cached images can be ready before their load event is delivered.
        const avatar = this.avatarImage()?.nativeElement;
        const badge = this.badgeImage()?.nativeElement;
        if (avatar?.complete && avatar.naturalWidth > 0) this.avatarLoaded.set(true);
        if (badge?.complete && badge.naturalWidth > 0) this.badgeLoaded.set(true);
      },
    });
  }

  protected imageLoaded(src: string, badge = false) {
    if (src === (badge ? this.entry().badgeAvatar : this.entry().avatar))
      (badge ? this.badgeLoaded : this.avatarLoaded).set(true);
  }
}

export function conversationAvatar(
  chat: ChatInfo | undefined,
  root?: Pick<MessagePreview, 'sender'>,
  thread = false,
): ChatAvatarData {
  const dm = chat?.kind === GroupKind.dm;
  return {
    avatar: dm ? chat.peer?.avatarUrl : chat?.avatar,
    avatarName: dm ? (chat.peer?.username ?? chat.peer?.uid.toString()) : chat?.name,
    badgeName: thread && !dm && root ? (root.sender.name ?? String(root.sender.uid)) : undefined,
    badgeAvatar: thread && !dm ? root?.sender.avatarUrl : undefined,
    badgeIcon: thread && dm ? chatbubbles : undefined,
  };
}

export function threadAvatar(thread: ThreadListItem, chat?: ChatInfo): ChatAvatarData {
  const isDm = thread.chatKind === GroupKind.dm;
  const { sender } = thread.threadRootMessage;
  return {
    avatarName: isDm
      ? (chat?.peer?.username ?? thread.peer?.username ?? thread.chatName)
      : (chat?.name ?? thread.chatName),
    avatar: isDm ? (chat?.peer?.avatarUrl ?? thread.peer?.avatarUrl) : (chat?.avatar ?? thread.chatAvatar),
    badgeName: !isDm ? (sender.name ?? String(sender.uid)) : undefined,
    badgeAvatar: !isDm ? sender.avatarUrl : undefined,
    badgeIcon: isDm ? chatbubbles : undefined,
  };
}
