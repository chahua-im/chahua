import { computed, DestroyRef, effect, inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ServerWsMessageType,
  type GroupPresenceResponse,
  type PresenceSnapshotPayload,
  type UserPresenceResponse,
} from '../../generated/models';
import { Connection } from '../api/connection';
import type { SnowflakeID } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';

export type PresenceScope = { userIds?: readonly number[]; chatIds?: readonly SnowflakeID[] };

const MINUTE_MS = 60_000;

/** Absolute, server-authorized presence snapshots for the scopes visible in the application. */
@Service()
export class Presence {
  private readonly connection = inject(Connection);
  private readonly session = inject(SessionStore);
  private readonly destroy = inject(DestroyRef);
  private readonly consumers = new Map<number, PresenceScope>();
  private readonly revision = signal(0);
  private readonly visible = signal(!document.hidden);
  private readonly networkOnline = signal(navigator.onLine);
  private readonly usersState = signal<ReadonlyMap<number, UserPresenceResponse>>(new Map());
  private readonly groupsState = signal<ReadonlyMap<SnowflakeID, GroupPresenceResponse>>(new Map());
  private readonly pendingUsers = signal<ReadonlySet<number>>(new Set());
  private readonly pendingGroups = signal<ReadonlySet<SnowflakeID>>(new Set());
  private readonly clock = signal(Date.now());
  private requestId = 0;
  private publishedRequestId = 0;
  private consumerId = 0;
  private sessionUid: number | undefined;

  readonly live = computed(() => this.connection.connected() && this.visible() && this.networkOnline());
  readonly now = this.clock.asReadonly();

  constructor() {
    const visibilityChanged = () => {
      this.visible.set(!document.hidden);
      if (!document.hidden) this.clock.set(Date.now());
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    this.destroy.onDestroy(() => document.removeEventListener('visibilitychange', visibilityChanged));
    const networkChanged = () => this.networkOnline.set(navigator.onLine);
    window.addEventListener('online', networkChanged);
    window.addEventListener('offline', networkChanged);
    this.destroy.onDestroy(() => {
      window.removeEventListener('online', networkChanged);
      window.removeEventListener('offline', networkChanged);
    });

    effect((onCleanup) => {
      this.revision();
      if (!this.visible() || !this.consumers.size) return;
      this.clock.set(Date.now());
      const interval = setInterval(() => this.clock.set(Date.now()), MINUTE_MS);
      onCleanup(() => clearInterval(interval));
    });
    effect(() => {
      const uid = this.session.user()?.uid;
      if (uid === this.sessionUid) return;
      this.sessionUid = uid;
      this.clear();
      this.revision.update((revision) => revision + 1);
    });
    effect(() => {
      const scope = this.scope();
      if (!this.live() || this.sessionUid == null) {
        this.clear();
        if (this.connection.connected()) this.publish({ userIds: [], chatIds: [] });
        return;
      }
      this.publish(scope);
    });
    this.connection.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === ServerWsMessageType.presenceSnapshot) this.receive(event.payload);
    });
    this.connection.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.clock.set(Date.now());
      if (this.live() && this.sessionUid != null) this.publish(this.scope());
    });
  }

  watch(scope: PresenceScope) {
    const id = ++this.consumerId;
    this.clock.set(Date.now());
    this.consumers.set(id, scope);
    this.revision.update((revision) => revision + 1);
    return () => {
      if (!this.consumers.delete(id)) return;
      this.revision.update((revision) => revision + 1);
    };
  }

  user(uid: number | undefined) {
    return uid == null || !this.live() ? undefined : this.usersState().get(uid);
  }

  userLoading(uid: number | undefined) {
    return uid != null && this.live() && this.pendingUsers().has(uid);
  }

  group(chatId: SnowflakeID | undefined) {
    return chatId == null || !this.live() ? undefined : this.groupsState().get(chatId);
  }

  groupLoading(chatId: SnowflakeID | undefined) {
    return chatId != null && this.live() && this.pendingGroups().has(chatId);
  }

  private scope() {
    this.revision();
    const userIds = new Set<number>();
    const chatIds = new Set<SnowflakeID>();
    for (const scope of this.consumers.values()) {
      for (const uid of scope.userIds ?? []) userIds.add(uid);
      for (const chatId of scope.chatIds ?? []) chatIds.add(chatId);
    }
    return { userIds: [...userIds].slice(0, 100), chatIds: [...chatIds].slice(0, 4) };
  }

  private publish(scope: { userIds: number[]; chatIds: SnowflakeID[] }) {
    const requestId = ++this.requestId;
    this.clear();
    this.publishedRequestId = requestId;
    this.pendingUsers.set(new Set(scope.userIds));
    this.pendingGroups.set(new Set(scope.chatIds));
    this.connection.watchPresence(requestId, scope.userIds, scope.chatIds);
  }

  private clear() {
    this.publishedRequestId = 0;
    this.usersState.set(new Map());
    this.groupsState.set(new Map());
    this.pendingUsers.set(new Set());
    this.pendingGroups.set(new Set());
  }

  private receive(snapshot: PresenceSnapshotPayload) {
    if (snapshot.requestId !== this.publishedRequestId) return;
    this.usersState.set(new Map(snapshot.users.map((user) => [user.uid, user])));
    this.groupsState.set(new Map(snapshot.groups.map((group) => [group.chatId, group])));
    this.pendingUsers.set(new Set());
    this.pendingGroups.set(new Set());
  }
}
