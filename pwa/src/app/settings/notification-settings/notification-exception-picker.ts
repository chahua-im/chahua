import { Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { GroupKind, NotificationSettingMode } from '../../../generated/models';
import { ChatListStore } from '../../chats/chat-list-store';
import { ChatStore } from '../../chats/chat-store';
import { ChatAvatar, conversationAvatar } from '../../chats/chat-avatar/chat-avatar';
import { SessionStore } from '../../session/session-store';
import type { SnowflakeID } from '../../api/snowflake-id';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';

@Component({
  selector: 'app-notification-exception-picker',
  templateUrl: './notification-exception-picker.html',
  imports: [
    TranslocoPipe,
    ContentScrollbars,
    ChatAvatar,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonItem,
    IonLabel,
    IonList,
    IonModal,
    IonNote,
    IonSearchbar,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class NotificationExceptionPicker {
  readonly kind = input.required<GroupKind>();
  readonly closed = output<void>();
  private readonly lists = inject(ChatListStore);
  protected readonly store = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly destroy = inject(DestroyRef);
  protected readonly sources = [this.lists.chats(false), this.lists.chats(true)];
  protected readonly open = signal(true);
  protected readonly query = signal('');
  protected readonly saving = signal<SnowflakeID | undefined>(undefined);
  protected readonly failed = signal(false);
  protected readonly avatar = conversationAvatar;
  protected readonly loading = computed(() => this.sources.some((source) => source.loading() || source.loadingMore()));
  protected readonly moreAvailable = computed(() => this.sources.some((source) => source.hasMore()));
  protected readonly targets = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    const rows = this.sources.flatMap((source) => source.items()).filter((chat) => chat.kind === this.kind());
    return [...new Map(rows.map((row) => [row.id, row])).values()].filter((chat) =>
      `${chat.peer?.username ?? chat.name} ${chat.peer?.uid ?? ''}`.toLocaleLowerCase().includes(query),
    );
  });
  constructor() {
    const releases = this.sources.map((source) => source.activate());
    this.destroy.onDestroy(() => releases.forEach((release) => release()));
  }
  protected more() {
    return Promise.all(
      this.sources.filter((source) => source.hasMore() && !source.error()).map((source) => source.loadMore()),
    );
  }
  protected async select(chatId: SnowflakeID) {
    if (this.saving() || !this.open()) return;
    const uid = this.session.user()?.uid;
    const defaults = this.store.notificationDefaults();
    if (!defaults) return;
    const muted = this.kind() === GroupKind.dm ? defaults.muteDirectChatsByDefault : defaults.muteGroupChatsByDefault;
    this.saving.set(chatId);
    this.failed.set(false);
    try {
      await this.store.setNotificationSetting(chatId, {
        mode: muted ? NotificationSettingMode.alwaysUnmuted : NotificationSettingMode.alwaysMuted,
      });
      if (!this.destroy.destroyed && uid === this.session.user()?.uid) this.open.set(false);
    } catch {
      if (!this.destroy.destroyed && uid === this.session.user()?.uid) this.failed.set(true);
    } finally {
      if (!this.destroy.destroyed && uid === this.session.user()?.uid) this.saving.set(undefined);
    }
  }
}
