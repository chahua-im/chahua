import { computed, DestroyRef, effect, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ServerWsMessageType, type ConversationUnreadSummary } from '../../generated/models';
import { Connection } from '../api/connection';
import { SessionStore } from '../session/session-store';
import { builtinConversationViews } from './conversation-views';

/** Shared connection-scoped snapshots for tabs, archive entries, titles and the app icon. */
export function conversationUnread(connection: Connection, session: SessionStore, destroy: DestroyRef) {
  const account = computed(() => session.user()?.uid);
  const consumers = signal(0);
  const active = computed(() => consumers() > 0);
  const snapshot = signal<
    | {
        uid: number;
        summaries: ConversationUnreadSummary[];
        appBadgeCount?: number;
      }
    | undefined
  >(undefined);
  const loading = signal(false);
  const error = signal(false);
  let requestId = 0;
  let fullRequestId = 0;
  let watchedUid: number | undefined;
  let subscribed = false;

  const publish = (watch: boolean) => {
    fullRequestId = 0;
    const id = ++requestId;
    if (!connection.connected()) return;
    if (!watch && !subscribed) return;
    subscribed = watch;
    watchedUid = account();
    loading.set(watch);
    error.set(false);
    connection.watchConversationUnread(id, watch ? builtinConversationViews() : [], watch);
  };
  effect(() => {
    const uid = account();
    const connected = connection.connected();
    const watching = active();
    untracked(() => {
      if (snapshot()?.uid !== uid) snapshot.set(undefined);
      if (!connected) {
        subscribed = false;
        ++requestId;
        fullRequestId = 0;
        loading.set(false);
        return;
      }
      publish(watching && uid != null);
    });
  });
  connection.events$.pipe(takeUntilDestroyed(destroy)).subscribe((event) => {
    if (!active() || !connection.connected() || account() !== watchedUid) return;
    if (event.type === ServerWsMessageType.conversationUnreadError) {
      if (event.payload.requestId === requestId) {
        error.set(true);
        loading.set(false);
      }
      return;
    }
    if (event.type !== ServerWsMessageType.conversationUnread || event.payload.requestId !== requestId) return;
    const uid = account();
    if (uid == null) return;
    const payload = event.payload;
    if (!payload.full && fullRequestId !== requestId) return;
    if (payload.full) fullRequestId = requestId;
    const summaries = new Map((payload.full ? [] : (snapshot()?.summaries ?? [])).map((s) => [s.key, s]));
    for (const summary of payload.summaries) summaries.set(summary.key, summary);
    snapshot.set({
      uid,
      summaries: [...summaries.values()],
      appBadgeCount: payload.appBadgeCount ?? (payload.full ? undefined : snapshot()?.appBadgeCount),
    });
    error.set(false);
    loading.set(false);
  });
  destroy.onDestroy(() => {
    if (active() && connection.connected()) publish(false);
  });
  const current = computed(() => (snapshot()?.uid === account() ? snapshot() : undefined));
  return {
    value: computed(() => current()?.summaries),
    appBadgeCount: computed(() => current()?.appBadgeCount),
    loading: loading.asReadonly(),
    error: error.asReadonly(),
    activate: () => {
      consumers.update((count) => count + 1);
      return () => consumers.update((count) => count - 1);
    },
    refresh: () => {
      if (active() && session.user()) publish(true);
    },
  };
}
