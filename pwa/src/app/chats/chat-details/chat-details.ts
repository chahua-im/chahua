import { MembershipMessageVisibility } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { Connection } from '../../api/connection';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { form, FormField } from '@angular/forms/signals';
import { Router } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonLabel,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  ModalController,
  IonToast,
} from '@ionic/angular';
import {
  archive,
  archiveOutline,
  closeOutline,
  createOutline,
  cameraOutline,
  checkmarkOutline,
  exitOutline,
  linkOutline,
  personAddOutline,
  chatbubbleOutline,
  chevronBackOutline,
  globeOutline,
  banOutline,
  personRemoveOutline,
  notificationsOutline,
} from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { BlocksService } from '../../../generated/endpoints/blocks/blocks.service';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { MembersService } from '../../../generated/endpoints/members/members.service';
import {
  ChatAttachmentKindFilter,
  FriendAddVerificationMode,
  FriendPresenceOverride,
  FriendReadReceiptOverride,
  type MemberSummary,
  GroupKind,
  GroupRole,
  SpeakingMode,
  type MessagePreview as MessagePreviewData,
  type MessageResponse,
  type SnowflakeID,
} from '../../../generated/models';
import { mediaDimensions } from '../../messages/media-processing/prepare-media';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { ThreadParticipants } from '../thread-participants/thread-participants';
import { uploadBlob } from '../../messages/upload';
import { UploadProgress } from '../../messages/upload-progress/upload-progress';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { Presence } from '../../presence/presence';
import { LoadError } from '../../ui/load-error/load-error';
import { ChatAttachments } from '../chat-attachments/chat-attachments';
import { ChatAvatar, conversationAvatar } from '../chat-avatar/chat-avatar';
import { ChatInvites } from '../chat-invites/chat-invites';
import { ChatListStore } from '../chat-list-store';
import { ChatMembers } from '../chat-members/chat-members';
import { ChatStore } from '../chat-store';
import { SpeakingModeSelect } from '../speaking-mode-select';
import { ChatThreads } from '../chat-threads/chat-threads';
import { GroupPresenceDisplay, UserPresenceDisplay } from '../../presence/presence-display';
import { dismissChatOverlays } from '../dismiss-chat-overlays';
enum DetailAction {
  MembershipVisibility,
  Thread,
  Name,
  Description,
  Avatar,
  Leave,
  AddFriend,
  Presence,
  ReadReceipt,
  Block,
  Speaking,
}

enum GroupField {
  Name = 'name',
  Description = 'description',
}

enum InfoTab {
  Threads = 'threads',
  Members = 'members',
}
type ContentTab = ChatAttachmentKindFilter | InfoTab;

export enum DetailView {
  Info,
  Invites,
}
@Component({
  selector: 'app-chat-details',
  templateUrl: './chat-details.html',
  styleUrl: './chat-details.scss',
  // Nested messages and member lists can open these same details again.
  imports: [
    ContentScrollbars,
    FormField,
    LoadError,
    IonItem,
    IonButton,
    IonNote,
    IonContent,
    IonLabel,
    IonIcon,
    IonSelect,
    IonSelectOption,
    IonSpinner,
    IonToast,
    IonSegment,
    IonSegmentButton,
    ChatAvatar,
    GroupPresenceDisplay,
    UserPresenceDisplay,
    UploadProgress,
    MessagePreview,
    ChatMembers,
    ThreadParticipants,
    ChatThreads,
    ChatInvites,
    ChatAttachments,
    TranslocoPipe,
    SpeakingModeSelect,
  ],
  host: { class: 'ion-page' },
})
export class ChatDetails {
  readonly chatId = input<SnowflakeID>();
  readonly asModal = input(false);
  readonly view = input(DetailView.Info);
  readonly user = input<MemberSummary>();
  readonly currentConversation = input(false);
  readonly threadId = input<SnowflakeID>();
  readonly threadRoot = input<MessageResponse | MessagePreviewData>();
  readonly messages = input<readonly MessageResponse[]>([]);
  readonly closed = output<void>();
  protected readonly icons = {
    archive,
    archiveOutline,
    notificationsOutline,
    exitOutline,
    personRemoveOutline,
    linkOutline,
    createOutline,
    personAddOutline,
    chatbubbleOutline,
    chevronBackOutline,
    globeOutline,
    banOutline,
    closeOutline,
    cameraOutline,
    checkmarkOutline,
  };
  private readonly friends = inject(FriendsService);
  private readonly destroy = inject(DestroyRef);
  private loadVersion = 0;
  private presenceSettingsVersion = 0;
  private receiptSettingsVersion = 0;
  private readonly peer = computed(() => {
    const chat = this.chatId() ? this.store.get(this.chatId()!) : undefined;
    return this.user() ?? (chat?.kind === GroupKind.dm ? chat.peer : undefined);
  });
  protected readonly relationshipQuery = computed(() => {
    const uid = this.peer()?.uid;
    return uid && uid !== this.session.user()?.uid ? this.store.relationship(uid) : undefined;
  });
  protected readonly relationship = computed(() => this.relationshipQuery()?.value());
  protected readonly id = computed(() => this.chatId() ?? this.relationship()?.dmChatId);
  protected readonly person = computed(() => (!this.threadId() ? this.peer() : undefined));
  protected readonly otherUser = computed(() => this.person() && this.person()!.uid !== this.session.user()?.uid);
  private readonly presenceSettingsUid = computed(() => {
    const person = this.person();
    return person && this.otherUser() && this.relationship()?.isFriend ? person.uid : undefined;
  });
  private readonly blocks = inject(BlocksService);
  private readonly navigation = inject(ConversationNavigation);
  protected readonly modals = inject(ModalController);
  private readonly router = inject(Router);
  private readonly api = inject(GroupsService);
  private readonly members = inject(MembersService);
  private readonly session = inject(SessionStore);
  private readonly presence = inject(Presence);
  private readonly store = inject(ChatStore);
  private readonly lists = inject(ChatListStore);
  private readonly alerts = inject(AlertController);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  protected readonly chat = computed(() => (this.id() ? this.store.get(this.id()!) : undefined));
  protected readonly speakingMode = linkedSignal(() => this.chat()?.speakingMode);
  protected async saveSpeakingMode(mode: SpeakingMode | undefined) {
    if (!mode || !this.canManage() || this.busy()) return;
    const scope = this.scope();
    this.speakingMode.set(mode);
    await this.perform(DetailAction.Speaking, () => this.store.setSpeakingMode(this.id()!, mode), true);
    if (this.isCurrent(scope)) this.speakingMode.set(this.chat()?.speakingMode);
  }
  protected readonly loading = signal(false);
  protected readonly PresenceOverride = FriendPresenceOverride;
  protected readonly presenceOverride = linkedSignal({
    source: this.presenceSettingsUid,
    computation: (): FriendPresenceOverride | undefined => undefined,
  });
  protected readonly presenceOverrideLoading = linkedSignal({
    source: this.presenceSettingsUid,
    computation: () => false,
  });
  protected readonly presenceOverrideError = linkedSignal({
    source: this.presenceSettingsUid,
    computation: () => false,
  });
  protected readonly ReceiptOverride = FriendReadReceiptOverride;
  protected readonly receiptOverride = linkedSignal({
    source: this.presenceSettingsUid,
    computation: (): FriendReadReceiptOverride | undefined => undefined,
  });
  protected readonly receiptOverrideLoading = linkedSignal({
    source: this.presenceSettingsUid,
    computation: () => false,
  });
  protected readonly receiptOverrideError = linkedSignal({
    source: this.presenceSettingsUid,
    computation: () => false,
  });
  protected readonly Action = DetailAction;
  protected readonly MembershipVisibility = MembershipMessageVisibility;
  protected readonly membershipVisibility = linkedSignal(() => {
    const id = this.id();
    return id ? this.store.membershipPolicy(id)?.visibility : undefined;
  });

  protected async saveMembershipVisibility(value: unknown) {
    if (
      !this.canManage() ||
      this.busy() ||
      !Object.values(MembershipMessageVisibility).includes(value as MembershipMessageVisibility)
    )
      return;
    const visibility = value as MembershipMessageVisibility;
    if (visibility === this.membershipVisibility()) return;
    const chatId = this.id()!;
    const scope = this.scope();
    const account = this.session.user()?.uid;
    const previous = this.membershipVisibility();
    this.membershipVisibility.set(visibility);
    await this.perform(
      DetailAction.MembershipVisibility,
      async () => {
        await firstValueFrom(this.api.patchGroup(chatId, { membershipMessageVisibility: visibility }));
        if (account === this.session.user()?.uid) await this.store.refreshMembershipPolicy(chatId);
      },
      true,
    );
    if (account === this.session.user()?.uid && this.isCurrent(scope))
      this.membershipVisibility.set(this.store.membershipPolicy(chatId)?.visibility ?? previous);
  }

  private readonly scope = computed(() => ({
    chatId: this.chatId(),
    threadId: this.threadId(),
    uid: this.user()?.uid,
  }));
  protected readonly pending = linkedSignal({
    source: this.scope,
    computation: (): DetailAction | undefined => undefined,
  });
  protected readonly busy = computed(() => this.pending() != null);
  protected readonly error = linkedSignal({ source: this.scope, computation: () => false });
  protected readonly View = DetailView;
  protected readonly Kind = GroupKind;
  protected readonly Field = GroupField;
  protected readonly canManage = computed(
    () => !this.threadId() && this.chat()?.kind === GroupKind.group && this.chat()?.myRole === GroupRole.admin,
  );
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
  private readonly saveError = viewChild.required<IonToast>('saveError');
  protected readonly subscription = computed(() => {
    const root = this.threadId();
    return root ? this.store.subscription(this.id()!, root) : undefined;
  });
  protected readonly cachedSubscription = computed(() => {
    const root = this.threadId();
    return root ? this.store.cachedSubscription(this.id()!, root) : undefined;
  });
  protected readonly avatarEntry = computed(() =>
    conversationAvatar(
      this.chat() ?? (this.person() ? { kind: GroupKind.dm, peer: this.person() } : undefined),
      this.threadRoot(),
      !!this.threadId(),
    ),
  );
  protected readonly edits = linkedSignal({
    source: this.scope,
    computation: (): Record<GroupField, { value: string } | undefined> => ({ name: undefined, description: undefined }),
  });
  protected readonly fields = form(this.edits);
  protected readonly avatarProgress = linkedSignal({ source: this.scope, computation: () => 0 });
  constructor() {
    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
    effect((onCleanup) => {
      const query = this.relationshipQuery();
      if (query) onCleanup(query.activate());
    });
    effect(() => {
      const uid = this.presenceSettingsUid();
      if (uid == null) {
        this.presenceSettingsVersion++;
        return;
      }
      untracked(() => void this.loadFriendPresenceSettings());
    });
    effect(() => {
      const uid = this.presenceSettingsUid();
      if (uid == null) {
        this.receiptSettingsVersion++;
        return;
      }
      untracked(() => void this.loadFriendReadReceiptSettings());
    });
    effect(() => {
      const scope = this.scope();
      const root = scope.threadId;
      if (root && !this.subscription())
        untracked(
          () =>
            void this.store.loadSubscription(scope.chatId!, root).catch(() => {
              if (this.isCurrent(scope)) this.error.set(true);
            }),
        );
    });
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }
  protected async load() {
    const version = ++this.loadVersion;
    const id = this.id();
    if (!id) return;
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
  protected async loadFriendPresenceSettings() {
    const uid = this.presenceSettingsUid();
    if (uid == null) return;
    const version = ++this.presenceSettingsVersion;
    this.presenceOverrideLoading.set(true);
    this.presenceOverrideError.set(false);
    try {
      const settings = await firstValueFrom(this.friends.getFriendPresenceSettings(uid));
      if (version === this.presenceSettingsVersion && uid === this.presenceSettingsUid() && !this.destroy.destroyed)
        this.presenceOverride.set(settings.override);
    } catch {
      if (version === this.presenceSettingsVersion && uid === this.presenceSettingsUid() && !this.destroy.destroyed)
        this.presenceOverrideError.set(true);
    } finally {
      if (version === this.presenceSettingsVersion && uid === this.presenceSettingsUid())
        this.presenceOverrideLoading.set(false);
    }
  }

  protected async loadFriendReadReceiptSettings() {
    const uid = this.presenceSettingsUid();
    if (uid == null) return;
    const version = ++this.receiptSettingsVersion;
    this.receiptOverrideLoading.set(true);
    this.receiptOverrideError.set(false);
    try {
      const settings = await firstValueFrom(this.friends.getFriendReadReceiptSettings(uid));
      if (version === this.receiptSettingsVersion && uid === this.presenceSettingsUid() && !this.destroy.destroyed)
        this.receiptOverride.set(settings.override);
    } catch {
      if (version === this.receiptSettingsVersion && uid === this.presenceSettingsUid() && !this.destroy.destroyed)
        this.receiptOverrideError.set(true);
    } finally {
      if (version === this.receiptSettingsVersion && uid === this.presenceSettingsUid())
        this.receiptOverrideLoading.set(false);
    }
  }

  protected async saveFriendReadReceiptOverride(value: unknown) {
    if (
      this.busy() ||
      this.receiptOverrideLoading() ||
      !Object.values(FriendReadReceiptOverride).includes(value as FriendReadReceiptOverride)
    )
      return;
    const uid = this.presenceSettingsUid();
    if (uid == null) return;
    const override = value as FriendReadReceiptOverride;
    const previous = this.receiptOverride();
    if (override === previous) return;
    this.receiptOverride.set(override);
    const scope = this.scope();
    const saved = await this.perform(
      DetailAction.ReadReceipt,
      async () => {
        const settings = await firstValueFrom(this.friends.updateFriendReadReceiptSettings(uid, { override }));
        this.store.invalidateReadReceiptPrivacy(uid);
        if (this.isCurrent(scope) && uid === this.presenceSettingsUid()) this.receiptOverride.set(settings.override);
      },
      true,
    );
    if (!saved && this.isCurrent(scope) && uid === this.presenceSettingsUid()) this.receiptOverride.set(previous);
  }

  protected async saveFriendPresenceOverride(value: unknown) {
    if (
      this.busy() ||
      this.presenceOverrideLoading() ||
      !Object.values(FriendPresenceOverride).includes(value as FriendPresenceOverride)
    )
      return;
    const uid = this.presenceSettingsUid();
    if (uid == null) return;
    const override = value as FriendPresenceOverride;
    const previous = this.presenceOverride();
    if (override === previous) return;
    this.presenceOverride.set(override);
    const scope = this.scope();
    const saved = await this.perform(
      DetailAction.Presence,
      async () => {
        const settings = await firstValueFrom(this.friends.updateFriendPresenceSettings(uid, { override }));
        this.presence.invalidateUsers([uid]);
        if (this.isCurrent(scope) && uid === this.presenceSettingsUid()) this.presenceOverride.set(settings.override);
      },
      true,
    );
    if (!saved && this.isCurrent(scope) && uid === this.presenceSettingsUid()) this.presenceOverride.set(previous);
  }

  protected edit(field: GroupField) {
    if (!this.canManage() || this.busy()) return;
    this.edits.update((edits) => ({ ...edits, [field]: { value: this.chat()?.[field] ?? '' } }));
    afterNextRender(() => this.fields[field]?.value().focusBoundControl(), { injector: this.injector });
  }
  protected cancelEdit(field: GroupField) {
    this.edits.update((edits) => ({ ...edits, [field]: undefined }));
  }
  protected editKeydown(event: KeyboardEvent, field: GroupField) {
    if (event.isComposing || this.busy()) return;
    if (event.key === 'Escape') this.cancelEdit(field);
    else if (event.key === 'Enter' && field === GroupField.Name) {
      event.preventDefault();
      void this.save(field);
    }
  }
  private isCurrent(scope: ReturnType<typeof this.scope>) {
    return !this.destroy.destroyed && scope === this.scope();
  }

  private async perform(action: DetailAction, operation: () => Promise<unknown>, notifyError = false) {
    if (this.busy()) return false;
    const scope = this.scope();
    this.pending.set(action);
    this.error.set(false);
    try {
      await operation();
      return this.isCurrent(scope);
    } catch {
      if (this.isCurrent(scope)) {
        if (notifyError) await this.saveError().present();
        else this.error.set(true);
      }
      return false;
    } finally {
      if (this.isCurrent(scope)) this.pending.set(undefined);
    }
  }

  protected updateThread() {
    const status = this.subscription();
    if (!status) return;
    return this.perform(DetailAction.Thread, () =>
      status.subscribed
        ? this.store.setThreadArchived(this.id()!, this.threadId()!, !status.archived)
        : this.store.subscribeThread(this.id()!, this.threadId()!),
    );
  }
  private async refreshDetails(chatId: SnowflakeID) {
    this.store.invalidate();
    await this.store.ensureDetails(chatId);
    this.lists.refreshChats();
  }
  protected async save(field: GroupField) {
    if (!this.canManage() || this.busy()) return;
    const value = this.edits()[field]?.value;
    if (value == null || (field === GroupField.Name && !value.trim())) return;
    const chatId = this.id()!;
    if (value === (this.chat()?.[field] ?? '')) {
      this.cancelEdit(field);
      return;
    }
    if (
      await this.perform(
        field === GroupField.Name ? DetailAction.Name : DetailAction.Description,
        async () => {
          await firstValueFrom(this.api.patchGroup(chatId, { [field]: value }));
          await this.refreshDetails(chatId);
        },
        true,
      )
    )
      this.cancelEdit(field);
  }
  protected avatar(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.canManage() || this.busy()) return;
    const chatId = this.id()!;
    const scope = this.scope();
    this.avatarProgress.set(0);
    return this.perform(
      DetailAction.Avatar,
      async () => {
        const dimensions = await mediaDimensions(file);
        const upload = await firstValueFrom(
          this.api.postAvatarUploadUrl(chatId, {
            filename: file.name,
            contentType: file.type,
            size: file.size,
            ...dimensions,
          }),
        );
        await uploadBlob(upload.uploadUrl, file, upload.uploadHeaders, undefined, (value) => {
          if (this.isCurrent(scope)) this.avatarProgress.set(value);
        });
        await firstValueFrom(this.api.patchGroup(chatId, { avatarImageId: upload.imageId }));
        await this.refreshDetails(chatId);
      },
      true,
    );
  }
  protected async leave() {
    if (this.busy()) return;
    const scope = this.scope();
    const chatId = this.id()!;
    const person = this.person();
    const isDm = !!person;
    const alert = await this.alerts.create({
      header: this.transloco.translate(isDm ? 'chats.details.leaveDmTitle' : 'chats.details.leaveGroupTitle'),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        {
          text: this.transloco.translate(isDm ? 'chats.details.leaveDmAction' : 'chats.details.leaveGroupAction'),
          role: 'confirm',
        },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm' || !this.isCurrent(scope)) return;
    if (
      await this.perform(DetailAction.Leave, async () => {
        await firstValueFrom(
          isDm
            ? this.friends.deleteFriend(person!.uid)
            : this.members.deleteRemoveMember(chatId, this.session.user()!.uid),
        );
        if (isDm) this.store.invalidateReadReceiptPrivacy(person!.uid);
        this.lists.refreshChats();
        if (person) await this.store.relationship(person.uid).refresh();
      })
    ) {
      if (!this.user()) {
        await dismissChatOverlays(this.modals);
        await this.router.navigate(['/chats']);
      }
    }
  }
  protected invites() {
    return this.router.navigate(['/chats/chat', decodeId(this.id()!), 'invites']);
  }

  protected close() {
    this.closed.emit();
    if (this.user() || this.asModal()) void this.modals.dismiss();
  }
  protected messageUser() {
    const id = this.id();
    if (id) return this.navigation.open(id);
    return Promise.resolve();
  }
  protected async addFriend() {
    const user = this.person();
    if (!user || !this.relationship() || this.busy()) return;
    const scope = this.scope();
    await this.perform(DetailAction.AddFriend, async () => {
      const relation = this.relationship()!;
      const info = await firstValueFrom(
        this.friends.getUserFriendAddInfo(user.uid).pipe(takeUntilDestroyed(this.destroy)),
      );
      if (!this.isCurrent(scope)) return;
      const unavailable = relation.hasPendingOutgoingRequest
        ? this.transloco.translate('chats.content.friendRequestSent')
        : relation.blocking
          ? this.transloco.translate('chats.details.blockedFirst')
          : relation.blockedBy || info.mode === FriendAddVerificationMode.forbid
            ? this.transloco.translate('chats.details.notAccepting')
            : undefined;
      const needsMessage = !unavailable && info.mode !== FriendAddVerificationMode.direct;
      const alert = await this.alerts.create({
        header: unavailable ?? this.transloco.translate('chats.details.addFriend'),
        message: needsMessage
          ? (info.question ?? this.transloco.translate('chats.details.verificationMessage'))
          : undefined,
        inputs: needsMessage
          ? [
              {
                name: 'message',
                type: 'text',
                placeholder: this.transloco.translate('chats.details.verificationPlaceholder'),
              },
            ]
          : [],
        buttons: unavailable
          ? [{ text: this.transloco.translate('common.okay'), role: 'cancel' }]
          : [
              { text: this.transloco.translate('common.cancel'), role: 'cancel' },
              { text: this.transloco.translate('common.add'), role: 'confirm' },
            ],
      });
      await alert.present();
      const result = await alert.onDidDismiss<{ values?: { message?: string } }>();
      if (result.role !== 'confirm' || !this.isCurrent(scope)) return;
      await firstValueFrom(
        this.friends.createFriendRequest({
          toUid: user.uid,
          message: result.data?.values?.message?.trim() || undefined,
        }),
      );
      this.lists.refreshChats();
      await this.store.relationship(user.uid).refresh();
    });
  }
  protected async blockUser() {
    const user = this.person();
    if (!user || !this.relationship() || this.busy()) return;
    const scope = this.scope();
    const blocking = this.relationship()!.blocking;
    const alert = await this.alerts.create({
      header: this.transloco.translate(blocking ? 'chats.details.unblockTitle' : 'chats.details.blockTitle'),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('common.confirm'), role: 'confirm' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm' || !this.isCurrent(scope)) return;
    await this.perform(DetailAction.Block, async () => {
      await firstValueFrom(blocking ? this.blocks.unblockUser(user.uid) : this.blocks.blockUser({ uid: user.uid }));
      this.store.invalidateReadReceiptPrivacy(user.uid);
      this.lists.refreshChats();
      await this.store.relationship(user.uid).refresh();
    });
  }
}
