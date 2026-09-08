import { Component, effect, inject, input, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  IonItem,
  IonList,
  IonLabel,
  IonAvatar,
  IonButton,
  IonSpinner,
  IonListHeader,
  ModalController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { GroupsService } from '../../../generated/endpoints/groups/groups.service';
import { UsersService } from '../../../generated/endpoints/users/users.service';
import {
  GroupSearchMode,
  GroupSelectorScope,
  type GroupSelectorItem,
  type MemberSummary,
  type SnowflakeID,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { UserProfile } from '../user-profile/user-profile';
@Component({
  selector: 'app-directory-search',
  templateUrl: './directory-search.html',
  imports: [IonItem, IonList, IonLabel, IonAvatar, IonButton, IonSpinner, IonListHeader],
})
export class DirectorySearch {
  readonly query = input('');
  readonly usersOnly = input(false);
  private readonly api = inject(GroupsService);
  private readonly users = inject(UsersService);
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly destroy = inject(DestroyRef);
  protected readonly groups = signal<GroupSelectorItem[]>([]);
  protected readonly people = signal<MemberSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly cursor = signal<SnowflakeID | undefined>(undefined);
  private version = 0;
  constructor() {
    effect(() => {
      this.query();
      this.usersOnly();
      void this.search();
    });
  }
  protected async search(more = false) {
    const q = this.query().trim();
    const version = ++this.version;
    if (!more) {
      this.groups.set([]);
      this.people.set([]);
      this.cursor.set(undefined);
    }
    if (!q) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set(false);
    try {
      const [groups, people] = await Promise.all([
        this.usersOnly()
          ? undefined
          : firstValueFrom(
              this.api
                .getGroups({
                  q,
                  mode: GroupSearchMode.submitted,
                  scope: GroupSelectorScope.joined,
                  limit: 40,
                  after: more ? this.cursor() : undefined,
                })
                .pipe(takeUntilDestroyed(this.destroy)),
            ),
        more
          ? undefined
          : firstValueFrom(this.users.getUserSearch({ q, limit: 40 }).pipe(takeUntilDestroyed(this.destroy))),
      ]);
      if (version !== this.version) return;
      if (groups) {
        this.groups.update((items) => (more ? [...items, ...groups.groups] : groups.groups));
        this.cursor.set(groups.nextCursor);
      }
      if (people) this.people.set(people.members);
    } catch {
      if (version === this.version) this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
  protected openChat(id: SnowflakeID) {
    void this.router.navigate(['/chats/chat', decodeId(id)]);
  }
  protected async profile(user: MemberSummary) {
    const modal = await this.modals.create({ component: UserProfile, componentProps: { user } });
    await modal.present();
  }
}
