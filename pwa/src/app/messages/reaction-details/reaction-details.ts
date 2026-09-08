import { Component, computed, effect, inject, input, signal } from '@angular/core';
import {
  IonAvatar,
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
  ModalController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import type { ReactionDetailGroup, SnowflakeID } from '../../../generated/models';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';

@Component({
  selector: 'app-reaction-details',
  imports: [
    ContentScrollbars,
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
    IonAvatar,
    IonSpinner,
  ],
  host: { class: 'ion-page' },
  templateUrl: './reaction-details.html',
})
export class ReactionDetails {
  readonly chatId = input.required<SnowflakeID>();
  readonly messageId = input.required<SnowflakeID>();
  protected readonly modals = inject(ModalController);
  private readonly api = inject(ChatsService);
  protected readonly groups = signal<ReactionDetailGroup[]>([]);
  protected readonly emoji = signal('');
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly count = computed(() => this.groups().reduce((sum, group) => sum + group.reactors.length, 0));
  protected readonly visible = computed(() =>
    this.groups().filter((group) => !this.emoji() || group.emoji === this.emoji()),
  );
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
