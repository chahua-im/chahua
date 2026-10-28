import { Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
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
  IonListHeader,
  IonModal,
  IonNote,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { addOutline, trashOutline } from 'ionicons/icons';
import { FriendsService } from '../../../generated/endpoints/friends/friends.service';
import {
  FriendPresenceOverride,
  FriendReadReceiptOverride,
  PrivacyExceptionKind,
  type MemberSummary,
  type PrivacyException,
} from '../../../generated/models';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { ChatStore } from '../../chats/chat-store';
import { Presence } from '../../presence/presence';
import { SessionStore } from '../../session/session-store';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';

@Component({
  selector: 'app-privacy-exceptions',
  templateUrl: './privacy-exceptions.html',
  imports: [
    TranslocoPipe,
    ChatAvatar,
    ContentScrollbars,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    IonModal,
    IonNote,
    IonSearchbar,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class PrivacyExceptions {
  readonly kind = input.required<PrivacyExceptionKind>();
  private readonly api = inject(FriendsService);
  private readonly session = inject(SessionStore);
  private readonly alerts = inject(AlertController);
  private readonly text = inject(TranslocoService);
  private readonly presence = inject(Presence);
  private readonly chats = inject(ChatStore);
  private readonly destroy = inject(DestroyRef);
  private readonly scope = computed(() => ({ uid: this.session.user()?.uid, kind: this.kind() }));
  protected readonly addIcon = addOutline;
  protected readonly trashIcon = trashOutline;
  protected readonly rows = signal<PrivacyException[] | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly saveFailed = signal(false);
  protected readonly editing = signal<number | undefined>(undefined);
  protected readonly clearing = signal(false);
  protected readonly busy = computed(() => this.editing() != null || this.clearing());
  protected readonly canDismissPicker = async (_data?: unknown, role?: string) =>
    !this.busy() || role === 'navigate' || role === 'parent-dismissed' || role === 'parent-removed';
  protected readonly pickerOpen = signal(false);
  protected readonly friends = signal<MemberSummary[] | undefined>(undefined);
  protected readonly friendsLoading = signal(false);
  protected readonly friendsFailed = signal(false);
  protected readonly query = signal('');
  protected readonly existing = computed(() => new Set(this.rows()?.map((row) => row.user.uid)));
  protected readonly candidates = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.friends()?.filter((user) => `${user.username ?? ''} ${user.uid}`.toLocaleLowerCase().includes(query));
  });
  private version = 0;

  constructor() {
    this.chats.privacyOverrides$.pipe(takeUntilDestroyed()).subscribe(({ kind }) => {
      if (kind === this.kind() && !this.busy()) void this.load();
    });
    effect(() => {
      this.scope();
      this.rows.set(undefined);
      this.friends.set(undefined);
      this.friendsLoading.set(false);
      this.friendsFailed.set(false);
      this.pickerOpen.set(false);
      this.editing.set(undefined);
      this.clearing.set(false);
      this.saveFailed.set(false);
      untracked(() => void this.load());
    });
  }

  private current(scope: ReturnType<typeof this.scope>) {
    return !this.destroy.destroyed && scope === this.scope();
  }

  protected async load() {
    const scope = this.scope();
    const version = ++this.version;
    if (!scope.uid) return;
    this.loading.set(true);
    this.failed.set(false);
    try {
      const result = await firstValueFrom(
        this.api.getPrivacyExceptions({ kind: scope.kind }).pipe(takeUntilDestroyed(this.destroy)),
      );
      if (this.current(scope) && version === this.version) this.rows.set(result.exceptions);
    } catch {
      if (this.current(scope) && version === this.version) this.failed.set(true);
    } finally {
      if (this.current(scope) && version === this.version) this.loading.set(false);
    }
  }

  protected openPicker() {
    this.query.set('');
    this.saveFailed.set(false);
    this.pickerOpen.set(true);
    void this.loadFriends();
  }

  protected async loadFriends() {
    if (this.friendsLoading()) return;
    const scope = this.scope();
    this.friendsLoading.set(true);
    this.friendsFailed.set(false);
    try {
      const result = await firstValueFrom(this.api.getFriends().pipe(takeUntilDestroyed(this.destroy)));
      if (this.current(scope)) this.friends.set(result.friends.map((friend) => friend.user));
    } catch {
      if (this.current(scope)) this.friendsFailed.set(true);
    } finally {
      if (this.current(scope)) this.friendsLoading.set(false);
    }
  }

  protected async choose(user: MemberSummary, share?: boolean) {
    if (this.busy()) return;
    const scope = this.scope();
    this.editing.set(user.uid);
    try {
      const alert = await this.alerts.create({
        header: user.username ?? String(user.uid),
        inputs: [
          {
            type: 'radio',
            label: this.text.translate('settings.privacyExceptions.share'),
            value: FriendPresenceOverride.share,
            checked: share === true,
          },
          {
            type: 'radio',
            label: this.text.translate('settings.privacyExceptions.hide'),
            value: FriendPresenceOverride.hide,
            checked: share === false,
          },
        ],
        buttons: [
          { text: this.text.translate('common.cancel'), role: 'cancel' },
          {
            text: this.text.translate('common.save'),
            role: 'confirm',
            handler: (value: FriendPresenceOverride) => !!value,
          },
        ],
      });
      await alert.present();
      const result = await alert.onDidDismiss<{ values: FriendPresenceOverride }>();
      if (result.role === 'confirm' && result.data && this.current(scope)) {
        await this.save(user, result.data.values === FriendPresenceOverride.share);
      }
    } finally {
      if (this.current(scope)) this.editing.set(undefined);
    }
  }

  protected async remove(row: PrivacyException) {
    if (this.busy()) return;
    const scope = this.scope();
    this.editing.set(row.user.uid);
    try {
      await this.save(row.user);
    } finally {
      if (this.current(scope)) this.editing.set(undefined);
    }
  }

  private async save(user: MemberSummary, share?: boolean) {
    const scope = this.scope();
    this.saveFailed.set(false);
    try {
      if (scope.kind === PrivacyExceptionKind.presence) {
        await firstValueFrom(
          this.api
            .updateFriendPresenceSettings(user.uid, {
              override:
                share == null
                  ? FriendPresenceOverride.inherit
                  : share
                    ? FriendPresenceOverride.share
                    : FriendPresenceOverride.hide,
            })
            .pipe(takeUntilDestroyed(this.destroy)),
        );
      } else {
        await firstValueFrom(
          this.api
            .updateFriendReadReceiptSettings(user.uid, {
              override:
                share == null
                  ? FriendReadReceiptOverride.inherit
                  : share
                    ? FriendReadReceiptOverride.share
                    : FriendReadReceiptOverride.hide,
            })
            .pipe(takeUntilDestroyed(this.destroy)),
        );
      }
      if (!this.current(scope)) return;
      this.version++;
      this.loading.set(false);
      this.rows.update((rows) => {
        const next = rows!.filter((row) => row.user.uid !== user.uid);
        if (share != null) next.push({ user, share });
        return next.sort((a, b) => a.user.uid - b.user.uid);
      });
      this.invalidate(user.uid);
      this.chats.publishPrivacyOverride(scope.kind, user.uid, share);
      this.editing.set(undefined);
      this.pickerOpen.set(false);
    } catch {
      if (this.current(scope)) this.saveFailed.set(true);
    }
  }

  protected async clear() {
    if (this.busy()) return;
    const scope = this.scope();
    this.clearing.set(true);
    this.saveFailed.set(false);
    try {
      const alert = await this.alerts.create({
        header: this.text.translate('settings.privacyExceptions.clearTitle'),
        buttons: [
          { text: this.text.translate('common.cancel'), role: 'cancel' },
          { text: this.text.translate('common.delete'), role: 'destructive' },
        ],
      });
      await alert.present();
      if ((await alert.onDidDismiss()).role !== 'destructive' || !this.current(scope)) return;
      await firstValueFrom(
        this.api.clearPrivacyExceptions({ kind: scope.kind }).pipe(takeUntilDestroyed(this.destroy)),
      );
      if (!this.current(scope)) return;
      // Receipt invalidation arrives over WS for exactly the DMs changed by the server.
      if (scope.kind === PrivacyExceptionKind.presence) this.presence.invalidateUsers();
      this.chats.publishPrivacyOverride(scope.kind);
      this.rows.set([]);
      await this.load();
    } catch {
      if (this.current(scope)) this.saveFailed.set(true);
    } finally {
      if (this.current(scope)) this.clearing.set(false);
    }
  }

  private invalidate(uid?: number) {
    if (this.kind() === PrivacyExceptionKind.presence) this.presence.invalidateUsers(uid ? [uid] : undefined);
    else this.chats.invalidateReadReceiptPrivacy(uid);
  }
}
