import { DatePipe } from '@angular/common';
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
  viewChild,
} from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  ModalController,
} from '@ionic/angular';
import {
  archiveOutline,
  bookmarkOutline,
  chatbubbles,
  closeOutline,
  createOutline,
  ellipsisHorizontal,
  exitOutline,
  linkOutline,
  notificationsOffOutline,
  notificationsOutline,
  personOutline,
  personRemoveOutline,
  searchOutline,
  star,
  starOutline,
} from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { MembersService } from '../../../generated/endpoints/members/members.service';
import {
  ChatAttachmentKindFilter,
  GroupKind,
  GroupRole,
  GroupVisibility,
  type MessagePreview as MessagePreviewData,
  type MessageResponse,
  type SnowflakeID,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { mediaDimensions } from '../../messages/media-processing/prepare-media';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { uploadBlob } from '../../messages/upload';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { ChatAttachments } from '../chat-attachments/chat-attachments';
import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { ChatInvites } from '../chat-invites/chat-invites';
import { ChatListStore } from '../chat-list-store';
import { ChatMembers } from '../chat-members/chat-members';
import { ChatMute } from '../chat-mute/chat-mute';
import { ChatSearch } from '../chat-search/chat-search';
import { ChatStore } from '../chat-store';
import { ChatThreads } from '../chat-threads/chat-threads';
import { dismissChatOverlays } from '../dismiss-chat-overlays';
import { UserProfile } from '../user-profile/user-profile';
enum DetailAction {
  Mute,
  Subscription,
  Archive,
  Save,
  Avatar,
  Leave,
}

enum GroupTab {
  Threads = 'threads',
  Members = 'members',
}
type ContentTab = ChatAttachmentKindFilter | GroupTab;

enum DetailView {
  Info,
  Invites,
  Search,
  Edit,
}
@Component({
  selector: 'app-chat-details',
  templateUrl: './chat-details.html',
  styleUrl: './chat-details.scss',
  imports: [
    DatePipe,
    ChatMute,
    ContentScrollbars,
    FormField,
    IonButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonIcon,
    IonSpinner,
    IonPopover,
    IonSelect,
    IonSegment,
    IonSegmentButton,
    IonSelectOption,
    ChatAvatar,
    MessagePreview,
    ChatMembers,
    ChatThreads,
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
    archiveOutline,
    starOutline,
    star,
    searchOutline,
    notificationsOffOutline,
    notificationsOutline,
    exitOutline,
    personRemoveOutline,
    bookmarkOutline,
    linkOutline,
    createOutline,
    personOutline,
    closeOutline,
    ellipsisHorizontal,
  };
  private readonly friends = inject(FriendsService);
  private readonly destroy = inject(DestroyRef);
  private loadVersion = 0;
  private readonly peerUid = computed(() => this.chat()?.peer?.uid);
  protected readonly relationship = computed(() => {
    const uid = this.peerUid();
    return uid ? this.store.relationship(uid).value() : undefined;
  });
  protected readonly modals = inject(ModalController);
  private readonly router = inject(Router);
  private readonly api = inject(GroupsService);
  private readonly members = inject(MembersService);
  private readonly session = inject(SessionStore);
  private readonly store = inject(ChatStore);
  private readonly lists = inject(ChatListStore);
  private readonly alerts = inject(AlertController);
  protected readonly chat = computed(() => this.store.get(this.chatId()));
  protected readonly loading = signal(false);
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
  protected readonly GroupTab = GroupTab;
  protected readonly AttachmentKind = ChatAttachmentKindFilter;
  protected readonly tab = linkedSignal<ContentTab>(() => {
    this.chatId();
    return this.threadId() ? ChatAttachmentKindFilter.image : GroupTab.Threads;
  });
  protected changeTab(value: unknown) {
    if (
      Object.values(GroupTab).includes(value as GroupTab) ||
      Object.values(ChatAttachmentKindFilter).includes(value as ChatAttachmentKindFilter)
    )
      this.tab.set(value as ContentTab);
  }
  private readonly muteMenu = viewChild.required(ChatMute);
  protected readonly muted = computed(() => this.store.isMuted(this.chatId()));
  protected readonly mutedUntil = computed(() => (this.muted() ? this.store.mutedUntil(this.chatId()) : undefined));
  protected readonly permanentMute = computed(() => (this.mutedUntil() ?? '').startsWith('9999'));
  protected readonly archived = computed(() => this.store.chatState(this.chatId())?.archived ?? false);
  protected readonly subscription = computed(() => {
    const root = this.threadId();
    return root ? this.store.subscription(this.chatId(), root) : undefined;
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
    effect((onCleanup) => {
      const uid = this.peerUid();
      if (uid && uid !== this.session.user()?.uid) onCleanup(this.store.relationship(uid).activate());
    });
    effect(() => {
      const root = this.threadId();
      if (root && !this.subscription())
        untracked(() => void this.store.loadSubscription(this.chatId(), root).catch(() => this.error.set(true)));
    });
    effect(() => {
      this.chatId();
      untracked(() => void this.load());
    });
  }
  protected async load() {
    const version = ++this.loadVersion;
    const id = this.chatId();
    this.loading.set(true);
    this.error.set(false);
    try {
      await this.store.ensureDetails(id);
    } catch {
      if (version === this.loadVersion && !this.destroy.destroyed) this.error.set(true);
    } finally {
      if (version === this.loadVersion) this.loading.set(false);
    }
  }
  protected edit() {
    const chat = this.chat()!;
    this.values.set({
      name: chat.name ?? '',
      description: chat.description ?? '',
      visibility: chat.visibility ?? GroupVisibility.private,
    });
    this.view.set(DetailView.Edit);
  }
  protected async toggleMute() {
    if (this.busy()) return;
    this.pending.set(DetailAction.Mute);
    this.error.set(false);
    try {
      await this.muteMenu().toggle(this.chatId());
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected async toggleSubscription() {
    if (this.busy() || !this.subscription()) return;
    this.pending.set(DetailAction.Subscription);
    this.error.set(false);
    try {
      if (this.subscription()!.subscribed) await this.store.unsubscribeThread(this.chatId(), this.threadId()!);
      else await this.store.subscribeThread(this.chatId(), this.threadId()!);
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected async toggleThreadArchive() {
    if (this.busy() || !this.subscription()) return;
    this.pending.set(DetailAction.Archive);
    this.error.set(false);
    try {
      await this.store.setThreadArchived(this.chatId(), this.threadId()!, !this.subscription()!.archived);
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
      await firstValueFrom(this.api.patchGroup(this.chatId(), this.values()));
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
      await firstValueFrom(this.api.patchGroup(chatId, { avatarImageId: upload.imageId }));
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
    const chatId = this.chatId();
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
          : this.members.deleteRemoveMember(chatId, this.session.user()!.uid),
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
