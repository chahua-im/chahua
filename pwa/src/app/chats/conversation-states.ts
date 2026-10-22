import { computed, effect, signal, untracked, type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ServerWsMessageType, type ConversationRef, type ConversationState } from '../../generated/models';
import type { Connection } from '../api/connection';
import type { SessionStore } from '../session/session-store';

const key = (scope: ConversationRef) => `${scope.chatId}:${scope.threadId ?? ''}`;
const MAX_SCOPES = 512;

/** Shared explicit watches for the currently loaded list and open conversation. */
export function conversationStates(
  connection: Connection,
  session: SessionStore,
  destroy: DestroyRef,
  accept: (states: ConversationState[]) => void,
) {
  const consumers = signal(new Map<symbol, readonly ConversationRef[]>());
  const account = computed(() => session.user()?.uid);
  const scopes = computed(
    () =>
      [...new Map([...consumers().values()].flat().map((scope) => [key(scope), scope])).values()]
        .sort((a, b) => key(a).localeCompare(key(b)))
        .slice(0, MAX_SCOPES),
    { equal: (a, b) => a.length === b.length && a.every((scope, i) => key(scope) === key(b[i])) },
  );
  let requestId = 0;
  let fullRequestId = 0;
  let watchedUid: number | undefined;
  let selected = new Set<string>();
  let subscribed = false;
  const publish = () => {
    fullRequestId = 0;
    const id = ++requestId;
    watchedUid = account();
    selected = new Set();
    if (!connection.connected() || watchedUid == null) return;
    const refs = scopes();
    if (!refs.length && !subscribed) return;
    subscribed = !!refs.length;
    selected = new Set(refs.map(key));
    connection.watchConversationStates(id, refs);
  };
  effect(() => {
    account();
    connection.connected();
    scopes();
    untracked(publish);
  });
  connection.events$.pipe(takeUntilDestroyed(destroy)).subscribe((event) => {
    if (
      event.type !== ServerWsMessageType.conversationStates ||
      !connection.connected() ||
      account() !== watchedUid ||
      event.payload.requestId !== requestId
    )
      return;
    if (!event.payload.full && fullRequestId !== requestId) return;
    if (event.payload.full) fullRequestId = requestId;
    accept(event.payload.states.filter((state) => selected.has(key(state))));
  });
  destroy.onDestroy(() => {
    if (subscribed && connection.connected()) connection.watchConversationStates(++requestId, []);
  });
  return {
    watch: (refs: readonly ConversationRef[]) => {
      const token = Symbol();
      consumers.update((items) => new Map(items).set(token, refs));
      return () =>
        consumers.update((items) => {
          const next = new Map(items);
          next.delete(token);
          return next;
        });
    },
    selected: (scope: ConversationRef) =>
      connection.connected() && account() === watchedUid && selected.has(key(scope)),
    ready: (scope: ConversationRef) =>
      fullRequestId === requestId && connection.connected() && account() === watchedUid && selected.has(key(scope)),
    refresh: publish,
  };
}
