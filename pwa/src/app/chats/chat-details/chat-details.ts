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
  archive,
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
import { mediaDimensions } from '../../messages/media-processing/prepare-media';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { SavedMessageList } from '../../messages/saved-message-list/saved-message-list';
import { ThreadParticipants } from '../thread-participants/thread-participants';
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
  Thread,
  Save,
  Avatar,
  Leave,
}

enum InfoTab {
  Threads = 'threads',
  Members = 'members',
  Saved = 'saved',
}
type ContentTab = ChatAttachmentKindFilter | InfoTab;

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
    ThreadParticipants,
    SavedMessageList,
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
  readonly messages = input<readonly MessageResponse[]>([]);
  readonly closed = output<void>();
  protected readonly icons = {
    archive,
    archiveOutline,
    starOutline,
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
  private readonly scope = computed(() => ({ chatId: this.chatId(), threadId: this.threadId() }));
  protected readonly pending = linkedSignal({
    source: this.scope,
    computation: (): DetailAction | undefined => undefined,
  });
  protected readonly busy = computed(() => this.pending() != null);
  protected readonly error = linkedSignal({ source: this.scope, computation: () => false });
  protected readonly View = DetailView;
  protected readonly Kind = GroupKind;
  protected readonly Role = GroupRole;
  protected readonly Visibility = GroupVisibility;
  protected readonly view = linkedSignal({ source: this.scope, computation: () => DetailView.Info });
  protected readonly InfoTab = InfoTab;
  protected readonly AttachmentKind = ChatAttachmentKindFilter;
  protected readonly tab = linkedSignal<ContentTab>(() => {
    this.chatId();
    return this.threadId() ? InfoTab.Members : InfoTab.Threads;
  });
  protected changeTab(value: unknown) {
    if (
      Object.values(InfoTab).includes(value as InfoTab) ||
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
  protected readonly cachedSubscription = computed(() => {
    const root = this.threadId();
    return root ? this.store.cachedSubscription(this.chatId(), root) : undefined;
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
      const scope = this.scope();
      const root = scope.threadId;
      if (root && !this.subscription())
        untracked(
          () =>
            void this.store.loadSubscription(scope.chatId, root).catch(() => {
              if (this.isCurrent(scope)) this.error.set(true);
            }),
        );
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
  private isCurrent(scope: ReturnType<typeof this.scope>) {
    return !this.destroy.destroyed && scope === this.scope();
  }

  private async perform(action: DetailAction, operation: () => Promise<unknown>) {
    if (this.busy()) return false;
    const scope = this.scope();
    this.pending.set(action);
    this.error.set(false);
    try {
      await operation();
      return this.isCurrent(scope);
    } catch {
      if (this.isCurrent(scope)) this.error.set(true);
      return false;
    } finally {
      if (this.isCurrent(scope)) this.pending.set(undefined);
    }
  }

  protected toggleMute() {
    return this.perform(DetailAction.Mute, () => this.muteMenu().toggle(this.chatId()));
  }
  protected updateThread() {
    const status = this.subscription();
    if (!status) return;
    return this.perform(DetailAction.Thread, () =>
      status.subscribed
        ? this.store.setThreadArchived(this.chatId(), this.threadId()!, !status.archived)
        : this.store.subscribeThread(this.chatId(), this.threadId()!),
    );
  }
  private async refreshDetails(chatId: SnowflakeID) {
    this.store.invalidate();
    await this.store.ensureDetails(chatId);
    this.lists.refreshChats();
  }
  protected async save() {
    const chatId = this.chatId();
    if (
      await this.perform(DetailAction.Save, async () => {
        await firstValueFrom(this.api.patchGroup(chatId, this.values()));
        await this.refreshDetails(chatId);
      })
    )
      this.view.set(DetailView.Info);
  }
  protected avatar(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const chatId = this.chatId();
    return this.perform(DetailAction.Avatar, async () => {
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
      await this.refreshDetails(chatId);
    });
  }
  protected async leave() {
    if (this.busy()) return;
    const scope = this.scope();
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
    if ((await alert.onDidDismiss()).role !== 'confirm' || !this.isCurrent(scope)) return;
    if (
      await this.perform(DetailAction.Leave, async () => {
        await firstValueFrom(
          isDm
            ? this.friends.deleteFriend(chat.peer!.uid)
            : this.members.deleteRemoveMember(chatId, this.session.user()!.uid),
        );
        this.lists.refreshChats();
      })
    ) {
      await dismissChatOverlays(this.modals);
      await this.router.navigate(['/chats']);
    }
  }
  protected async profile() {
    const user = this.chat()?.peer;
    if (!user) return;
    const modal = await this.modals.create({ component: UserProfile, componentProps: { user } });
    await modal.present();
  }
}
