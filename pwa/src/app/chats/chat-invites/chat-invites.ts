import { Component, effect, inject, input, signal } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import {
  IonList,
  IonItem,
  IonLabel,
  IonButton,
  IonSpinner,
  IonSelect,
  IonSelectOption,
  IonSearchbar,
  AlertController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { InvitesService } from '../../../generated/endpoints/invites/invites.service';
import {
  InviteType,
  GroupSelectorScope,
  GroupSearchMode,
  type GroupSelectorItem,
  type InviteResponse,
  type SnowflakeID,
} from '../../../generated/models';
@Component({
  selector: 'app-chat-invites',
  templateUrl: './chat-invites.html',
  imports: [FormField, IonList, IonItem, IonLabel, IonButton, IonSpinner, IonSelect, IonSelectOption, IonSearchbar],
})
export class ChatInvites {
  readonly chatId = input.required<SnowflakeID>();
  private readonly api = inject(InvitesService);
  private readonly groupsApi = inject(GroupsService);
  private readonly alerts = inject(AlertController);
  protected readonly Type = InviteType;
  protected readonly type = signal(InviteType.generic);
  protected readonly values = signal({ target: '', group: '', expiry: '' });
  protected readonly fields = form(this.values);
  protected readonly groups = signal<GroupSelectorItem[]>([]);
  protected readonly cursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly groupQuery = signal('');
  protected readonly requiredGroup = signal<SnowflakeID | undefined>(undefined);
  protected readonly destination = signal<SnowflakeID | undefined>(undefined);
  protected readonly invites = signal<InviteResponse[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal(false);
  protected readonly copied = signal(false);
  constructor() {
    effect(() => {
      this.chatId();
      void this.load();
    });
    effect(() => {
      this.groupQuery();
      void this.loadGroups();
    });
  }
  protected async load() {
    this.busy.set(true);
    this.error.set(false);
    try {
      this.invites.set((await firstValueFrom(this.api.getInvites({ groupId: this.chatId(), limit: 100 }))).invites);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async loadGroups(more = false) {
    try {
      const page = await firstValueFrom(
        this.groupsApi.getGroups({
          q: this.groupQuery(),
          mode: GroupSearchMode.submitted,
          scope: GroupSelectorScope.joined,
          limit: 50,
          after: more ? this.cursor() : undefined,
        }),
      );
      this.groups.update((items) => (more ? [...items, ...page.groups] : page.groups));
      this.cursor.set(page.nextCursor);
    } catch {
      this.error.set(true);
    }
  }
  protected change(value: unknown) {
    if (Object.values(InviteType).includes(value as InviteType)) this.type.set(value as InviteType);
  }
  protected async create() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(false);
    try {
      const values = this.values();
      const invite = await firstValueFrom(
        this.api.postInvite({
          chatId: this.chatId(),
          inviteType: this.type(),
          targetUid: this.type() === InviteType.targeted ? Number(values.target) : undefined,
          requiredChatId: this.type() === InviteType.membership ? this.requiredGroup() : undefined,
          expiresAt: values.expiry ? new Date(values.expiry).toISOString() : undefined,
        }),
      );
      this.invites.update((items) => [invite, ...items]);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async copy(invite: InviteResponse) {
    try {
      await navigator.clipboard.writeText(new URL('/chats/join/' + invite.code, location.origin).href);
      this.copied.set(true);
    } catch {
      this.error.set(true);
    }
  }
  protected async revoke(invite: InviteResponse) {
    const alert = await this.alerts.create({
      header: '撤销邀请',
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '撤销', role: 'confirm' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.deleteInvite(invite.id));
      this.invites.update((items) => items.filter((item) => item.id !== invite.id));
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async share(invite: InviteResponse) {
    const destination = this.destination();
    if (!destination || this.busy()) return;
    this.busy.set(true);
    this.error.set(false);
    try {
      await firstValueFrom(
        this.api.postSendInviteMessage({
          sourceChatId: this.chatId(),
          inviteId: invite.id,
          destinationChatId: destination,
          clientGeneratedId: crypto.randomUUID(),
        }),
      );
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
}
