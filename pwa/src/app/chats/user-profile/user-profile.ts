import { Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { form, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import {
  AlertController,
  IonAvatar,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { BlocksService } from '../../../generated/endpoints/blocks/blocks.service';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { type FriendAddInfoResponse, FriendAddVerificationMode, type MemberSummary } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { dismissChatOverlays } from '../dismiss-chat-overlays';

@Component({
  selector: 'app-user-profile',
  templateUrl: './user-profile.html',
  imports: [
    ContentScrollbars,
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
  private readonly chats = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly alerts = inject(AlertController);
  protected readonly session = inject(SessionStore);
  private readonly destroy = inject(DestroyRef);
  protected readonly relationshipQuery = computed(() => this.chats.relationship(this.user().uid));
  protected readonly relationship = computed(() => this.relationshipQuery().value());
  protected readonly verification = signal<FriendAddInfoResponse | undefined>(undefined);
  private readonly pending = signal(false);
  private readonly operationFailed = signal(false);
  protected readonly busy = computed(() => this.pending() || this.relationshipQuery().loading());
  protected readonly failed = computed(() => this.operationFailed() || this.relationshipQuery().error());
  protected readonly sent = signal(false);
  protected readonly Mode = FriendAddVerificationMode;
  protected readonly data = signal({ message: '' });
  protected readonly fields = form(this.data);
  constructor() {
    effect((onCleanup) => {
      if (this.user().uid === this.session.user()?.uid) return;
      onCleanup(this.relationshipQuery().activate());
      untracked(() => void this.load(false));
    });
  }
  protected async load(refreshRelationship = true) {
    this.pending.set(true);
    this.operationFailed.set(false);
    try {
      const [, verification] = await Promise.all([
        refreshRelationship ? this.relationshipQuery().refresh() : undefined,
        firstValueFrom(this.friends.getUserFriendAddInfo(this.user().uid).pipe(takeUntilDestroyed(this.destroy))),
      ]);
      this.verification.set(verification);
    } catch {
      this.operationFailed.set(true);
    } finally {
      this.pending.set(false);
    }
  }
  protected async send() {
    if (this.busy()) return;
    this.pending.set(true);
    this.operationFailed.set(false);
    try {
      await firstValueFrom(
        this.friends.createFriendRequest({ toUid: this.user().uid, message: this.data().message.trim() || undefined }),
      );
      this.sent.set(true);
      this.lists.refreshChats();
      await this.load();
    } catch {
      this.operationFailed.set(true);
    } finally {
      this.pending.set(false);
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
    this.pending.set(true);
    this.operationFailed.set(false);
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
      this.operationFailed.set(true);
    } finally {
      this.pending.set(false);
    }
  }
  protected async chat() {
    const id = this.relationship()?.dmChatId;
    if (!id) return;
    await dismissChatOverlays(this.modals);
    await this.router.navigate(['/chats/chat', decodeId(id)]);
  }
}
