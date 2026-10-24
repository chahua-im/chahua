import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { RouterLink } from '@angular/router';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  AlertController,
  IonButton,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPopover,
  IonSearchbar,
  IonSpinner,
  IonToast,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { ellipsisVertical } from 'ionicons/icons';
import { MembersService } from '../../../generated/endpoints/members/members.service';
import { GroupRole, UserSearchMode, type MemberResponse, type SnowflakeID } from '../../../generated/models';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { LoadError } from '../../ui/load-error/load-error';
import { SessionStore } from '../../session/session-store';
@Component({
  selector: 'app-chat-members',
  templateUrl: './chat-members.html',
  imports: [
    RouterLink,
    IonButton,
    IonIcon,
    IonPopover,
    IonSearchbar,
    IonToast,
    ChatAvatar,
    LoadError,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonNote,
    IonList,
    IonItem,
    IonLabel,
    IonSpinner,
    TranslocoPipe,
  ],
})
export class ChatMembers {
  readonly chatId = input.required<SnowflakeID>();
  readonly canManage = input(false);
  protected readonly Role = GroupRole;
  protected readonly moreIcon = ellipsisVertical;
  private readonly session = inject(SessionStore);
  protected readonly currentUid = computed(() => this.session.user()?.uid);
  private readonly api = inject(MembersService);
  private readonly alerts = inject(AlertController);
  private readonly transloco = inject(TranslocoService);
  private readonly menu = viewChild.required<IonPopover>('menu');
  private readonly failure = viewChild.required<IonToast>('failure');
  private readonly destroy = inject(DestroyRef);
  private readonly scope = computed(() => ({ chatId: this.chatId(), uid: this.currentUid() }));
  protected readonly query = linkedSignal({ source: this.scope, computation: () => '' });
  private readonly searchQuery = computed(() => this.query().trim());
  private readonly search = computed(() => ({ scope: this.scope(), q: this.searchQuery() }));
  private requestedSearch?: ReturnType<typeof this.search>;
  private readonly cancelLoad = new Subject<void>();
  protected readonly selectedUid = linkedSignal<number | undefined>(() => {
    this.scope();
    this.canManage();
    return undefined;
  });
  protected readonly selected = computed(() => this.members().find((member) => member.uid === this.selectedUid()));
  protected readonly pending = linkedSignal<number | undefined>(() => {
    this.scope();
    return undefined;
  });
  private version = 0;
  protected readonly members = linkedSignal({ source: this.scope, computation: (): MemberResponse[] => [] });
  protected readonly cursor = linkedSignal({ source: this.scope, computation: (): number | undefined => undefined });
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly busy = computed(() => this.loading() || this.pending() != null);
  constructor() {
    fillScrollViewport(this.busy, this.error, this.cursor, () => this.load(true));
    effect(() => {
      const search = this.search();
      if (this.pending() != null) return;
      untracked(() => {
        if (search !== this.requestedSearch) void this.load();
      });
    });
  }
  protected openMenu(event: MouseEvent, member: MemberResponse) {
    event.preventDefault();
    event.stopPropagation();
    if (this.busy() || !this.canManage() || member.uid === this.currentUid()) return;
    this.selectedUid.set(member.uid);
    void this.menu().present(event);
  }
  protected changeRole(member: MemberResponse) {
    return this.perform(member, member.role === GroupRole.admin ? GroupRole.member : GroupRole.admin);
  }
  protected async remove(member: MemberResponse) {
    const scope = this.scope();
    await this.menu().dismiss();
    const alert = await this.alerts.create({
      header: this.transloco.translate('chats.members.removeTitle', { name: member.username || member.uid }),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('chats.members.remove'), role: 'confirm' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role === 'confirm' && this.isCurrent(scope)) await this.perform(member);
  }
  private isCurrent(scope: ReturnType<typeof this.scope>) {
    return !this.destroy.destroyed && this.scope() === scope;
  }
  private async perform(member: MemberResponse, role?: GroupRole) {
    if (this.busy() || !this.canManage() || member.uid === this.currentUid()) return;
    const scope = this.scope();
    this.pending.set(member.uid);
    void this.menu().dismiss();
    try {
      if (role != null) {
        const updated = await firstValueFrom(
          this.api.patchMember(scope.chatId, member.uid, { role }).pipe(takeUntilDestroyed(this.destroy)),
        );
        if (this.isCurrent(scope))
          this.members.update((items) => items.map((item) => (item.uid === updated.uid ? updated : item)));
      } else {
        await firstValueFrom(
          this.api.deleteRemoveMember(scope.chatId, member.uid).pipe(takeUntilDestroyed(this.destroy)),
        );
        if (this.isCurrent(scope)) this.members.update((items) => items.filter((item) => item.uid !== member.uid));
      }
    } catch {
      if (this.isCurrent(scope)) void this.failure().present();
    } finally {
      if (this.isCurrent(scope)) this.pending.set(undefined);
    }
  }
  protected async more(event: InfiniteScrollCustomEvent) {
    try {
      await this.load(true);
    } finally {
      await event.target.complete();
    }
  }
  protected async load(more = false) {
    if (this.pending() != null) return;
    if (more && (this.loading() || this.cursor() == null)) return;
    const version = ++this.version;
    const search = this.search();
    this.requestedSearch = search;
    this.cancelLoad.next();
    if (!more) {
      this.cursor.set(undefined);
    }
    this.loading.set(true);
    this.error.set(false);
    try {
      const page = await firstValueFrom(
        this.api
          .getMembers(search.scope.chatId, {
            limit: 40,
            q: search.q || undefined,
            mode: UserSearchMode.autocomplete,
            after: more ? this.cursor() : undefined,
          })
          .pipe(takeUntil(this.cancelLoad), takeUntilDestroyed(this.destroy)),
      );
      if (version !== this.version || search !== this.search()) return;
      this.members.update((items) => (more ? [...items, ...page.members] : page.members));
      this.cursor.set(page.nextCursor);
    } catch {
      if (version === this.version) this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
}
