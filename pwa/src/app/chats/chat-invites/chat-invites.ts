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
  type InviteResponse,
  type SnowflakeID,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { RpcError, RpcErrorCode } from '../../api/rpc-error';
import { copyText } from '../../api/clipboard';
import { inviteStatus, InviteStatus } from '../invite';
import { ChatStore } from '../chat-store';
import { SpeakingAction, speakingErrorMode } from '../speaking';
import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { ChatPicker, ChatPickerScope, type ChatPickerTarget, type ChooseChat } from '../chat-picker/chat-picker';
import { DiscardChanges } from '../../navigation/discard-changes';

enum InvitePicker {
  User,
  GroupCondition,
  Destination,
}

enum InviteAction {
  Create,
  CreateAndSend,
  Share,
  Revoke,
}
enum Expiry {
  Day = 'day',
  Week = 'week',
  Never = 'never',
  Custom = 'custom',
}
type InviteRecipient = ChatPickerTarget | Pick<MemberSummary, 'uid' | 'username'>;

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
  private readonly discardChanges = inject(DiscardChanges);
  protected readonly canDismiss = (_data?: unknown, role?: string) => {
    if (!this.creating() || role === 'navigate' || role === 'parent-dismissed' || role === 'parent-removed')
      return true;
    if (this.busy()) return false;
    const changed =
      this.type() !== InviteType.generic ||
      this.expiry() !== Expiry.Week ||
      !!this.values().expiry ||
      !!this.target() ||
      !!this.requiredGroup();
    return !changed || this.discardChanges.confirm();
  };
  private readonly sendDialogOpen = signal(false);
  protected readonly progress = computed(() => (this.sendDialogOpen() ? undefined : this.pending()));
  protected readonly operationError = signal<string | undefined>(undefined);
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
        this.sendDialogOpen.set(false);
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
    this.resetCreate();
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
  protected resetCreate() {
    this.creating.set(false);
    this.type.set(InviteType.generic);
    this.expiry.set(Expiry.Week);
    this.values.set({ expiry: '' });
    this.target.set(undefined);
    this.requiredGroup.set(undefined);
    this.inputInvalid.set(false);
    this.operationError.set(undefined);
  }
  protected async create(andSend = false) {
    this.now.set(Date.now());
    if (!this.canCreate()) return;
    const context = this.context;
    this.pending.set({ action: andSend ? InviteAction.CreateAndSend : InviteAction.Create });
    this.operationError.set(undefined);
    this.notice.set(undefined);
    const expiry = this.expiry();
    const expiresAt =
      expiry === Expiry.Never
        ? undefined
        : expiry === Expiry.Custom
          ? new Date(this.values().expiry).toISOString()
          : new Date(Date.now() + (expiry === Expiry.Day ? 1 : 7) * 86400000).toISOString();
    try {
      const available = () => this.current(context);
      let destination: ChatPickerTarget | undefined;
      if (andSend) {
        const recipient = this.type() === InviteType.targeted ? this.target()! : this.requiredGroup()!;
        destination = await this.checkRecipient(recipient, available);
        if (!destination || !(await this.confirmDestination(destination, available))) return;
      }
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
      if (destination) await this.share(invite, destination, available);
      else this.notice.set(this.transloco.translate('chats.invites.created'));
      if (this.current(context)) this.creating.set(false);
    } catch {
      if (this.current(context)) this.operationError.set('chats.invites.createFailed');
      return;
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
    const invite = this.selected();
    if (!invite || this.busy()) return false;
    const context = this.context;
    const current = () => this.current(context) && available();
    this.pending.set({ action: InviteAction.Share, id: invite.id });
    this.notice.set(undefined);
    try {
      const recipient =
        invite.inviteType === InviteType.targeted
          ? { uid: invite.targetUid!, username: invite.targetName }
          : this.destination()!;
      const destination = await this.checkRecipient(recipient, current);
      if (!destination || !(await this.confirmDestination(destination, current))) return false;
      return await this.share(invite, destination, current);
    } finally {
      if (this.current(context)) this.pending.set(undefined);
    }
  }
  private async checkRecipient(recipient: InviteRecipient, available: () => boolean) {
    try {
      let destination: ChatPickerTarget;
      if ('uid' in recipient || recipient.kind === GroupKind.dm) {
        let uid: number | undefined;
        if ('uid' in recipient) uid = recipient.uid;
        else {
          if (!this.store.get(recipient.chatId)?.peer) await this.store.ensureDetails(recipient.chatId);
          if (!available()) return;
          uid = this.store.get(recipient.chatId)?.peer?.uid;
        }
        if (uid == null) {
          await this.sendProblem('chats.invites.sendUnavailable', available);
          return;
        }
        const relationship = await firstValueFrom(this.api.friends.getRelationship({ uid }));
        if (!available()) return;
        if (!relationship.dmChatId) {
          await this.sendProblem('chats.invites.noPrivateChat', available);
          return;
        }
        if (!relationship.canDm) {
          await this.sendProblem(
            relationship.blocking
              ? 'messages.composer.blockedSelf'
              : relationship.blockedBy
                ? 'messages.composer.blockedBy'
                : 'messages.composer.notFriends',
            available,
          );
          return;
        }
        destination = {
          chatId: relationship.dmChatId,
          kind: GroupKind.dm,
          name: 'uid' in recipient ? recipient.username || String(uid) : recipient.name,
          avatar: {},
          time: 0,
        };
      } else {
        destination = recipient;
        await this.store.ensureDetails(destination.chatId);
      }
      if (!available()) return;
      const problem = this.destinationProblem(destination);
      if (problem) {
        await this.sendProblem(problem, available);
        return;
      }
      return destination;
    } catch (error) {
      await this.sendProblem(this.sendError(error, 'chats.invites.sendCheckFailed'), available);
      return;
    }
  }
  private destinationProblem(destination: ChatPickerTarget) {
    if (!this.store.isAccessible(destination.chatId)) return 'chats.invites.sendUnavailable';
    if (destination.kind !== GroupKind.dm && !this.store.canSpeak(destination.chatId, SpeakingAction.ChatMessage)) {
      const mode = this.store.speakingMode(destination.chatId);
      return mode ? `speaking.blocked.${mode}` : 'chats.invites.sendUnavailable';
    }
    return undefined;
  }
  private sendError(error: unknown, fallback: string) {
    const mode = speakingErrorMode(error);
    if (mode) return `speaking.blocked.${mode}`;
    if (error instanceof RpcError && (error.code === RpcErrorCode.Forbidden || error.code === RpcErrorCode.NotFound))
      return 'chats.invites.sendUnavailable';
    return fallback;
  }
  private async sendProblem(message: string, available: () => boolean) {
    if (!available()) return;
    const alert = await this.alerts.create({
      header: this.transloco.translate('chats.invites.cannotSend'),
      message: this.transloco.translate(message),
      buttons: [{ text: this.transloco.translate('common.confirm'), role: 'cancel' }],
    });
    await this.showSendDialog(alert, available);
  }
  private async confirmDestination(destination: ChatPickerTarget, available: () => boolean) {
    if (!available()) return false;
    const alert = await this.alerts.create({
      header: this.transloco.translate('chats.invites.share'),
      message: this.transloco.translate('chats.invites.sendConfirmation', {
        group: destination.name || this.transloco.translate('conversation.chat'),
      }),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('chats.invites.send'), role: 'confirm' },
      ],
    });
    return this.showSendDialog(alert, available);
  }
  private async showSendDialog(alert: HTMLIonAlertElement, available: () => boolean) {
    if (!available()) return false;
    const context = this.context;
    this.sendDialogOpen.set(true);
    this.destroy.onDestroy(() => void alert.dismiss());
    try {
      await alert.present();
      return (await alert.onDidDismiss()).role === 'confirm' && available();
    } finally {
      if (this.current(context)) this.sendDialogOpen.set(false);
    }
  }
  protected selectDestination(group: ChatPickerTarget) {
    this.destination.set(group);
    this.operationError.set(undefined);
  }
  private async share(invite: InviteResponse, destination: ChatPickerTarget, available: () => boolean) {
    if (!available()) return false;
    const problem =
      inviteStatus(invite) !== InviteStatus.Active
        ? 'chats.invites.sendUnavailable'
        : this.destinationProblem(destination);
    if (problem) {
      await this.sendProblem(problem, available);
      return false;
    }
    if (this.sendAttempt?.inviteId !== invite.id || this.sendAttempt.destinationId !== destination.chatId)
      this.sendAttempt = {
        inviteId: invite.id,
        destinationId: destination.chatId,
        clientGeneratedId: crypto.randomUUID(),
      };
    try {
      await firstValueFrom(
        this.api.invites.send({
          sourceChatId: this.chatId(),
          inviteId: invite.id,
          destinationChatId: destination.chatId,
          clientGeneratedId: this.sendAttempt.clientGeneratedId,
        }),
      );
      if (!available()) return false;
      this.notice.set(
        this.transloco.translate('chats.invites.sharedTo', {
          group: destination.name || this.transloco.translate('conversation.chat'),
        }),
      );
      this.sendAttempt = undefined;
      return true;
    } catch (error) {
      await this.sendProblem(this.sendError(error, 'chats.invites.shareFailed'), available);
      return false;
    }
  }
}
