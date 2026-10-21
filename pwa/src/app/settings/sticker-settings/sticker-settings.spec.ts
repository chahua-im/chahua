import { TestBed } from '@angular/core/testing';
import { vi, type MockInstance } from 'vitest';
import { of, Subject, throwError } from 'rxjs';
import { StickersService } from '../../../generated/endpoints/stickers/stickers.service';
import type { StickerPackSummary } from '../../../generated/models';
import { encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { AlertController, ModalController } from '@ionic/angular';
import { Router } from '@angular/router';
import { StickerPreferences } from '../sticker-preferences';
import { StickerSettings } from './sticker-settings';

describe('StickerSettings', () => {
  const ownedPack: StickerPackSummary = {
    id: encodeId('201'),
    name: '我的包',
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: '2026-09-08T00:00:00Z',
    ownerUid: 1,
    isSubscribed: true,
    stickerCount: 3,
  };
  const subscribed: StickerPackSummary = {
    ...ownedPack,
    id: encodeId('202'),
    name: '订阅包',
    ownerUid: 2,
  };
  const other: StickerPackSummary = { ...ownedPack, id: encodeId('203'), name: '另一个包', ownerUid: 3 };
  const api = {
    getMyOwnedPacks: vi.fn(() => of({ packs: [ownedPack] })),
    getMySubscribedPacks: vi.fn(() => of({ packs: [subscribed, other] })),
    postPack: vi.fn(() => of({ ...ownedPack, id: encodeId('301'), name: '新包', stickers: [] })),
  };
  const preferences = {
    autoSortPacksEnabled: vi.fn(() => false),
    autoSortFavoritesEnabled: vi.fn(() => false),
    packOrder: vi.fn(() => [] as { stickerPackId: SnowflakeID; lastUsedOn: number }[]),
    upsertPackOrderItem: vi.fn(),
    syncPackOrder: vi.fn(async () => true),
  };
  const alerts = {
    create: vi.fn(async () => ({
      present: async () => {},
      onDidDismiss: async () => ({ role: 'confirm', data: { values: { name: ' 新包 ' } } }),
    })),
  };
  const navigate = vi.fn(async () => true);

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.clearAllMocks();
    api.getMyOwnedPacks.mockReturnValue(of({ packs: [ownedPack] }));
    api.getMySubscribedPacks.mockReturnValue(of({ packs: [subscribed, other] }));
    TestBed.configureTestingModule({
      providers: [
        { provide: StickersService, useValue: api },
        { provide: StickerPreferences, useValue: preferences },
        { provide: ModalController, useValue: { dismiss: vi.fn() } },
        { provide: AlertController, useValue: alerts },
        { provide: Router, useValue: { navigate } },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  function page() {
    return TestBed.createComponent(StickerSettings).componentInstance as StickerSettings;
  }

  async function loaded() {
    const component = page();
    await vi.waitFor(() => expect(component['loading']()).toBe(false));
    return component;
  }

  it('merges owned and subscribed packs, sorting by usage order and flagging owned', async () => {
    preferences.packOrder.mockReturnValue([
      { stickerPackId: other.id, lastUsedOn: 100 },
      { stickerPackId: ownedPack.id, lastUsedOn: 50 },
    ]);
    const component = await loaded();
    expect(component['ownedIds']()).toEqual(new Set([ownedPack.id]));
    expect(component['orderedPacks']().map((pack) => pack.id)).toEqual([other.id, ownedPack.id, subscribed.id]);
  });

  it('creates a pack from the alert name, records its order and opens the detail page', async () => {
    const component = await loaded();
    await component['createPack']();
    expect(api.postPack).toHaveBeenCalledWith({ name: '新包' });
    expect(preferences.upsertPackOrderItem).toHaveBeenCalledWith({
      stickerPackId: encodeId('301'),
      lastUsedOn: expect.any(Number),
    });
    expect(navigate).toHaveBeenCalledWith(['/settings/stickers', '301']);
    expect(component['packs']()[0].name).toBe('新包');
  });

  it('prevents duplicate creation while the request is pending', async () => {
    const response = new Subject<
      ReturnType<typeof api.postPack> extends import('rxjs').Observable<infer T> ? T : never
    >();
    api.postPack.mockReturnValueOnce(response);
    const component = await loaded();
    const pending = component['createPack']();
    await vi.waitFor(() => expect(api.postPack).toHaveBeenCalledOnce());
    expect(component['creating']()).toBe(true);
    await component['createPack']();
    expect(alerts.create).toHaveBeenCalledOnce();
    response.next({ ...ownedPack, id: encodeId('301'), name: '新包', stickers: [] });
    response.complete();
    await pending;
    expect(component['creating']()).toBe(false);
  });

  it('exposes a failed reorder and retries the same intended order', async () => {
    preferences.syncPackOrder.mockResolvedValueOnce(false);
    const component = await loaded();
    await component['reorder']({
      detail: { to: 0, complete: () => [other, ownedPack, subscribed] },
    } as unknown as CustomEvent);
    expect(component['orderFailed']()).toBe(true);
    const original = preferences.syncPackOrder.mock.calls[0];
    await component['saveOrder']();
    expect(preferences.syncPackOrder.mock.calls[1]).toEqual(original);
    expect(component['orderFailed']()).toBe(false);
    expect(component['savingOrder']()).toBe(false);
  });

  it('shows a failure alert when creating a pack fails', async () => {
    api.postPack.mockReturnValueOnce(throwError(() => new Error('offline')));
    const component = await loaded();
    await component['createPack']();
    expect(navigate).not.toHaveBeenCalled();
    expect(alerts.create).toHaveBeenLastCalledWith({ header: '创建贴纸包失败', buttons: ['知道了'] });
  });

  it('computes midpoint order values when packs are reordered', async () => {
    preferences.packOrder.mockReturnValue([
      { stickerPackId: ownedPack.id, lastUsedOn: 100 },
      { stickerPackId: subscribed.id, lastUsedOn: 50 },
    ]);
    const component = await loaded();
    const order = (items: StickerPackSummary[], to: number) =>
      component['reorder']({ detail: { to, complete: () => items } } as unknown as CustomEvent);
    await order([ownedPack, other, subscribed], 1);
    expect(preferences.upsertPackOrderItem).toHaveBeenLastCalledWith({ stickerPackId: other.id, lastUsedOn: 75 });
    expect(preferences.syncPackOrder).toHaveBeenLastCalledWith([{ stickerPackId: other.id, lastUsedOn: 75 }]);

    preferences.packOrder.mockReturnValue([
      { stickerPackId: ownedPack.id, lastUsedOn: 100 },
      { stickerPackId: subscribed.id, lastUsedOn: 100 },
    ]);
    await order([ownedPack, other, subscribed], 1);
    expect(preferences.upsertPackOrderItem).toHaveBeenLastCalledWith({ stickerPackId: other.id, lastUsedOn: -9900 });

    await order([ownedPack, subscribed, other], 2);
    expect(preferences.upsertPackOrderItem).toHaveBeenLastCalledWith({ stickerPackId: other.id, lastUsedOn: -9900 });

    await order([other, ownedPack, subscribed], 0);
    expect(preferences.upsertPackOrderItem).toHaveBeenLastCalledWith({ stickerPackId: other.id, lastUsedOn: 10100 });
  });

  it('blocks accidental taps right after a reorder but opens the detail page afterwards', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const component = await loaded();
      component['lastReorder'] = Date.now();
      component['openPack'](subscribed);
      expect(navigate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(301);
      component['openPack'](subscribed);
      expect(navigate).toHaveBeenCalledWith(['/settings/stickers', '202']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps only emoji sequences from the pinned input and appends picked emoji', () => {
    const component = page();
    component['editPinned']({ target: { value: '👍abc❤️👍' } } as unknown as Event);
    expect(component['reactions'].pinnedReactions()).toEqual(['👍', '❤️']);
    component['addPinned']('👍');
    expect(component['reactions'].pinnedReactions()).toEqual(['👍', '❤️']);
    component['addPinned']('😂');
    expect(component['reactions'].pinnedReactions()).toEqual(['👍', '❤️', '😂']);
  });
});
