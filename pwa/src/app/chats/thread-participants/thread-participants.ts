import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { RouterLink } from '@angular/router';
import { Component, computed, inject, input } from '@angular/core';
import { IonItem, IonLabel, IonList } from '@ionic/angular';
import type { MessagePreview, MessageResponse, SnowflakeID } from '../../../generated/models';
import { ChatStore } from '../chat-store';

@Component({
  selector: 'app-thread-participants',
  templateUrl: './thread-participants.html',
  imports: [RouterLink, ChatAvatar, IonItem, IonLabel, IonList],
})
export class ThreadParticipants {
  readonly rootId = input.required<SnowflakeID>();
  readonly root = input<MessageResponse | MessagePreview>();
  readonly messages = input<readonly MessageResponse[]>([]);
  private readonly store = inject(ChatStore);
  private readonly cached = computed(() => this.store.thread(this.rootId())?.participants);
  protected readonly complete = computed(() => !!this.cached());
  protected readonly participants = computed(() => {
    const users = new Map((this.cached() ?? []).map((user) => [user.uid, user]));
    const root = this.root();
    if (root) users.set(root.sender.uid, root.sender);
    for (const message of this.messages()) {
      if (message.replyRootId === this.rootId() && !message.isDeleted) users.set(message.sender.uid, message.sender);
    }
    return [...users.values()];
  });
}
