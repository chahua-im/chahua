import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import {
  AlertController,
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonSpinner,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { InvitesService } from '../../../generated/endpoints/invites/invites.service';
import type { MemberSummary } from '../../../generated/models';
import {
  GroupSearchMode,
  GroupSelectorScope,
  InviteType,
  type GroupSelectorItem,
  type InviteResponse,
  type SnowflakeID,
} from '../../../generated/models';
import { copyText } from '../../api/clipboard';
import { DirectorySearch } from '../directory-search/directory-search';
import { inviteStatus, InviteStatus } from '../invite';

enum InviteAction {
  Create,
  Share,
  Revoke,
}

@Component({
  selector: 'app-chat-invites',
  templateUrl: './chat-invites.html',
  imports: [
    DatePipe,
    DirectorySearch,
    FormField,
    IonList,
    IonItem,
    IonLabel,
    IonButton,
    IonSpinner,
    IonSelect,
    IonSelectOption,
    IonSearchbar,
  ],
})
export class ChatInvites {
  readonly chatId = input.required<SnowflakeID>();
  private readonly api = inject(InvitesService);
  private readonly groupsApi = inject(GroupsService);
  private readonly alerts = inject(AlertController);
  protected readonly Type = InviteType;
  protected readonly Action = InviteAction;
  protected readonly status = inviteStatus;
  protected readonly Status = InviteStatus;
  protected readonly targetQuery = signal('');
  protected readonly target = signal<MemberSummary | undefined>(undefined);
  protected groupName(id: SnowflakeID) {
    return this.groups().find((group) => group.id === id)?.name ?? '群组';
  }
  protected readonly type = signal(InviteType.generic);
  protected readonly values = signal({ target: '', group: '', expiry: '' });
  protected readonly fields = form(this.values);
  protected readonly groups = signal<GroupSelectorItem[]>([]);
  protected readonly cursor = signal<SnowflakeID | undefined>(undefined);
  protected readonly groupQuery = signal('');
  protected readonly requiredGroup = signal<SnowflakeID | undefined>(undefined);
  protected readonly destination = signal<SnowflakeID | undefined>(undefined);
  protected readonly invites = signal<InviteResponse[]>([]);
  protected readonly pending = signal<{ action: InviteAction; id?: SnowflakeID } | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly busy = computed(() => this.pending() != null || this.loading());
  protected readonly loadingGroups = signal(false);
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
    this.loading.set(true);
    this.error.set(false);
    try {
      this.invites.set((await firstValueFrom(this.api.getInvites({ groupId: this.chatId(), limit: 100 }))).invites);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }
  protected async loadGroups(more = false) {
    if (more) this.loadingGroups.set(true);
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
    } finally {
      if (more) this.loadingGroups.set(false);
    }
  }
  protected change(value: unknown) {
    if (Object.values(InviteType).includes(value as InviteType)) this.type.set(value as InviteType);
  }
  protected async create() {
    if (this.busy()) return;
    this.pending.set({ action: InviteAction.Create });
    this.error.set(false);
    try {
      const values = this.values();
      const invite = await firstValueFrom(
        this.api.postInvite({
          chatId: this.chatId(),
          inviteType: this.type(),
          targetUid: this.type() === InviteType.targeted ? this.target()?.uid : undefined,
          requiredChatId: this.type() === InviteType.membership ? this.requiredGroup() : undefined,
          expiresAt: values.expiry ? new Date(values.expiry).toISOString() : undefined,
        }),
      );
      this.invites.update((items) => [invite, ...items]);
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected async copy(invite: InviteResponse) {
    try {
      await copyText(new URL('/chats/join/' + invite.code, location.origin).href);
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
    this.pending.set({ action: InviteAction.Revoke, id: invite.id });
    try {
      await firstValueFrom(this.api.deleteInvite(invite.id));
      this.invites.update((items) => items.filter((item) => item.id !== invite.id));
    } catch {
      this.error.set(true);
    } finally {
      this.pending.set(undefined);
    }
  }
  protected async share(invite: InviteResponse) {
    const destination = this.destination();
    if (!destination || this.busy()) return;
    this.pending.set({ action: InviteAction.Share, id: invite.id });
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
      this.pending.set(undefined);
    }
  }
}
