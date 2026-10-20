import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { Connection } from '../api/connection';
import { encodeId } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { lastSeenBucket } from './presence-display';
import { Presence } from './presence';

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
    const events = new Subject<unknown>();
    const resync = new Subject<void>();
    const connected = signal(true);
    const watchPresence = vi.fn();
    const user = signal<{ uid: number } | undefined>({ uid: 1 });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Connection,
          useValue: { connected, events$: events, resync$: resync, watchPresence },
        },
        { provide: SessionStore, useValue: { user } },
      ],
    });
    const presence = TestBed.inject(Presence);
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
});
