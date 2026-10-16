import { TestBed } from '@angular/core/testing';
import { vi, type MockInstance } from 'vitest';
import { Subject, of, throwError } from 'rxjs';
import { AuthService } from '../../generated/endpoints/auth/auth.service';
import { UsersService } from '../../generated/endpoints/users/users.service';
import {
  ServerWsMessageType,
  type MeResponse,
  type ServerWsMessage,
} from '../../generated/models';
import { encodeId } from '../api/snowflake-id';
import { mockRealtime, testUser } from '../api/testing';
import { Connection } from '../api/connection';
import { SessionStore } from '../session/session-store';
import { StickerPreferences, sortStickerPacksByPreference } from './sticker-preferences';

describe('StickerPreferences', () => {
  let events$: Subject<ServerWsMessage>;
  let getMe: MockInstance;
  let putStickerpackOrder: MockInstance;
  let session: SessionStore;

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const realtime = mockRealtime();
    events$ = realtime.events$ as Subject<ServerWsMessage>;
    getMe = vi.fn();
    putStickerpackOrder = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: UsersService, useValue: { getMe, putStickerpackOrder } },
        { provide: Connection, useValue: realtime },
      ],
    });
    session = TestBed.inject(SessionStore);
    session.user.set({ ...testUser, stickerPackOrder: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('defaults both auto-sort toggles to off and persists them across fresh services', () => {
    const preferences = TestBed.inject(StickerPreferences);
    expect(preferences.autoSortPacksEnabled()).toBe(false);
    expect(preferences.autoSortFavoritesEnabled()).toBe(false);
    preferences.setAutoSortPacks(true);
    preferences.setAutoSortFavorites(true);
    TestBed.resetTestingModule();
    const restored = TestBed.inject(StickerPreferences);
    expect(restored.autoSortPacksEnabled()).toBe(true);
    expect(restored.autoSortFavoritesEnabled()).toBe(true);
    restored.setAutoSortPacks(false);
    restored.setAutoSortFavorites(false);
  });

  it('keeps the favorite order deduplicated and truncated', () => {
    const preferences = TestBed.inject(StickerPreferences);
    preferences.upsertFavoriteStickerOrderItem({ stickerId: encodeId('101'), lastUsedOn: 50.9 });
    preferences.upsertFavoriteStickerOrderItem({ stickerId: encodeId('102'), lastUsedOn: 60 });
    preferences.upsertFavoriteStickerOrderItem({ stickerId: encodeId('101'), lastUsedOn: 70 });
    expect(preferences.favoriteStickerOrder()).toEqual([
      { stickerId: encodeId('101'), lastUsedOn: 70 },
      { stickerId: encodeId('102'), lastUsedOn: 60 },
    ]);
    TestBed.resetTestingModule();
    expect(TestBed.inject(StickerPreferences).favoriteStickerOrder()).toEqual([
      { stickerId: encodeId('101'), lastUsedOn: 70 },
      { stickerId: encodeId('102'), lastUsedOn: 60 },
    ]);
  });

  it('reads the pack order from the session and upserts through it', () => {
    const preferences = TestBed.inject(StickerPreferences);
    expect(preferences.packOrder()).toEqual([]);
    preferences.upsertPackOrderItem({ stickerPackId: encodeId('201'), lastUsedOn: 30.4 });
    expect(session.user()?.stickerPackOrder).toEqual([{ stickerPackId: encodeId('201'), lastUsedOn: 30 }]);
  });

  it('heals a failed sync by re-reading the server order', async () => {
    putStickerpackOrder.mockReturnValue(throwError(() => new Error('offline')));
    const serverOrder = [{ stickerPackId: encodeId('301'), lastUsedOn: 90 }];
    getMe.mockReturnValue(of({ ...testUser, stickerPackOrder: serverOrder } satisfies MeResponse));
    const preferences = TestBed.inject(StickerPreferences);
    preferences.upsertPackOrderItem({ stickerPackId: encodeId('201'), lastUsedOn: 30 });
    await preferences.syncPackOrder([{ stickerPackId: encodeId('201'), lastUsedOn: 30 }]);
    expect(session.user()?.stickerPackOrder).toEqual(serverOrder);
  });

  it('replaces the session order when the server pushes an update', () => {
    const pushes = new Subject<ServerWsMessage>();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: UsersService, useValue: { getMe, putStickerpackOrder } },
        { provide: Connection, useValue: mockRealtime({ events$: pushes }) },
      ],
    });
    const fresh = TestBed.inject(SessionStore);
    fresh.user.set({ ...testUser, stickerPackOrder: [] });
    TestBed.inject(StickerPreferences);
    const order = [{ stickerPackId: encodeId('401'), lastUsedOn: 80 }];
    pushes.next({ type: ServerWsMessageType.stickerPackOrderUpdated, payload: { order } });
    expect(fresh.user()?.stickerPackOrder).toEqual(order);
  });

  it('sorts packs by last used time, ordered before unordered, stable otherwise', () => {
    const a = { id: encodeId('1'), name: 'a' };
    const b = { id: encodeId('2'), name: 'b' };
    const c = { id: encodeId('3'), name: 'c' };
    const order = [
      { stickerPackId: encodeId('2'), lastUsedOn: 10 },
      { stickerPackId: encodeId('1'), lastUsedOn: 20 },
    ];
    expect(sortStickerPacksByPreference([c, b, a], order)).toEqual([a, b, c]);
    expect(sortStickerPacksByPreference([a, b, c], [])).toEqual([a, b, c]);
  });
});
