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
import {
  GroupRole,
  SpeakingMode,
  UserSearchMode,
  type MemberResponse,
  type SnowflakeID,
} from '../../../generated/models';
import { Connection, ResyncReason } from '../../api/connection';
import { ChatStore } from '../chat-store';
import { SpeakingModeSelect } from '../speaking-mode-select';
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
    SpeakingModeSelect,
  ],
})
export class ChatMembers {
  readonly chatId = input.required<SnowflakeID>();
  readonly canManage = input(false);
  protected readonly Role = GroupRole;
  protected readonly Mode = SpeakingMode;
  private readonly store = inject(ChatStore);
  private readonly realtime = inject(Connection);
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
  private memberRevision = 0;
  private refreshPending = false;
  private readonly memberUpdates = linkedSignal(() => {
    this.scope();
    return new Map<number, { role: GroupRole; speakingMode: SpeakingMode; revision: number }>();
  });
  protected readonly members = linkedSignal({ source: this.scope, computation: (): MemberResponse[] => [] });
  protected readonly cursor = linkedSignal({ source: this.scope, computation: (): number | undefined => undefined });
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly busy = computed(() => this.loading() || this.pending() != null);
  constructor() {
    this.store.memberSpeakingChanges$.pipe(takeUntilDestroyed()).subscribe((state) => {
      if (state.chatId !== this.chatId()) return;
      this.memberUpdates().set(state.uid, {
        role: state.role,
        speakingMode: state.speakingMode,
        revision: ++this.memberRevision,
      });
      this.members.update((members) =>
        members.map((member) =>
          member.uid === state.uid ? { ...member, role: state.role, speakingMode: state.speakingMode } : member,
        ),
      );
    });
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe((reason) => {
      if (reason === ResyncReason.Foreground && this.realtime.connected()) return;
      if (this.pending() != null) this.refreshPending = true;
      else void this.load(false, true);
    });
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
  protected async changeSpeakingMode(member: MemberResponse, mode: SpeakingMode | undefined) {
    if (!mode || member.role === GroupRole.admin || this.busy() || !this.canManage()) return;
    const scope = this.scope();
    this.pending.set(member.uid);
    void this.menu().dismiss();
    try {
      await this.store.setMemberSpeakingMode(scope.chatId, member.uid, mode);
    } catch {
      if (this.isCurrent(scope)) void this.failure().present();
    } finally {
      if (this.isCurrent(scope)) this.finishOperation();
    }
  }
  private finishOperation() {
    this.pending.set(undefined);
    if (this.refreshPending) {
      this.refreshPending = false;
      void this.load(false, true);
    }
  }
  private latestMember(member: MemberResponse, revision: number): MemberResponse {
    const latest = this.memberUpdates().get(member.uid);
    return latest && latest.revision > revision
      ? { ...member, role: latest.role, speakingMode: latest.speakingMode }
      : member;
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
    const revision = this.memberRevision;
    this.pending.set(member.uid);
    void this.menu().dismiss();
    try {
      if (role != null) {
        const updated = await firstValueFrom(
          this.api.patchMember(scope.chatId, member.uid, { role }).pipe(takeUntilDestroyed(this.destroy)),
        );
        if (this.isCurrent(scope))
          this.members.update((items) =>
            items.map((item) => (item.uid === updated.uid ? this.latestMember(updated, revision) : item)),
          );
      } else {
        await firstValueFrom(
          this.api.deleteRemoveMember(scope.chatId, member.uid).pipe(takeUntilDestroyed(this.destroy)),
        );
        if (this.isCurrent(scope)) this.members.update((items) => items.filter((item) => item.uid !== member.uid));
      }
    } catch {
      if (this.isCurrent(scope)) void this.failure().present();
    } finally {
      if (this.isCurrent(scope)) this.finishOperation();
    }
  }
  protected async more(event: InfiniteScrollCustomEvent) {
    try {
      await this.load(true);
    } finally {
      await event.target.complete();
    }
  }
  protected async load(more = false, refresh = false) {
    if (this.pending() != null) return;
    if (more && (this.loading() || this.cursor() == null)) return;
    const version = ++this.version;
    const revision = this.memberRevision;
    const targetCount = refresh ? this.members().length : 0;
    const search = this.search();
    this.requestedSearch = search;
    this.cancelLoad.next();
    if (!more) {
      this.cursor.set(undefined);
    }
    this.loading.set(true);
    this.error.set(false);
    try {
      const loaded: MemberResponse[] = [];
      let cursor = more ? this.cursor() : undefined;
      do {
        const page = await firstValueFrom(
          this.api
            .getMembers(search.scope.chatId, {
              limit: 40,
              q: search.q || undefined,
              mode: UserSearchMode.autocomplete,
              after: cursor,
            })
            .pipe(takeUntil(this.cancelLoad), takeUntilDestroyed(this.destroy)),
        );
        if (version !== this.version || search !== this.search()) return;
        loaded.push(...page.members);
        cursor = page.nextCursor;
      } while (cursor != null && loaded.length < targetCount);
      const members = loaded.map((member) => this.latestMember(member, revision));
      this.members.update((items) => (more ? [...items, ...members] : members));
      this.cursor.set(cursor);
    } catch {
      if (version === this.version) this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
}
