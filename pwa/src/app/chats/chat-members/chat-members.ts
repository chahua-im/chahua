import { Component, effect, inject, input, signal } from '@angular/core';
import {
  IonSearchbar,
  IonList,
  IonItem,
  IonLabel,
  IonAvatar,
  IonButton,
  IonSpinner,
  AlertController,
  ModalController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { MembersService } from '../../../generated/endpoints/members/members.service';
import { GroupRole, UserSearchMode, type MemberResponse, type SnowflakeID } from '../../../generated/models';
import { SessionStore } from '../../session/session-store';
import { UserProfile } from '../user-profile/user-profile';
@Component({
  selector: 'app-chat-members',
  templateUrl: './chat-members.html',
  imports: [IonSearchbar, IonList, IonItem, IonLabel, IonAvatar, IonButton, IonSpinner],
})
export class ChatMembers {
  readonly chatId = input.required<SnowflakeID>();
  protected readonly session = inject(SessionStore);
  protected readonly Role = GroupRole;
  private readonly api = inject(MembersService);
  private readonly alerts = inject(AlertController);
  private readonly modals = inject(ModalController);
  private version = 0;
  protected readonly q = signal('');
  protected readonly members = signal<MemberResponse[]>([]);
  protected readonly cursor = signal<number | undefined>(undefined);
  protected readonly manageable = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly busy = signal<number | undefined>(undefined);
  constructor() {
    effect(() => {
      this.chatId();
      this.q();
      void this.load();
    });
  }
  protected async load(more = false) {
    const version = ++this.version;
    if (!more) {
      this.members.set([]);
      this.cursor.set(undefined);
    }
    this.loading.set(true);
    this.error.set(false);
    try {
      const page = await firstValueFrom(
        this.api.getMembers(this.chatId(), {
          q: this.q(),
          mode: UserSearchMode.submitted,
          limit: 40,
          after: more ? this.cursor() : undefined,
        }),
      );
      if (version !== this.version) return;
      this.members.update((items) => (more ? [...items, ...page.members] : page.members));
      this.cursor.set(page.nextCursor);
      this.manageable.set(page.canManageMembers);
    } catch {
      if (version === this.version) this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
  protected async profile(user: MemberResponse) {
    const modal = await this.modals.create({ component: UserProfile, componentProps: { user } });
    await modal.present();
  }
  protected async role(member: MemberResponse) {
    if (this.busy()) return;
    const alert = await this.alerts.create({
      header: member.role === GroupRole.admin ? '取消管理员' : '设为管理员',
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '确定', role: 'confirm' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') return;
    this.busy.set(member.uid);
    this.error.set(false);
    try {
      const updated = await firstValueFrom(
        this.api.patchMember(this.chatId(), member.uid, {
          role: member.role === GroupRole.admin ? GroupRole.member : GroupRole.admin,
        }),
      );
      this.members.update((items) => items.map((item) => (item.uid === member.uid ? updated : item)));
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(undefined);
    }
  }
  protected async remove(member: MemberResponse) {
    const alert = await this.alerts.create({
      header: '移除成员',
      inputs: [
        { type: 'radio', label: '保留消息', value: 'none', checked: true },
        { type: 'radio', label: '删除最近24小时消息', value: 'last24h' },
        { type: 'radio', label: '删除全部消息', value: 'all' },
      ],
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '移除', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss<{ values: string }>();
    if (result.role !== 'confirm') return;
    this.busy.set(member.uid);
    this.error.set(false);
    try {
      const value = result.data?.values;
      await firstValueFrom(
        this.api.deleteRemoveMember(this.chatId(), member.uid, {
          deleteMessages: value === 'none' ? undefined : value,
        }),
      );
      this.members.update((items) => items.filter((item) => item.uid !== member.uid));
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(undefined);
    }
  }
}
