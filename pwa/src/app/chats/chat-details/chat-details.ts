import { dismissChatOverlays } from '../dismiss-chat-overlays';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  chatbubbles,
  searchOutline,
  notificationsOffOutline,
  notificationsOutline,
  exitOutline,
  personRemoveOutline,
  bookmarkOutline,
  peopleOutline,
  linkOutline,
  createOutline,
  personOutline,
  closeOutline,
  ellipsisHorizontal,
} from 'ionicons/icons';
import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { form, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import {
  IonButton,
  IonContent,
  IonList,
  IonItem,
  IonLabel,
  IonIcon,
  IonSpinner,
  IonSelect,
  IonSelectOption,
  ModalController,
  AlertController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { MembersService } from '../../../generated/endpoints/members/members.service';
import {
  GroupKind,
  GroupRole,
  GroupVisibility,
  type GroupInfoResponse,
  type SnowflakeID,
  type MessageResponse,
  type MessagePreview as MessagePreviewData,
  type FriendRelationshipResponse,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { SessionStore } from '../../session/session-store';
import { ChatStore } from '../chat-store';
import { ChatListStore } from '../chat-list-store';
import { ChatMembers } from '../chat-members/chat-members';
import { ChatInvites } from '../chat-invites/chat-invites';
import { UserProfile } from '../user-profile/user-profile';
import { ChatSearch } from '../../conversations/chat-search/chat-search';
import { ChatAttachments } from '../../conversations/chat-attachments/chat-attachments';
import { mediaDimensions, uploadBlob } from '../../messages/upload';
import { ContentScrollbars } from '../../content-scrollbars';
enum DetailAction {
  Load,
  Mute,
  Save,
  Avatar,
  Leave,
}

enum DetailView {
  Info,
  Members,
  Invites,
  Search,
  Edit,
  More,
}
@Component({
  selector: 'app-chat-details',
  templateUrl: './chat-details.html',
  styleUrl: './chat-details.scss',
  imports: [
    ContentScrollbars,
    FormField,
    IonButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonIcon,
    IonSpinner,
    IonSelect,
    IonSelectOption,
    ChatAvatar,
    MessagePreview,
    ChatMembers,
    ChatInvites,
    ChatSearch,
    ChatAttachments,
  ],
  host: { class: 'ion-page' },
})
export class ChatDetails {
  readonly chatId = input.required<SnowflakeID>();
  readonly threadId = input<SnowflakeID>();
  readonly threadRoot = input<MessageResponse | MessagePreviewData>();
  readonly closed = output<void>();
  protected readonly icons = {
    searchOutline,
    notificationsOffOutline,
    notificationsOutline,
    exitOutline,
    personRemoveOutline,
    bookmarkOutline,
    peopleOutline,
    linkOutline,
    createOutline,
    personOutline,
    closeOutline,
    ellipsisHorizontal,
  };
  private readonly friends = inject(FriendsService);
  private readonly destroy = inject(DestroyRef);
  private loadVersion = 0;
  protected readonly relationship = signal<FriendRelationshipResponse | undefined>(undefined);
  protected readonly modals = inject(ModalController);
  private readonly router = inject(Router);
  private readonly api = inject(GroupsService);
  private readonly members = inject(MembersService);
  private readonly session = inject(SessionStore);
  private readonly store = inject(ChatStore);
  private readonly lists = inject(ChatListStore);
  private readonly alerts = inject(AlertController);
  protected readonly chat = signal<GroupInfoResponse | undefined>(undefined);
  protected readonly Action = DetailAction;
  protected readonly pending = signal<DetailAction | undefined>(undefined);
  protected readonly busy = computed(() => this.pending() != null);
  protected readonly error = signal(false);
  protected readonly View = DetailView;
  protected readonly Kind = GroupKind;
  protected readonly Role = GroupRole;
  protected readonly Visibility = GroupVisibility;
  protected readonly view = linkedSignal(() => {
    this.chatId();
    this.threadId();
    return DetailView.Info;
  });
  protected readonly muted = computed(() => {
    const state = this.store.chatState(this.chatId()) ?? this.chat();
    return Date.parse(state?.mutedUntil ?? '') > Date.now();
  });
  protected readonly avatarEntry = computed(() => {
    const chat = this.chat();
    const root = this.threadRoot();
    const isDm = chat?.kind === GroupKind.dm;
    return {
      avatar: isDm ? chat.peer?.avatarUrl : chat?.avatar,
      avatarName: isDm ? chat.peer?.username : chat?.name,
      badgeName: this.threadId() && !isDm && root ? (root.sender.name ?? String(root.sender.uid)) : undefined,
      badgeAvatar: this.threadId() && !isDm ? root?.sender.avatarUrl : undefined,
      badgeIcon: this.threadId() && isDm ? chatbubbles : undefined,
    };
  });
  protected readonly values = signal({ name: '', description: '', visibility: GroupVisibility.private });
  protected readonly fields = form(this.values);
  constructor() {
    effect(() => {
      this.chatId();
      untracked(() => void this.load());
    });
  }
  protected async load() {
    const version = ++this.loadVersion;
    const id = this.chatId();
    this.pending.set(DetailAction.Load);
    this.error.set(false);
    this.chat.set(undefined);
    this.relationship.set(undefined);
    try {
      const chat = await firstValueFrom(this.api.getGroup(id).pipe(takeUntilDestroyed(this.destroy)));
      if (version !== this.loadVersion) return;
      if (chat.peer && chat.peer.uid !== this.session.user()?.uid) {
        const relationship = await firstValueFrom(
          this.friends.getFriendRelationship(chat.peer.uid).pipe(takeUntilDestroyed(this.destroy)),
        );
        if (version !== this.loadVersion) return;
        this.relationship.set(relationship);
      }
      this.chat.set(chat);
      this.values.set({ name: chat.name, description: chat.description || '', visibility: chat.visibility });
    } catch {
      if (version === this.loadVersion && !this.destroy.destroyed) this.error.set(true);
    } finally {
      if (version === this.loadVersion) this.pending.set(undefined);
    }
  }
  protected async toggleMute() {
    if (this.busy()) return;
    this.pending.set(DetailAction.Mute);
    this.error.set(false);
    try {
      await this.store.setMuted(this.chatId(), !this.muted());
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected async save() {
    this.pending.set(DetailAction.Save);
    this.error.set(false);
    try {
      const updated = await firstValueFrom(this.api.patchGroup(this.chatId(), this.values()));
      this.chat.set(updated);
      this.store.invalidate();
      await this.store.ensureDetails(this.chatId());
      this.lists.refreshChats();
      this.view.set(DetailView.Info);
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected async avatar(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const chatId = this.chatId();
    this.pending.set(DetailAction.Avatar);
    this.error.set(false);
    try {
      const dimensions = await mediaDimensions(file);
      const upload = await firstValueFrom(
        this.api.postAvatarUploadUrl(chatId, {
          filename: file.name,
          contentType: file.type,
          size: file.size,
          ...dimensions,
        }),
      );
      await uploadBlob(upload.uploadUrl, file, upload.uploadHeaders);
      this.chat.set(await firstValueFrom(this.api.patchGroup(chatId, { avatarImageId: upload.imageId })));
      this.store.invalidate();
      await this.store.ensureDetails(this.chatId());
      this.lists.refreshChats();
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected async leave() {
    const chat = this.chat()!;
    const isDm = chat.kind === GroupKind.dm;
    const alert = await this.alerts.create({
      header: isDm ? '删除好友' : '退出群组',
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: isDm ? '删除' : '退出', role: 'confirm' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') return;
    this.pending.set(DetailAction.Leave);
    try {
      await firstValueFrom(
        isDm
          ? this.friends.deleteFriend(chat.peer!.uid)
          : this.members.deleteRemoveMember(chat.id, this.session.user()!.uid),
      );
      this.lists.refreshChats();
      await dismissChatOverlays(this.modals);
      await this.router.navigate(['/chats']);
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected async profile() {
    const user = this.chat()?.peer;
    if (!user) return;
    const modal = await this.modals.create({ component: UserProfile, componentProps: { user } });
    await modal.present();
  }
  protected async saved() {
    await dismissChatOverlays(this.modals);
    await this.router.navigate(['/chats/chat', decodeId(this.chatId()), 'saved']);
  }
}
