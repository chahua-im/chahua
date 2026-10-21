import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { Connection } from '../api/connection';
import { encodeId } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { lastSeenDisplay, LastSeenKind } from './presence-display';
import { Presence } from './presence';

function createPresenceHarness() {
  const events = new Subject<unknown>();
  const resync = new Subject<void>();
  const connected = signal(true);
  const watchPresence = vi.fn();
  const user = signal<{ uid: number } | undefined>({ uid: 1 });
  TestBed.configureTestingModule({
    providers: [
      { provide: Connection, useValue: { connected, events$: events, resync$: resync, watchPresence } },
      { provide: SessionStore, useValue: { user } },
    ],
  });
  return { presence: TestBed.inject(Presence), events, resync, connected, watchPresence, user };
}

describe('presence', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it.each([
    [0, LastSeenKind.JustNow, undefined],
    [59_999, LastSeenKind.JustNow, undefined],
    [60_000, LastSeenKind.Minute, 1],
    [120_000, LastSeenKind.Minutes, 2],
    [3_599_999, LastSeenKind.Minutes, 59],
    [3_600_000, LastSeenKind.Hour, 1],
    [7_200_000, LastSeenKind.Hours, 2],
    [43_199_999, LastSeenKind.Hours, 11],
    [43_200_000, LastSeenKind.Today, undefined],
  ] as const)('formats recent activity at %i ms', (age, kind, count) => {
    const now = new Date(2026, 9, 21, 18).getTime();
    const result = lastSeenDisplay(new Date(now - age).toISOString(), now);
    expect(result?.kind).toBe(kind);
    expect(result?.count).toBe(count);
  });

  it('uses local calendar days and omits the year only for dates in the current year', () => {
    const now = new Date(2026, 0, 2, 18).getTime();
    expect(lastSeenDisplay(new Date(2026, 0, 1, 23).toISOString(), now)?.kind).toBe(LastSeenKind.Yesterday);
    expect(lastSeenDisplay(new Date(2025, 11, 31).toISOString(), now)).toEqual({
      kind: LastSeenKind.Date,
      dateFormat: 'date',
    });
    expect(lastSeenDisplay(new Date(2026, 0, 1).toISOString(), new Date(2026, 9, 21).getTime())).toEqual({
      kind: LastSeenKind.Date,
      dateFormat: 'monthDay',
    });
    expect(lastSeenDisplay(new Date(now + 60_000).toISOString(), now)?.kind).toBe(LastSeenKind.JustNow);
    expect(lastSeenDisplay(undefined, now)).toBeUndefined();
    expect(lastSeenDisplay('not-a-date', now)).toBeUndefined();
  });

  it('replaces exact cached activity with a private bucket and rejects an older response', () => {
    const { presence, events, watchPresence, resync } = createPresenceHarness();
    presence.watch({ userIds: [2] });
    TestBed.tick();
    const oldRequest = watchPresence.mock.lastCall![0];
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: oldRequest,
        users: [{ uid: 2, online: true, lastSeenAt: '2026-10-21T10:00:00Z' }],
        groups: [],
      },
    });
    resync.next();
    const requestId = watchPresence.mock.lastCall![0];
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId,
        users: [{ uid: 2, online: false, lastSeenBucket: 'recently' }],
        groups: [],
      },
    });
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: oldRequest,
        users: [{ uid: 2, online: true, lastSeenAt: '2026-10-21T10:00:00Z' }],
        groups: [],
      },
    });
    expect(presence.user(2)).toEqual({ uid: 2, online: false, lastSeenBucket: 'recently' });
  });

  it('shows scoped loading only until the current snapshot resolves, including omitted entries', () => {
    const network = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { presence, events, connected, watchPresence, user } = createPresenceHarness();
    const release = presence.watch({ userIds: [2], chatIds: [encodeId('9007199254740993')] });
    TestBed.tick();
    const requestId = watchPresence.mock.calls.at(-1)![0] as number;
    expect(presence.userLoading(2)).toBe(true);
    expect(presence.groupLoading(encodeId('9007199254740993'))).toBe(true);
    events.next({
      type: 'presenceSnapshot',
      payload: { users: [{ uid: 2, online: true }], groups: [] },
    });
    expect(presence.user(2)).toBeUndefined();
    expect(presence.userLoading(2)).toBe(true);
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: requestId - 1,
        users: [{ uid: 2, online: true }],
        groups: [],
      },
    });
    expect(presence.user(2)).toBeUndefined();
    expect(presence.userLoading(2)).toBe(true);
    expect(presence.groupLoading(encodeId('9007199254740993'))).toBe(true);
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId,
        users: [{ uid: 2, online: true }],
        groups: [],
      },
    });
    expect(presence.user(2)?.online).toBe(true);
    expect(presence.userLoading(2)).toBe(false);
    expect(presence.group(encodeId('9007199254740993'))).toBeUndefined();
    expect(presence.groupLoading(encodeId('9007199254740993'))).toBe(false);
    network.mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    TestBed.tick();
    expect(presence.user(2)).toBeUndefined();
    expect(presence.group(encodeId('9007199254740993'))).toBeUndefined();
    expect(presence.userLoading(2)).toBe(false);
    expect(presence.groupLoading(encodeId('9007199254740993'))).toBe(false);
    network.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    TestBed.tick();
    expect(presence.user(2)).toBeUndefined();
    const resumedRequestId = watchPresence.mock.calls.at(-1)![0] as number;
    expect(presence.userLoading(2)).toBe(true);
    expect(presence.groupLoading(encodeId('9007199254740993'))).toBe(true);
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: resumedRequestId,
        users: [{ uid: 2, online: false }],
        groups: [{ chatId: encodeId('9007199254740993'), memberCount: 5, onlineCount: 2 }],
      },
    });
    expect(presence.user(2)?.online).toBe(false);
    expect(presence.userLoading(2)).toBe(false);
    expect(presence.group(encodeId('9007199254740993'))?.onlineCount).toBe(2);
    user.set(undefined);
    TestBed.tick();
    expect(presence.user(2)).toBeUndefined();
    expect(presence.group(encodeId('9007199254740993'))).toBeUndefined();
    expect(presence.userLoading(2)).toBe(false);
    expect(presence.groupLoading(encodeId('9007199254740993'))).toBe(false);
    connected.set(false);
    TestBed.tick();
    expect(presence.user(2)).toBeUndefined();
    release();
  });

  it('invalidates individual snapshots and rejects stale replies without clearing group counts', () => {
    const { presence, events, watchPresence } = createPresenceHarness();
    const chatId = encodeId('9007199254740993');
    const release = presence.watch({ userIds: [2, 3], chatIds: [chatId] });
    TestBed.tick();
    const firstRequestId = watchPresence.mock.calls.at(-1)![0] as number;
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: firstRequestId,
        users: [
          { uid: 2, online: true },
          { uid: 3, online: true },
        ],
        groups: [{ chatId, memberCount: 5, onlineCount: 2 }],
      },
    });
    release();
    const watchCurrent = presence.watch({ userIds: [2], chatIds: [chatId] });
    TestBed.tick();
    const beforeInvalidation = watchPresence.mock.calls.at(-1)![0] as number;

    presence.invalidateUsers();

    const refreshedRequestId = watchPresence.mock.calls.at(-1)![0] as number;
    expect(refreshedRequestId).toBeGreaterThan(beforeInvalidation);
    expect(presence.user(2)).toBeUndefined();
    expect(presence.user(3)).toBeUndefined();
    expect(presence.userLoading(2)).toBe(true);
    expect(presence.group(chatId)?.onlineCount).toBe(2);
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: beforeInvalidation,
        users: [{ uid: 2, online: true }],
        groups: [{ chatId, memberCount: 5, onlineCount: 0 }],
      },
    });
    expect(presence.user(2)).toBeUndefined();
    expect(presence.group(chatId)?.onlineCount).toBe(2);
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: refreshedRequestId,
        users: [{ uid: 2, online: false }],
        groups: [{ chatId, memberCount: 5, onlineCount: 2 }],
      },
    });
    expect(presence.user(2)?.online).toBe(false);
    expect(presence.group(chatId)?.onlineCount).toBe(2);
    watchCurrent();
  });

  it('invalidates only the selected friend while retaining other individual snapshots', () => {
    const { presence, events, watchPresence } = createPresenceHarness();
    const chatId = encodeId('9007199254740993');
    const release = presence.watch({ userIds: [2, 3], chatIds: [chatId] });
    TestBed.tick();
    const requestId = watchPresence.mock.calls.at(-1)![0] as number;
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId,
        users: [
          { uid: 2, online: true },
          { uid: 3, online: true },
        ],
        groups: [{ chatId, memberCount: 5, onlineCount: 2 }],
      },
    });

    presence.invalidateUsers([2]);

    const refreshedRequestId = watchPresence.mock.calls.at(-1)![0] as number;
    expect(presence.user(2)).toBeUndefined();
    expect(presence.user(3)?.online).toBe(true);
    expect(presence.group(chatId)?.onlineCount).toBe(2);
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId,
        users: [{ uid: 2, online: true }],
        groups: [{ chatId, memberCount: 5, onlineCount: 0 }],
      },
    });
    expect(presence.user(2)).toBeUndefined();
    expect(presence.user(3)?.online).toBe(true);
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: refreshedRequestId,
        users: [
          { uid: 2, online: false },
          { uid: 3, online: true },
        ],
        groups: [{ chatId, memberCount: 5, onlineCount: 2 }],
      },
    });
    expect(presence.user(2)?.online).toBe(false);
    expect(presence.user(3)?.online).toBe(true);
    release();
  });

  it('keeps known presence while changing scopes and resyncing, then applies offline and omitted results', () => {
    const { presence, events, resync, watchPresence } = createPresenceHarness();
    const chatId = encodeId('9007199254740993');
    const leave = presence.watch({ userIds: [2], chatIds: [chatId] });
    TestBed.tick();
    const firstRequestId = watchPresence.mock.calls.at(-1)![0] as number;
    const requestsBeforeReply = watchPresence.mock.calls.length;
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: firstRequestId,
        users: [{ uid: 2, online: true }],
        groups: [{ chatId, memberCount: 5, onlineCount: 2 }],
      },
    });
    TestBed.tick();
    expect(watchPresence.mock.calls).toHaveLength(requestsBeforeReply);
    leave();
    TestBed.tick();
    const leaveNext = presence.watch({ userIds: [2, 3], chatIds: [chatId] });
    TestBed.tick();
    expect(presence.user(2)?.online).toBe(true);
    expect(presence.userLoading(2)).toBe(false);
    expect(presence.userLoading(3)).toBe(true);
    expect(presence.group(chatId)?.onlineCount).toBe(2);
    expect(presence.groupLoading(chatId)).toBe(false);

    resync.next();
    const currentRequestId = watchPresence.mock.calls.at(-1)![0] as number;
    expect(presence.user(2)?.online).toBe(true);
    expect(presence.userLoading(2)).toBe(false);
    events.next({
      type: 'presenceSnapshot',
      payload: { requestId: firstRequestId, users: [{ uid: 2, online: false }], groups: [] },
    });
    expect(presence.user(2)?.online).toBe(true);
    expect(presence.group(chatId)?.onlineCount).toBe(2);
    events.next({
      type: 'presenceSnapshot',
      payload: {
        requestId: currentRequestId,
        users: [
          { uid: 2, online: false },
          { uid: 3, online: true },
        ],
        groups: [{ chatId, memberCount: 6, onlineCount: 1 }],
      },
    });
    expect(presence.user(2)?.online).toBe(false);
    expect(presence.user(3)?.online).toBe(true);
    expect(presence.userLoading(3)).toBe(false);
    expect(presence.group(chatId)?.onlineCount).toBe(1);
    events.next({
      type: 'presenceSnapshot',
      payload: { requestId: currentRequestId, users: [{ uid: 3, online: true }], groups: [] },
    });
    expect(presence.user(2)).toBeUndefined();
    expect(presence.group(chatId)).toBeUndefined();
    expect(presence.userLoading(2)).toBe(false);
    leaveNext();
  });

  it('retains known presence across document visibility changes but clears it after disconnect or account change', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { presence, events, connected, watchPresence, user } = createPresenceHarness();
    const leave = presence.watch({ userIds: [2] });
    TestBed.tick();
    const firstRequestId = watchPresence.mock.calls.at(-1)![0] as number;
    events.next({
      type: 'presenceSnapshot',
      payload: { requestId: firstRequestId, users: [{ uid: 2, online: true }], groups: [] },
    });
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    TestBed.tick();
    expect(presence.user(2)).toBeUndefined();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    TestBed.tick();
    expect(presence.user(2)?.online).toBe(true);
    expect(presence.userLoading(2)).toBe(false);

    connected.set(false);
    TestBed.tick();
    expect(presence.user(2)).toBeUndefined();
    connected.set(true);
    TestBed.tick();
    expect(presence.user(2)).toBeUndefined();
    expect(presence.userLoading(2)).toBe(true);
    events.next({
      type: 'presenceSnapshot',
      payload: { requestId: firstRequestId, users: [{ uid: 2, online: true }], groups: [] },
    });
    expect(presence.user(2)).toBeUndefined();
    const currentRequestId = watchPresence.mock.calls.at(-1)![0] as number;
    events.next({
      type: 'presenceSnapshot',
      payload: { requestId: currentRequestId, users: [{ uid: 2, online: true }], groups: [] },
    });
    expect(presence.user(2)?.online).toBe(true);
    user.set({ uid: 9 });
    TestBed.tick();
    expect(presence.user(2)).toBeUndefined();
    leave();
  });
});
