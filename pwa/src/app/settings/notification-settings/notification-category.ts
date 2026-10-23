import { Component, computed, DestroyRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { personOutline, peopleOutline, notificationsOutline, personAddOutline, trashOutline } from 'ionicons/icons';
import { NotificationExceptionPicker } from './notification-exception-picker';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonAlert,
  IonIcon,
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonToggle,
} from '@ionic/angular';
import type { ToggleCustomEvent } from '@ionic/core';
import { firstValueFrom } from 'rxjs';
import { UsersService } from '../../../generated/endpoints/users/users.service';
import { GroupKind, NotificationSettingMode, type NotificationExceptionsResponse } from '../../../generated/models';
import { Connection, ResyncReason } from '../../api/connection';
import { ChatStore } from '../../chats/chat-store';
import { ChatMute } from '../../chats/chat-mute/chat-mute';
import { ChatAvatar, conversationAvatar } from '../../chats/chat-avatar/chat-avatar';
import { SessionStore } from '../../session/session-store';
import type { SnowflakeID } from '../../api/snowflake-id';

@Component({
  selector: 'app-notification-category',
  templateUrl: './notification-category.html',
  styleUrl: './notification-category.scss',
  imports: [
    TranslocoPipe,
    RouterLink,
    IonAlert,
    IonIcon,
    NotificationExceptionPicker,
    IonButton,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonSpinner,
    IonToggle,
    ChatMute,
    ChatAvatar,
  ],
})
export class NotificationCategory {
  readonly compact = input(false);
  readonly kind = input.required<GroupKind>();
  protected readonly personIcon = personOutline;
  protected readonly groupIcon = peopleOutline;
  protected readonly bellIcon = notificationsOutline;
  protected readonly addIcon = personAddOutline;
  protected readonly trashIcon = trashOutline;
  protected readonly pickerOpen = signal(false);
  protected readonly clearing = signal(false);
  private readonly clearAlert = viewChild.required(IonAlert);
  protected readonly Kind = GroupKind;
  protected readonly store = inject(ChatStore);
  private readonly api = inject(UsersService);
  private readonly session = inject(SessionStore);
  private readonly account = computed(() => this.session.user()?.uid);
  private readonly realtime = inject(Connection);
  private readonly destroy = inject(DestroyRef);
  private readonly menu = viewChild.required(ChatMute);
  protected readonly page = signal<NotificationExceptionsResponse | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly saveError = signal(false);
  protected readonly editing = signal<SnowflakeID | undefined>(undefined);
  protected readonly avatar = conversationAvatar;
  private revision = 0;
  private pending?: Promise<void>;
  private dirty = false;

  constructor() {
    effect(() => {
      this.kind();
      this.account();
      // Account changes clear private rows; same-account refreshes retain them.
      this.page.set(undefined);
      this.saveError.set(false);
      this.editing.set(undefined);
      this.pickerOpen.set(false);
      this.clearing.set(false);
      untracked(() => void this.refresh());
    });
    this.store.preferenceChanges$.pipe(takeUntilDestroyed()).subscribe((kind) => {
      if (kind === this.kind()) void this.refresh();
    });
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe((reason) => {
      if (reason !== ResyncReason.Foreground || !this.realtime.connected()) void this.refresh();
    });
  }

  protected defaultMuted() {
    const defaults = this.store.notificationDefaults();
    return this.kind() === GroupKind.dm ? defaults?.muteDirectChatsByDefault : defaults?.muteGroupChatsByDefault;
  }

  protected async setDefault(event: ToggleCustomEvent) {
    const uid = this.account();
    this.saveError.set(false);
    try {
      await this.store.setNotificationDefault(this.kind(), !event.detail.checked);
    } catch {
      if (uid === this.account()) this.saveError.set(true);
    }
    if (uid === this.account()) event.target.checked = this.defaultMuted() === false;
  }

  protected async edit(chatId: SnowflakeID, restore = false) {
    if (this.editing() || this.clearing()) return;
    const uid = this.session.user()?.uid;
    this.editing.set(chatId);
    this.saveError.set(false);
    try {
      if (restore) await this.store.setNotificationSetting(chatId, { mode: NotificationSettingMode.inherit });
      else await this.menu().toggle(chatId);
    } catch {
      if (this.session.user()?.uid === uid) this.saveError.set(true);
    } finally {
      if (this.session.user()?.uid === uid) this.editing.set(undefined);
    }
  }

  protected async clearAll() {
    if (this.clearing() || this.editing()) return;
    const uid = this.account();
    this.clearing.set(true);
    this.saveError.set(false);
    try {
      const alert = this.clearAlert();
      await alert.present();
      const result = await alert.onDidDismiss();
      if (result.role === 'confirm' && uid === this.account())
        await this.store.clearNotificationExceptions(this.kind());
    } catch {
      if (uid === this.account()) this.saveError.set(true);
    } finally {
      if (uid === this.account()) this.clearing.set(false);
    }
  }

  refresh() {
    this.revision++;
    this.dirty = true;
    return this.load(false);
  }

  protected loadMore() {
    return this.load(true);
  }

  private load(more: boolean): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.session.user() || this.destroy.destroyed) return Promise.resolve();
    this.loading.set(true);
    this.error.set(false);
    const run = async () => {
      do {
        if (!this.account()) return;
        this.dirty = false;
        const version = this.revision;
        const stateVersion = this.store.snapshot();
        const uid = this.session.user()?.uid;
        const kind = this.kind();
        const current = this.page();
        const append = more && current?.nextCursor != null;
        const target = append ? 0 : (current?.exceptions.length ?? 0);
        const rows = append ? [...current!.exceptions] : [];
        let cursor = append ? current!.nextCursor : undefined;
        let result: NotificationExceptionsResponse;
        try {
          do {
            result = await firstValueFrom(
              this.api
                .getExceptions({ kind, after: cursor, limit: this.compact() ? 1 : 20 })
                .pipe(takeUntilDestroyed(this.destroy)),
            );
            if (this.destroy.destroyed || version !== this.revision || uid !== this.session.user()?.uid) break;
            rows.push(...result.exceptions);
            cursor = result.nextCursor;
          } while (cursor != null && rows.length < target);
          if (this.destroy.destroyed) return;
          if (version !== this.revision || uid !== this.session.user()?.uid) {
            more = false;
            continue;
          }
          this.store.acceptNotificationExceptions(rows, stateVersion);
          this.page.set({ ...result!, exceptions: rows });
          this.error.set(false);
        } catch {
          if (this.destroy.destroyed) return;
          if (version === this.revision && uid === this.session.user()?.uid) this.error.set(true);
        }
        more = false;
      } while (this.dirty);
    };
    this.pending = run().finally(() => {
      this.pending = undefined;
      this.loading.set(false);
    });
    return this.pending;
  }
}
