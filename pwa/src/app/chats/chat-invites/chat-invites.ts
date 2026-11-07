import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { disabled, form, FormField } from '@angular/forms/signals';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LocalDatePipe } from '../../i18n/local-date.pipe';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonToast,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { copyOutline, linkOutline, paperPlaneOutline, trashOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import {
  InviteType,
  GroupKind,
  type MemberSummary,
  type SpeakingMode,
  type InviteResponse,
  type SnowflakeID,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { copyText } from '../../api/clipboard';
import { inviteStatus, InviteStatus } from '../invite';
import { ChatStore } from '../chat-store';
import { SpeakingAction, speakingErrorMode } from '../speaking';
import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { ChatPicker, ChatPickerScope, type ChatPickerTarget, type ChooseChat } from '../chat-picker/chat-picker';

enum InvitePicker {
  User,
  GroupCondition,
  Destination,
}

enum InviteAction {
  Create,
  Share,
  Revoke,
}
enum Expiry {
  Day = 'day',
  Week = 'week',
  Never = 'never',
  Custom = 'custom',
}
interface InviteList {
  rows: InviteResponse[];
  cursor?: string;
  loading: boolean;
  loaded: boolean;
  error: boolean;
  failedMore: boolean;
}
const emptyList = (): InviteList => ({ rows: [], loading: false, loaded: false, error: false, failedMore: false });

@Component({
  selector: 'app-chat-invites',
  templateUrl: './chat-invites.html',
  styleUrl: './chat-invites.scss',
  imports: [
    ContentScrollbars,
    LocalDatePipe,
    FormField,
    ChatAvatar,
    ChatPicker,
    IonIcon,
    IonList,
    IonNote,
    IonToast,
    IonItem,
    IonLabel,
    IonButton,
    IonButtons,
    IonSpinner,
    IonSelect,
    IonSelectOption,
    IonModal,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    TranslocoPipe,
  ],
})
export class ChatInvites {
  readonly chatId = input.required<SnowflakeID>();
  private readonly api = inject(RpcApi);
  private readonly store = inject(ChatStore);
  private readonly destroy = inject(DestroyRef);
  private readonly alerts = inject(AlertController);
  protected readonly icons = { copyOutline, linkOutline, paperPlaneOutline, trashOutline };
  private readonly transloco = inject(TranslocoService);
  protected readonly decodeId = decodeId;
  protected readonly Type = InviteType;
  protected readonly Action = InviteAction;
  protected readonly Status = InviteStatus;
  protected readonly Expiry = Expiry;
  protected readonly Picker = InvitePicker;
  protected readonly PickerScope = ChatPickerScope;
  protected readonly picker = signal<InvitePicker | undefined>(undefined);
  protected readonly editorReady = signal(false);
  protected readonly chooseChat: ChooseChat = (target, available) => {
    if (this.picker() === InvitePicker.GroupCondition) {
      this.requiredGroup.set(target);
      return true;
    }
    this.selectDestination(target);
    return this.confirmShare(available);
  };
  protected readonly list = signal<InviteList>(emptyList());
  protected readonly reading = computed(() => this.list().loading);
  protected readonly creating = signal(false);
  protected readonly selected = signal<InviteResponse | undefined>(undefined);
  protected readonly target = signal<MemberSummary | undefined>(undefined);
  protected readonly type = signal(InviteType.generic);
  protected readonly expiry = signal(Expiry.Week);
  protected readonly values = signal({ expiry: '' });
  protected readonly fields = form(this.values, (path) => {
    disabled(path.expiry, () => this.busy());
  });
  protected readonly inputInvalid = signal(false);
  protected readonly requiredGroup = signal<ChatPickerTarget | undefined>(undefined);
  protected readonly destination = signal<ChatPickerTarget | undefined>(undefined);
  protected readonly pending = signal<{ action: InviteAction; id?: SnowflakeID } | undefined>(undefined);
  protected readonly busy = computed(() => this.pending() != null);
  protected readonly operationError = signal<string | undefined>(undefined);
  protected readonly restriction = signal<SpeakingMode | undefined>(undefined);
  protected readonly notice = signal<string | undefined>(undefined);
  private readonly now = signal(Date.now());
  protected readonly expiryInvalid = computed(
    () =>
      this.expiry() === Expiry.Custom &&
      (this.inputInvalid() ||
        !Number.isFinite(Date.parse(this.values().expiry)) ||
        Date.parse(this.values().expiry) <= this.now()),
  );
  protected readonly expiryPast = computed(
    () => this.expiry() === Expiry.Custom && Date.parse(this.values().expiry) <= this.now(),
  );
  protected readonly canCreate = computed(
    () =>
      !this.busy() &&
      !this.expiryInvalid() &&
      (this.type() !== InviteType.targeted || !!this.target()) &&
      (this.type() !== InviteType.membership || !!this.requiredGroup()),
  );
  private context = 0;
  private sendAttempt?: { inviteId: SnowflakeID; destinationId: SnowflakeID; clientGeneratedId: string };
  constructor() {
    effect(() => {
      this.chatId();
      untracked(() => {
        this.context++;
        this.list.set(emptyList());
        this.creating.set(false);
        this.picker.set(undefined);
        this.editorReady.set(false);
        this.pending.set(undefined);
        void this.load();
      });
    });
    // Expiration can change while this panel is left open.
    const timer = setInterval(() => {
      this.now.set(Date.now());
      const rows = this.list().rows.filter((row) => this.status(row) === InviteStatus.Active);
      if (rows.length !== this.list().rows.length) this.updateList({ rows });
    }, 1000);
    this.destroy.onDestroy(() => clearInterval(timer));
  }
  protected status(invite: InviteResponse) {
    return inviteStatus(invite, this.now());
  }
  private current(context: number) {
    return context === this.context && !this.destroy.destroyed;
  }
  private updateList(change: Partial<InviteList>) {
    this.list.update((list) => ({ ...list, ...change }));
  }
  private merge(rows: InviteResponse[], added: InviteResponse[]) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of added) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  }
  protected async load(more = false) {
    const list = this.list();
    if (list.loading) return;
    const context = this.context;
    this.updateList({ loading: true, error: false, failedMore: more });
    try {
      const page = await firstValueFrom(
        this.api.invites.list({
          groupId: this.chatId(),
          activeOnly: true,
          limit: 30,
          after: more ? list.cursor : undefined,
        }),
      );
      if (!this.current(context)) return;
      this.updateList({
        rows: more ? this.merge(this.list().rows, page.invites) : page.invites,
        cursor: page.nextCursor,
        loaded: true,
      });
    } catch {
      if (this.current(context)) this.updateList({ error: true });
    } finally {
      if (this.current(context)) this.updateList({ loading: false });
    }
  }
  protected startCreate() {
    this.type.set(InviteType.generic);
    this.expiry.set(Expiry.Week);
    this.values.set({ expiry: '' });
    this.target.set(undefined);
    this.requiredGroup.set(undefined);
    this.inputInvalid.set(false);
    this.operationError.set(undefined);
    this.selected.set(undefined);
    this.creating.set(true);
  }
  protected change(value: unknown) {
    if (Object.values(InviteType).includes(value as InviteType)) this.type.set(value as InviteType);
  }
  protected changeExpiry(value: unknown) {
    if (Object.values(Expiry).includes(value as Expiry)) {
      this.expiry.set(value as Expiry);
    }
  }
  protected close() {
    if (!this.busy()) this.creating.set(false);
  }
  protected async create() {
    this.now.set(Date.now());
    if (!this.canCreate()) return;
    const context = this.context;
    this.pending.set({ action: InviteAction.Create });
    this.operationError.set(undefined);
    const expiry = this.expiry();
    const expiresAt =
      expiry === Expiry.Never
        ? undefined
        : expiry === Expiry.Custom
          ? new Date(this.values().expiry).toISOString()
          : new Date(Date.now() + (expiry === Expiry.Day ? 1 : 7) * 86400000).toISOString();
    try {
      const result = await firstValueFrom(
        this.api.invites.create({
          chatId: this.chatId(),
          inviteType: this.type(),
          expiresAt,
          targetUid: this.type() === InviteType.targeted ? this.target()?.uid : undefined,
          requiredChatId: this.type() === InviteType.membership ? this.requiredGroup()?.chatId : undefined,
        }),
      );
      if (!this.current(context)) return;
      const invite = {
        ...result,
        targetName: this.type() === InviteType.targeted ? this.target()?.username : undefined,
        requiredChatName: this.type() === InviteType.membership ? this.requiredGroup()?.name : undefined,
      };
      this.updateList({ rows: this.merge(this.list().rows, [invite]) });
      this.creating.set(false);
      this.notice.set(this.transloco.translate('chats.invites.created'));
    } catch {
      if (this.current(context)) this.operationError.set('chats.invites.createFailed');
    } finally {
      if (this.current(context)) this.pending.set(undefined);
    }
  }
  protected async copy(invite: InviteResponse, codeOnly = false) {
    if (inviteStatus(invite) !== InviteStatus.Active) return;
    try {
      await copyText(codeOnly ? invite.code : new URL('/chats/join/' + invite.code, location.origin).href);
      this.notice.set(this.transloco.translate(codeOnly ? 'chats.invites.codeCopied' : 'chats.invites.copied'));
    } catch {
      this.notice.set(this.transloco.translate('chats.invites.copyFailed'));
    }
  }
  protected async revoke(invite: InviteResponse) {
    const context = this.context;
    const alert = await this.alerts.create({
      header: this.transloco.translate('chats.invites.revokeTitle'),
      cssClass: 'invite-revoke-confirmation',
      message: this.transloco.translate('chats.invites.revokeWarning'),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('chats.invites.revoke'), role: 'confirm', cssClass: 'confirm-action' },
      ],
    });
    if (!this.current(context)) return;
    this.destroy.onDestroy(() => void alert.dismiss());
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm' || !this.current(context) || this.busy()) return;
    this.pending.set({ action: InviteAction.Revoke, id: invite.id });
    try {
      await firstValueFrom(this.api.invites.delete({ inviteId: invite.id }));
      if (!this.current(context)) return;
      this.updateList({
        rows: this.list().rows.filter((row) => row.id !== invite.id),
      });
      this.notice.set(this.transloco.translate('chats.invites.revoked'));
    } catch {
      if (this.current(context)) this.notice.set(this.transloco.translate('chats.invites.revokeFailed'));
    } finally {
      if (this.current(context)) this.pending.set(undefined);
    }
  }
  protected async startShare(invite: InviteResponse) {
    if (this.busy() || inviteStatus(invite) !== InviteStatus.Active) return;
    this.selected.set(invite);
    this.operationError.set(undefined);
    this.restriction.set(undefined);
    if (invite.inviteType === InviteType.generic) {
      this.picker.set(InvitePicker.Destination);
      return;
    }
    this.destination.set(
      invite.inviteType === InviteType.membership
        ? {
            chatId: invite.requiredChatId!,
            kind: GroupKind.group,
            name: invite.requiredChatName || decodeId(invite.requiredChatId!),
            avatar: {},
            time: 0,
          }
        : undefined,
    );
    await this.confirmShare();
  }
  private async confirmShare(available: () => boolean = () => true) {
    const context = this.context;
    const invite = this.selected()!;
    const name =
      invite.inviteType === InviteType.targeted
        ? invite.targetName || String(invite.targetUid)
        : this.destination()?.name || this.transloco.translate('conversation.chat');
    const alert = await this.alerts.create({
      header: this.transloco.translate('chats.invites.share'),
      message: this.transloco.translate('chats.invites.sendConfirmation', { group: name }),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('chats.invites.send'), role: 'confirm' },
      ],
    });
    if (!this.current(context) || !available()) return false;
    this.destroy.onDestroy(() => void alert.dismiss());
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm' || !this.current(context) || !available() || this.busy())
      return false;
    return this.share();
  }
  protected selectDestination(group: ChatPickerTarget) {
    this.destination.set(group);
    this.operationError.set(undefined);
    this.restriction.set(undefined);
  }
  protected async share() {
    let destination = this.destination();
    const invite = this.selected();
    if (!invite || this.busy() || inviteStatus(invite) !== InviteStatus.Active) return false;
    const context = this.context;
    this.pending.set({ action: InviteAction.Share, id: invite.id });
    this.operationError.set(undefined);
    this.restriction.set(undefined);
    try {
      if (invite.inviteType === InviteType.targeted) {
        const relationship = await firstValueFrom(this.api.friends.getRelationship({ uid: invite.targetUid! }));
        if (!this.current(context)) return false;
        if (!relationship.dmChatId) {
          this.operationError.set('chats.invites.noPrivateChat');
          return false;
        }
        destination = {
          chatId: relationship.dmChatId,
          kind: GroupKind.dm,
          name: invite.targetName || String(invite.targetUid),
          avatar: {},
          time: 0,
        };
      }
      if (!destination) return false;
      if (this.sendAttempt?.inviteId !== invite.id || this.sendAttempt.destinationId !== destination.chatId)
        this.sendAttempt = {
          inviteId: invite.id,
          destinationId: destination.chatId,
          clientGeneratedId: crypto.randomUUID(),
        };
      if (destination.kind !== GroupKind.dm) await this.store.ensureDetails(destination.chatId);
      if (!this.current(context)) return false;
      if (!this.store.canSpeak(destination.chatId, SpeakingAction.ChatMessage)) {
        this.restriction.set(this.store.speakingMode(destination.chatId));
        return false;
      }
      await firstValueFrom(
        this.api.invites.send({
          sourceChatId: this.chatId(),
          inviteId: invite.id,
          destinationChatId: destination.chatId,
          clientGeneratedId: this.sendAttempt.clientGeneratedId,
        }),
      );
      if (!this.current(context)) return false;
      this.notice.set(
        this.transloco.translate('chats.invites.sharedTo', {
          group: destination.name || this.transloco.translate('conversation.chat'),
        }),
      );
      this.sendAttempt = undefined;
      return true;
    } catch (error) {
      if (!this.current(context)) return false;
      const mode = speakingErrorMode(error);
      if (mode) this.restriction.set(mode);
      else this.operationError.set('chats.invites.shareFailed');
      return false;
    } finally {
      if (this.current(context)) {
        this.pending.set(undefined);
        const error = this.operationError();
        const mode = this.restriction();
        if (error || mode) this.notice.set(this.transloco.translate(error || `speaking.blocked.${mode}`));
      }
    }
  }
}
