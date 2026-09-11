import { Component, computed, inject, input } from '@angular/core';
import { IonAvatar, IonItem, IonLabel, IonList, ModalController } from '@ionic/angular';
import type { MessagePreview, MessageResponse, SnowflakeID, User } from '../../../generated/models';
import { ChatStore } from '../chat-store';
import { UserProfile } from '../user-profile/user-profile';

@Component({
  selector: 'app-thread-participants',
  templateUrl: './thread-participants.html',
  imports: [IonAvatar, IonItem, IonLabel, IonList],
})
export class ThreadParticipants {
  readonly rootId = input.required<SnowflakeID>();
  readonly root = input<MessageResponse | MessagePreview>();
  readonly messages = input<readonly MessageResponse[]>([]);
  private readonly store = inject(ChatStore);
  private readonly modals = inject(ModalController);
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

  protected async profile(user: User) {
    const modal = await this.modals.create({
      component: UserProfile,
      componentProps: { user: { ...user, username: user.name } },
    });
    await modal.present();
  }
}
