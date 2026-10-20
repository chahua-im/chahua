import { computed, DestroyRef, effect, inject, Service, signal, untracked } from '@angular/core';
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
const MAX_WATCHED_USERS = 100;
const MAX_WATCHED_GROUPS = 4;

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
  private publishedScope: { userIds: number[]; chatIds: SnowflakeID[] } = { userIds: [], chatIds: [] };
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
      if (!this.connection.connected() || !this.networkOnline() || this.sessionUid == null) {
        this.clear();
        if (this.connection.connected()) this.publish({ userIds: [], chatIds: [] });
        return;
      }
      this.publish(this.visible() ? scope : { userIds: [], chatIds: [] });
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

  /**
   * Removes authorization-sensitive user snapshots and publishes the watched scope again.
   * Group snapshots deliberately survive because individual privacy never changes group counts.
   */
  invalidateUsers(uids?: readonly number[]) {
    const affected = uids == null ? undefined : new Set(uids);
    const users = new Map(this.usersState());
    const pending = new Set(this.pendingUsers());
    if (affected) {
      for (const uid of affected) {
        users.delete(uid);
        pending.delete(uid);
      }
    } else {
      users.clear();
      pending.clear();
    }
    this.usersState.set(users);
    this.pendingUsers.set(pending);

    // Make an already in-flight snapshot stale even while no request can be published.
    this.publishedRequestId = ++this.requestId;
    if (this.live() && this.sessionUid != null) this.publish(this.scope());
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
    return { userIds: [...userIds].slice(0, MAX_WATCHED_USERS), chatIds: [...chatIds].slice(0, MAX_WATCHED_GROUPS) };
  }

  private publish(scope: { userIds: number[]; chatIds: SnowflakeID[] }) {
    const requestId = ++this.requestId;
    this.publishedScope = scope;
    this.publishedRequestId = requestId;
    const users = untracked(this.usersState);
    const groups = untracked(this.groupsState);
    this.pendingUsers.set(new Set(scope.userIds.filter((uid) => !users.has(uid))));
    this.pendingGroups.set(new Set(scope.chatIds.filter((chatId) => !groups.has(chatId))));
    this.connection.watchPresence(requestId, scope.userIds, scope.chatIds);
  }

  private clear() {
    this.publishedRequestId = 0;
    this.publishedScope = { userIds: [], chatIds: [] };
    this.usersState.set(new Map());
    this.groupsState.set(new Map());
    this.pendingUsers.set(new Set());
    this.pendingGroups.set(new Set());
  }

  private receive(snapshot: PresenceSnapshotPayload) {
    if (snapshot.requestId !== this.publishedRequestId) return;
    const users = new Map(this.usersState());
    for (const uid of this.publishedScope.userIds) users.delete(uid);
    for (const user of snapshot.users) users.set(user.uid, user);
    while (users.size > MAX_WATCHED_USERS) users.delete(users.keys().next().value!);
    const groups = new Map(this.groupsState());
    for (const chatId of this.publishedScope.chatIds) groups.delete(chatId);
    for (const group of snapshot.groups) groups.set(group.chatId, group);
    while (groups.size > MAX_WATCHED_GROUPS) groups.delete(groups.keys().next().value!);
    this.usersState.set(users);
    this.groupsState.set(groups);
    this.pendingUsers.set(new Set());
    this.pendingGroups.set(new Set());
  }
}
