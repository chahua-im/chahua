import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { Connection } from '../api/connection';
import { encodeId } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { lastSeenBucket } from './presence-display';
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
    [0, 'recently'],
    [5 * 60_000 - 1, 'recently'],
    [5 * 60_000, 'within30m'],
    [30 * 60_000, 'within1h'],
    [60 * 60_000, 'within2h'],
    [2 * 60 * 60_000, 'within6h'],
    [6 * 60 * 60_000, 'within12h'],
    [12 * 60 * 60_000, 'within1day'],
    [24 * 60 * 60_000, 'within1week'],
    [7 * 24 * 60 * 60_000, 'within1month'],
    [30 * 24 * 60 * 60_000, 'longago'],
  ] as const)('assigns the exact bucket at %i milliseconds', (age, expected) => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(lastSeenBucket(new Date(now - age).toISOString(), now)).toBe(expected);
  });

  it('omits an unknown or invalid last-seen timestamp', () => {
    expect(lastSeenBucket(undefined, Date.now())).toBeUndefined();
    expect(lastSeenBucket('not-a-date', Date.now())).toBeUndefined();
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
