import { DestroyRef, inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { GroupsService } from '../../generated/endpoints/groups/groups.service';
import type { ChatListItem, GroupInfoResponse } from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';
import { Connection } from '../api/connection';

export type ChatInfo = Pick<ChatListItem, 'kind' | 'name' | 'avatar' | 'peer'> & Pick<GroupInfoResponse, 'myRole'>;

@Service()
export class ChatStore {
  private readonly api = inject(GroupsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly entries = signal(new Map<SnowflakeID, ChatInfo>());
  private readonly fresh = new Set<SnowflakeID>();
  private readonly detailsFresh = new Set<SnowflakeID>();
  private readonly requests = new Map<SnowflakeID, Promise<void>>();
  private revision = 0;

  constructor() {
    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => this.invalidate());
  }

  get(id: SnowflakeID): ChatInfo | undefined {
    return this.entries().get(id);
  }

  remember(chats: readonly (ChatInfo & { id: SnowflakeID })[]) {
    if (!chats.length) return;
    this.entries.update((entries) => {
      const next = new Map(entries);
      for (const { id, kind, name, avatar, peer } of chats) {
        next.set(id, { ...entries.get(id), kind, name, avatar, peer });
        this.fresh.add(id);
      }
      return next;
    });
  }

  invalidate() {
    this.revision++;
    this.fresh.clear();
    this.detailsFresh.clear();
  }

  ensure(id: SnowflakeID): Promise<void> {
    if (this.fresh.has(id)) return Promise.resolve();
    return this.ensureDetails(id);
  }

  ensureDetails(id: SnowflakeID): Promise<void> {
    if (this.detailsFresh.has(id)) return Promise.resolve();
    const pending = this.requests.get(id);
    if (pending) return pending;
    const request = (async () => {
      while (!this.destroyRef.destroyed && !this.detailsFresh.has(id)) {
        const revision = this.revision;
        const cached = this.entries().get(id);
        const chat = await firstValueFrom(this.api.getGroup(id).pipe(takeUntilDestroyed(this.destroyRef)));
        if (revision !== this.revision) continue;
        if (this.entries().get(id) === cached) this.remember([chat]);
        this.entries.update((entries) => new Map(entries).set(id, { ...entries.get(id)!, myRole: chat.myRole }));
        this.detailsFresh.add(id);
      }
    })().finally(() => this.requests.delete(id));
    this.requests.set(id, request);
    return request;
  }
}
