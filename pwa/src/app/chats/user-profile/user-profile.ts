import { dismissChatOverlays } from '../dismiss-chat-overlays';
import { Component, effect, inject, input, signal } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonAvatar,
  IonList,
  IonItem,
  IonLabel,
  IonSpinner,
  ModalController,
  AlertController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { BlocksService } from '../../../generated/endpoints/blocks/blocks.service';
import {
  type MemberSummary,
  type FriendRelationshipResponse,
  type FriendAddInfoResponse,
  FriendAddVerificationMode,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { ChatListStore } from '../chat-list-store';
import { SessionStore } from '../../session/session-store';

@Component({
  selector: 'app-user-profile',
  templateUrl: './user-profile.html',
  imports: [
    FormField,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonAvatar,
    IonList,
    IonItem,
    IonLabel,
    IonSpinner,
  ],
  host: { class: 'ion-page' },
})
export class UserProfile {
  readonly user = input.required<MemberSummary>();
  protected readonly modals = inject(ModalController);
  private readonly friends = inject(FriendsService);
  private readonly blocks = inject(BlocksService);
  private readonly lists = inject(ChatListStore);
  private readonly router = inject(Router);
  private readonly alerts = inject(AlertController);
  protected readonly session = inject(SessionStore);
  protected readonly relationship = signal<FriendRelationshipResponse | undefined>(undefined);
  protected readonly verification = signal<FriendAddInfoResponse | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly failed = signal(false);
  protected readonly sent = signal(false);
  protected readonly Mode = FriendAddVerificationMode;
  protected readonly data = signal({ message: '' });
  protected readonly fields = form(this.data);
  constructor() {
    effect(() => {
      if (this.user().uid !== this.session.user()?.uid) void this.load();
    });
  }
  protected async load() {
    this.busy.set(true);
    this.failed.set(false);
    try {
      const [relationship, verification] = await Promise.all([
        firstValueFrom(this.friends.getFriendRelationship(this.user().uid)),
        firstValueFrom(this.friends.getUserFriendAddInfo(this.user().uid)),
      ]);
      this.relationship.set(relationship);
      this.verification.set(verification);
    } catch {
      this.failed.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async send() {
    if (this.busy()) return;
    this.busy.set(true);
    this.failed.set(false);
    try {
      await firstValueFrom(
        this.friends.createFriendRequest({ toUid: this.user().uid, message: this.data().message.trim() || undefined }),
      );
      this.sent.set(true);
      this.lists.refreshChats();
      await this.load();
    } catch {
      this.failed.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async manage(block: boolean) {
    const alert = await this.alerts.create({
      header: block ? (this.relationship()?.blocking ? '解除拉黑' : '拉黑用户') : '删除好友',
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '确定', role: 'confirm' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') return;
    this.busy.set(true);
    this.failed.set(false);
    try {
      await firstValueFrom(
        block
          ? this.relationship()?.blocking
            ? this.blocks.unblockUser(this.user().uid)
            : this.blocks.blockUser({ uid: this.user().uid })
          : this.friends.deleteFriend(this.user().uid),
      );
      this.lists.refreshChats();
      await this.load();
    } catch {
      this.failed.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async chat() {
    const id = this.relationship()?.dmChatId;
    if (!id) return;
    await dismissChatOverlays(this.modals);
    await this.router.navigate(['/chats/chat', decodeId(id)]);
  }
}
