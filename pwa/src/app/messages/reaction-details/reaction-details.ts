import { Component, computed, effect, inject, input, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import type { ReactionDetailGroup, ReactionReactor, SnowflakeID } from '../../../generated/models';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';

@Component({
  selector: 'app-reaction-details',
  imports: [
    TranslocoPipe,
    ChatAvatar,
    ContentScrollbars,
    LoadError,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonList,
    IonItem,
    IonSpinner,
  ],
  host: { class: 'ion-page' },
  templateUrl: './reaction-details.html',
})
export class ReactionDetails {
  readonly chatId = input.required<SnowflakeID>();
  readonly messageId = input.required<SnowflakeID>();
  protected readonly panels = inject(PanelNavigation);
  private readonly api = inject(ChatsService);
  protected readonly groups = signal<ReactionDetailGroup[]>([]);
  protected readonly emoji = signal('');
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly count = computed(() => this.groups().reduce((sum, group) => sum + group.reactors.length, 0));
  protected readonly visible = computed(() => {
    const reactions = this.groups()
      .filter((group) => !this.emoji() || group.emoji === this.emoji())
      .flatMap((group) => group.reactors.map((user) => ({ user, emoji: group.emoji })))
      // The details endpoint always supplies the global chronological sortIndex.
      .sort((a, b) => a.user.sortIndex! - b.user.sortIndex!);
    const users = new Map<number, { user: ReactionReactor; emojis: string[] }>();
    for (const { user, emoji } of reactions) {
      const row = users.get(user.uid);
      if (row) {
        row.emojis.push(emoji);
      } else {
        users.set(user.uid, { user, emojis: [emoji] });
      }
    }
    return [...users.values()];
  });
  constructor() {
    effect(() => {
      this.chatId();
      this.messageId();
      void this.load();
    });
  }
  protected async load() {
    this.loading.set(true);
    this.error.set(false);
    try {
      this.groups.set((await firstValueFrom(this.api.getReactionDetails(this.chatId(), this.messageId()))).reactions);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
