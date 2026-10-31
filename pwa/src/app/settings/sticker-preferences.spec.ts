import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ServerWsMessageType, type ServerWsMessage } from '../../generated/models';
import { RpcTestPeer, provideRpcTesting } from '../api/rpc-testing';
import { Connection } from '../api/connection';
import { decodeId, encodeId } from '../api/snowflake-id';
import { testUser } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { StickerPreferences, sortStickerPacksByPreference } from './sticker-preferences';

describe('StickerPreferences', () => {
  let events$: Subject<ServerWsMessage>;
  let peer: RpcTestPeer;
  let session: {
    user: WritableSignal<
      (typeof testUser & { stickerPackOrder: { stickerPackId: number; lastUsedOn: number }[] }) | undefined
    >;
    upsertStickerPackOrderItem: (item: { stickerPackId: number; lastUsedOn: number }) => void;
    removeStickerPackOrderItem: (packId: number) => void;
    replaceStickerPackOrder: (stickerPackOrder: { stickerPackId: number; lastUsedOn: number }[]) => void;
  };

  function configure() {
    TestBed.configureTestingModule({
      providers: [
        provideRpcTesting(),
        { provide: SessionStore, useValue: session },
        { provide: Connection, useValue: { events$ } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  }

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    events$ = new Subject<ServerWsMessage>();
    session = {
      user: signal({ ...testUser, stickerPackOrder: [] }),
      upsertStickerPackOrderItem: vi.fn((item) =>
        session.user.update((user) =>
          user
            ? {
                ...user,
                stickerPackOrder: [...user.stickerPackOrder, { ...item, lastUsedOn: Math.trunc(item.lastUsedOn) }],
              }
            : user,
        ),
      ),
      removeStickerPackOrderItem: vi.fn(),
      replaceStickerPackOrder: vi.fn((stickerPackOrder) =>
        session.user.update((user) => (user ? { ...user, stickerPackOrder } : user)),
      ),
    };
    configure();
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      try {
        vi.unstubAllGlobals();
      } finally {
        TestBed.resetTestingModule();
      }
    }
  });

  it('defaults both auto-sort toggles to off and persists their values locally', () => {
    const preferences = TestBed.inject(StickerPreferences);
    expect(preferences.autoSortPacksEnabled()).toBe(false);
    expect(preferences.autoSortFavoritesEnabled()).toBe(false);
    preferences.setAutoSortPacks(true);
    preferences.setAutoSortFavorites(true);
    expect(localStorage.getItem('chahua.preferences.autoSortStickerPacks')).toBe('true');
    expect(localStorage.getItem('chahua.preferences.autoSortFavoriteStickers')).toBe('true');
    TestBed.resetTestingModule();
    configure();
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
    expect(JSON.parse(localStorage.getItem('chahua.preferences.favoriteStickerOrder')!)).toEqual([
      { stickerId: '101', lastUsedOn: 70 },
      { stickerId: '102', lastUsedOn: 60 },
    ]);
    TestBed.resetTestingModule();
    configure();
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
    const serverOrder = [{ stickerPackId: encodeId('301'), lastUsedOn: 90 }];
    const preferences = TestBed.inject(StickerPreferences);
    preferences.upsertPackOrderItem({ stickerPackId: encodeId('201'), lastUsedOn: 30 });
    const sync = preferences.syncPackOrder([{ stickerPackId: encodeId('201'), lastUsedOn: 30 }]);
    peer
      .expect('users.updateStickerPackOrder', {
        order: [{ stickerPackId: '201', lastUsedOn: 30 }],
      })
      .error(1503);
    (await peer.expectAsync('users.getMe')).flush({
      ...testUser,
      stickerPackOrder: serverOrder.map(({ stickerPackId, lastUsedOn }) => ({
        stickerPackId: decodeId(stickerPackId),
        lastUsedOn,
      })),
    });
    expect(await sync).toBe(false);
    expect(session.user()?.stickerPackOrder).toEqual(serverOrder);
  });

  it('reports failure even when restoring the server order also fails', async () => {
    const preferences = TestBed.inject(StickerPreferences);
    const item = { stickerPackId: encodeId('201'), lastUsedOn: 30 };
    preferences.upsertPackOrderItem(item);
    const sync = preferences.syncPackOrder([item]);
    peer.expect('users.updateStickerPackOrder', { order: [{ stickerPackId: '201', lastUsedOn: 30 }] }).error(1503);
    (await peer.expectAsync('users.getMe')).error(1503);
    expect(await sync).toBe(false);
    expect(session.user()?.stickerPackOrder).toEqual([item]);
  });

  it('replaces the session order when the server pushes an update', () => {
    TestBed.inject(StickerPreferences);
    const order = [{ stickerPackId: encodeId('401'), lastUsedOn: 80 }];
    events$.next({ type: ServerWsMessageType.stickerPackOrderUpdated, payload: { order } });
    expect(session.user()?.stickerPackOrder).toEqual(order);
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
