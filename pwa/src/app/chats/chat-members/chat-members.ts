import { Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  IonAvatar,
  IonButton,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  ModalController,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { MembersService } from '../../../generated/endpoints/members/members.service';
import { GroupRole, type MemberResponse, type SnowflakeID } from '../../../generated/models';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { UserProfile } from '../user-profile/user-profile';
@Component({
  selector: 'app-chat-members',
  templateUrl: './chat-members.html',
  imports: [
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonNote,
    IonList,
    IonItem,
    IonLabel,
    IonAvatar,
    IonButton,
    IonSpinner,
  ],
})
export class ChatMembers {
  readonly chatId = input.required<SnowflakeID>();
  protected readonly Role = GroupRole;
  private readonly api = inject(MembersService);
  private readonly modals = inject(ModalController);
  private readonly destroy = inject(DestroyRef);
  private version = 0;
  protected readonly members = signal<MemberResponse[]>([]);
  protected readonly cursor = signal<number | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  constructor() {
    fillScrollViewport(this.loading, this.error, this.cursor, () => this.load(true));
    effect(() => {
      this.chatId();
      void this.load();
    });
  }
  protected async more(event: InfiniteScrollCustomEvent) {
    try {
      await this.load(true);
    } finally {
      await event.target.complete();
    }
  }
  protected async load(more = false) {
    if (more && (this.loading() || this.cursor() == null)) return;
    const version = ++this.version;
    if (!more) {
      this.members.set([]);
      this.cursor.set(undefined);
    }
    this.loading.set(true);
    this.error.set(false);
    try {
      const page = await firstValueFrom(
        this.api
          .getMembers(this.chatId(), {
            limit: 40,
            after: more ? this.cursor() : undefined,
          })
          .pipe(takeUntilDestroyed(this.destroy)),
      );
      if (version !== this.version) return;
      this.members.update((items) => (more ? [...items, ...page.members] : page.members));
      this.cursor.set(page.nextCursor);
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
}
