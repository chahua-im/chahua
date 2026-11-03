import { HttpClient } from '@angular/common/http';
import { SessionStore } from '../../session/session-store';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController, ModalController } from '@ionic/angular';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { RpcApi } from '../../../generated/rpc-api';
import { StickerPackVisibility, type StickerPackDetailResponse, StickerSummary } from '../../../generated/models';
import { encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { StickerPreferences } from '../../settings/sticker-preferences';
import { StickerPackDetail } from '../../settings/sticker-pack-detail/sticker-pack-detail';
import { StickerPicker } from './sticker-picker';
import { StickerUpdates } from '../sticker-updates';
import { StickerFavorites } from '../sticker-favorites';

const sticker: StickerSummary = {
  id: encodeId('101'),
  createdAt: '2026-09-08T00:00:00Z',
  emoji: '🍵',
  isFavorited: false,
  media: {
    id: encodeId('102'),
    contentType: 'image/png',
    size: 12,
    url: 'https://example.test/sticker.png',
  },
};
const pack: StickerPackDetailResponse = {
  id: encodeId('103'),
  name: 'Tea',
  createdAt: sticker.createdAt,
  updatedAt: sticker.createdAt,
  ownerUid: 1,
  visibility: StickerPackVisibility.public,
  isSubscribed: false,
  stickerCount: 1,
  stickers: [sticker],
};

describe('StickerPicker selection during requests', () => {
  const intersections = new Map<Element, (visible?: boolean) => void>();
  const api = {
    deletePackSticker: vi.fn((_packId: SnowflakeID, _stickerId: SnowflakeID) => of(undefined)),
    postPack: vi.fn(() => of({ ...pack, stickers: [] })),
    getMyFavorites: vi.fn(() => of({ stickers: [sticker] })),
    getMySubscribedPacks: vi.fn(() => of({ packs: [pack] })),
    getMyOwnedPacks: vi.fn(() => of({ packs: [] as StickerPackDetailResponse[] })),
    getPack: vi.fn((_id: SnowflakeID) => of(pack)),
    getSticker: vi.fn((_id: SnowflakeID) => of({ ...sticker, packs: [pack] })),
    deleteSubscription: vi.fn((_id: SnowflakeID) => of(undefined)),
    putFavorite: vi.fn((_id: SnowflakeID) => of(undefined)),
    deleteFavorite: vi.fn((_id: SnowflakeID) => of(undefined)),
    putSubscription: vi.fn((_id: SnowflakeID) => of(undefined)),
  };
  const modals = { dismiss: vi.fn().mockResolvedValue(true) };
  const preferences = {
    autoSortPacksEnabled: vi.fn(() => false),
    autoSortFavoritesEnabled: vi.fn(() => false),
    packOrder: vi.fn(() => [] as { stickerPackId: SnowflakeID; lastUsedOn: number }[]),
    favoriteStickerOrder: vi.fn(() => [] as { stickerId: SnowflakeID; lastUsedOn: number }[]),
    upsertPackOrderItem: vi.fn(),
    syncPackOrder: vi.fn(async () => {}),
    upsertFavoriteStickerOrderItem: vi.fn(),
  };

  beforeEach(() => {
    intersections.clear();
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private targets = new Set<Element>();
        constructor(private callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {}
        observe(target: Element) {
          this.targets.add(target);
          intersections.set(target, (visible = true) => this.callback([{ target, isIntersecting: visible }]));
        }
        disconnect() {
          for (const target of this.targets) intersections.delete(target);
        }
      },
    );
    vi.clearAllMocks();
    api.deletePackSticker.mockReset().mockReturnValue(of(undefined));
    preferences.packOrder.mockReset().mockReturnValue([]);
    api.getMyFavorites.mockReset().mockReturnValue(of({ stickers: [sticker] }));
    api.getMySubscribedPacks.mockReset().mockReturnValue(of({ packs: [pack] }));
    api.getMyOwnedPacks.mockReset().mockReturnValue(of({ packs: [] }));
    api.getPack.mockReset().mockReturnValue(of(pack));
    api.getSticker.mockReset().mockReturnValue(of({ ...sticker, packs: [pack] }));
    api.deleteSubscription.mockReset().mockReturnValue(of(undefined));
    api.putFavorite.mockReset().mockReturnValue(of(undefined));
    api.deleteFavorite.mockReset().mockReturnValue(of(undefined));
    api.putSubscription.mockReset().mockReturnValue(of(undefined));
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionStore, useValue: { user: () => undefined } },
        {
          provide: RpcApi,
          useValue: {
            stickers: {
              createPack: api.postPack,
              removeFromPack: ({ packId, stickerId }: { packId: SnowflakeID; stickerId: SnowflakeID }) =>
                api.deletePackSticker(packId, stickerId),
              listFavorites: api.getMyFavorites,
              listSubscribedPacks: api.getMySubscribedPacks,
              listOwnedPacks: api.getMyOwnedPacks,
              getPack: ({ packId }: { packId: SnowflakeID }) => api.getPack(packId),
              get: ({ stickerId }: { stickerId: SnowflakeID }) => api.getSticker(stickerId),
              unsubscribeFromPack: ({ packId }: { packId: SnowflakeID }) => api.deleteSubscription(packId),
              subscribeToPack: ({ packId }: { packId: SnowflakeID }) => api.putSubscription(packId),
              favorite: ({ stickerId }: { stickerId: SnowflakeID }) => api.putFavorite(stickerId),
              unfavorite: ({ stickerId }: { stickerId: SnowflakeID }) => api.deleteFavorite(stickerId),
            },
          },
        },
        { provide: ModalController, useValue: modals },
        { provide: StickerPreferences, useValue: preferences },
        {
          provide: AlertController,
          useValue: {
            create: async () => ({
              present: async () => {},
              onDidDismiss: async () => ({ role: 'confirm', data: { values: { name: 'Tea', emoji: '🍵' } } }),
            }),
          },
        },
      ],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'syncs confirmed detail favorites with a mounted sidebar (late reads: %s)',
    async (lateReads) => {
      const other = { ...sticker, id: encodeId('105'), isFavorited: true };
      api.getMyFavorites.mockReturnValue(of({ stickers: [other] }));
      const { fixture } = await render();
      fixture.componentRef.setInput('grouped', true);
      const sidebar = fixture.componentInstance;
      await sidebar['loadGroup'](pack.id);
      fixture.detectChanges();
      const existingTile = fixture.nativeElement.querySelector('.sticker-item');
      const detail = await renderDetails();
      const picker = detail.componentInstance;
      const favorites = new Subject<{ stickers: StickerSummary[] }>();
      const packRead = new Subject<StickerPackDetailResponse>();
      let reads: Promise<unknown>[] = [];
      if (lateReads) {
        api.getMyFavorites.mockReturnValueOnce(favorites);
        api.getPack.mockReturnValueOnce(packRead);
        reads = [sidebar['load'](), sidebar['loadGroup'](pack.id, true)];
      }
      await picker['favorite'](sticker);
      expect(sidebar['groups']()[0].content?.stickers).toEqual([{ ...sticker, isFavorited: true }, other]);
      if (lateReads) {
        favorites.next({ stickers: [other] });
        packRead.next(pack);
        await Promise.all(reads);
      }
      expect(sidebar['groups']()[0].content?.stickers).toEqual([{ ...sticker, isFavorited: true }, other]);
      expect(sidebar['groups']()[1].content?.stickers[0].isFavorited).toBe(true);
      if (lateReads) {
        api.getMyFavorites.mockReturnValueOnce(favorites);
        api.getPack.mockReturnValueOnce(packRead);
        reads = [sidebar['load'](), sidebar['loadGroup'](pack.id, true)];
      }
      await picker['favorite'](picker['chosen']()!);
      if (lateReads) {
        favorites.next({ stickers: [{ ...sticker, isFavorited: true }, other] });
        packRead.next({ ...pack, stickers: [{ ...sticker, isFavorited: true }] });
        await Promise.all(reads);
      }
      fixture.detectChanges();
      expect(sidebar['groups']()[0].content?.stickers).toEqual([other]);
      expect(sidebar['groups']()[1].content?.stickers[0].isFavorited).toBe(false);
      expect(fixture.nativeElement.querySelector('.sticker-item')).toBe(existingTile);
      expect(api.getMyFavorites).toHaveBeenCalledTimes(lateReads ? 3 : 1);
      expect(api.getPack).toHaveBeenCalledTimes(lateReads ? 4 : 2);
    },
  );

  it('does not broadcast a failed favorite or a confirmation from a previous account', async () => {
    const user = signal({ uid: 1 });
    TestBed.overrideProvider(SessionStore, { useValue: { user } });
    const fixture = await renderDetails();
    const picker = fixture.componentInstance;
    const changed = vi.fn();
    TestBed.inject(StickerUpdates).favoriteChanged.subscribe(changed);
    api.putFavorite.mockReturnValueOnce(throwError(() => new Error('offline')));
    await picker['favorite'](sticker);
    expect(changed).not.toHaveBeenCalled();
    expect(picker['chosen']()?.isFavorited).toBe(false);
    const response = new Subject<undefined>();
    api.putFavorite.mockReturnValueOnce(response);
    const pending = picker['favorite'](sticker);
    user.set({ uid: 2 });
    response.next(undefined);
    await pending;
    expect(changed).not.toHaveBeenCalled();
  });

  it('syncs message-menu favorites into an already mounted picker', async () => {
    const { fixture } = await render();
    const favorites = TestBed.inject(StickerFavorites);
    await favorites.ensure();
    await favorites.set(sticker, true);
    expect(fixture.componentInstance['stickers']()[0].isFavorited).toBe(true);
    await fixture.componentInstance['favorite']({ ...sticker, isFavorited: true });
    expect(favorites.isFavorite(sticker.id)).toBe(false);
  });

  it.each([false, true])(
    'merges an upload across a delayed read after changing layout (picker closed: %s)',
    async (closed) => {
      TestBed.overrideProvider(SessionStore, { useValue: { user: () => ({ uid: 1 }) } });
      const { fixture } = await renderGroups();
      const picker = fixture.componentInstance;
      await picker['loadGroup'](pack.id);
      const detail = TestBed.createComponent(StickerPackDetail);
      detail.componentRef.setInput('packId', pack.id);
      detail.detectChanges();
      await detail.whenStable();
      const response = new Subject<StickerPackDetailResponse>();
      api.getPack.mockReturnValueOnce(response);
      fixture.componentRef.setInput('grouped', false);
      fixture.detectChanges();
      const pending = picker['selectPack'](pack.id);
      fixture.componentRef.setInput('grouped', true);
      fixture.detectChanges();
      picker['selectPack'](pack.id);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.sticker-add').disabled).toBe(false);
      const originalTile = fixture.nativeElement.querySelector(
        '.sticker-group:nth-child(2) .sticker-item:not(.sticker-add)',
      );
      const added = { ...sticker, id: encodeId('999') };
      const upload = new Subject<StickerSummary>();
      const post = vi.spyOn(TestBed.inject(HttpClient), 'post').mockReturnValueOnce(upload);
      const event = {
        target: { files: [new File(['png'], 'tea.png', { type: 'image/png' })], value: '' },
      } as unknown as Event;
      const uploading = picker['upload'](event, pack.id).then(() => picker['saveUpload']({ name: 'Tea', emoji: '🍵' }));
      await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
      const reads = api.getPack.mock.calls.length;
      if (closed) fixture.destroy();
      upload.next(added);
      await uploading;
      expect(detail.componentInstance['pack']()?.stickers).toEqual([sticker, added]);
      response.next(pack);
      await pending;
      expect(api.getPack).toHaveBeenCalledTimes(reads);
      if (!closed) {
        fixture.detectChanges();
        expect(picker['groups']().find((group) => group.id === pack.id)?.content?.stickers).toEqual([sticker, added]);
        expect(picker['packs']().find((item) => item.id === pack.id)?.stickerCount).toBe(2);
        expect(fixture.nativeElement.contains(originalTile)).toBe(true);
      }
    },
  );

  it.each([
    { grouped: false, leaveBeforeResponse: false },
    { grouped: true, leaveBeforeResponse: false },
    { grouped: false, leaveBeforeResponse: true },
    { grouped: true, leaveBeforeResponse: true },
  ])(
    'syncs settings removal without replacing surviving tiles ($grouped, $leaveBeforeResponse)',
    async ({ grouped, leaveBeforeResponse }) => {
      const remaining = { ...sticker, id: encodeId('109') };
      const originalPack = { ...pack, stickerCount: 2, stickers: [sticker, remaining], previewSticker: sticker };
      api.getPack.mockReturnValue(of(originalPack));
      const { fixture } = await render();
      fixture.componentRef.setInput('grouped', grouped);
      const picker = fixture.componentInstance;
      await picker['selectPack'](pack.id);
      await fixture.whenStable();
      fixture.detectChanges();
      const grid = fixture.nativeElement.querySelectorAll('.sticker-grid')[grouped ? 1 : 0];
      const survivingTile = grid.querySelectorAll('.sticker-item')[1];
      const staleRead = new Subject<StickerPackDetailResponse>();
      api.getPack.mockReturnValueOnce(staleRead);
      const pending = picker['loadGroup'](pack.id, true);
      const detail = TestBed.createComponent(StickerPackDetail);
      detail.componentRef.setInput('packId', pack.id);
      detail.detectChanges();
      await detail.whenStable();
      vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
        present: async () => {},
        onDidDismiss: async () => ({ role: 'destructive' }),
      } as HTMLIonAlertElement);
      const response = new Subject<undefined>();
      api.deletePackSticker.mockReturnValueOnce(response);
      const removal = detail.componentInstance['removeSticker'](sticker);
      await vi.waitFor(() => expect(api.deletePackSticker).toHaveBeenCalledWith(pack.id, sticker.id));
      if (leaveBeforeResponse) detail.destroy();
      response.next(undefined);
      await removal;
      fixture.detectChanges();
      expect(api.deletePackSticker).toHaveBeenCalledWith(pack.id, sticker.id);
      expect(picker['stickers']()).toEqual([remaining]);
      expect(picker['activeId']()).toBe(pack.id);
      expect(grid.querySelector('.sticker-item')).toBe(survivingTile);
      expect(picker['packs']()[0].previewSticker?.id).toBe(remaining.id);
      staleRead.next(originalPack);
      await pending;
      fixture.detectChanges();
      expect(picker['stickers']()).toEqual([remaining]);
      expect(grid.querySelector('.sticker-item')).toBe(survivingTile);
      expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    },
  );

  it.each([false, true])(
    'preserves later additions and favorites after a delayed removal (grouped: %s)',
    async (grouped) => {
      const remaining = { ...sticker, id: encodeId('112') };
      const originalPack = { ...pack, stickers: [sticker, remaining], stickerCount: 2, previewSticker: sticker };
      api.getPack.mockReturnValue(of(originalPack));
      const { fixture } = await render();
      fixture.componentRef.setInput('grouped', grouped);
      const picker = fixture.componentInstance;
      await picker['selectPack'](pack.id);
      await fixture.whenStable();
      const detail = TestBed.createComponent(StickerPackDetail);
      detail.componentRef.setInput('packId', pack.id);
      detail.detectChanges();
      await detail.whenStable();
      vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
        present: async () => {},
        onDidDismiss: async () => ({ role: 'destructive' }),
      } as HTMLIonAlertElement);
      const response = new Subject<undefined>();
      api.deletePackSticker.mockReturnValueOnce(response);
      const removal = detail.componentInstance['removeSticker'](sticker);
      await vi.waitFor(() => expect(api.deletePackSticker).toHaveBeenCalled());
      detail.destroy();
      const added = { ...sticker, id: encodeId('111') };
      TestBed.inject(StickerUpdates).added.next({ pack: originalPack, sticker: added });
      await picker['favorite'](remaining);
      fixture.detectChanges();
      const tiles = [...fixture.nativeElement.querySelectorAll('.sticker-group')]
        .at(-1)
        .querySelectorAll('.sticker-item');
      response.next(undefined);
      await removal;
      fixture.detectChanges();
      expect(picker['stickers']()).toEqual([{ ...remaining, isFavorited: true }, added]);
      expect(picker['packs']()[0].stickerCount).toBe(2);
      expect(picker['packs']()[0].previewSticker?.id).toBe(remaining.id);
      const survivingTiles = [...fixture.nativeElement.querySelectorAll('.sticker-group')]
        .at(-1)
        .querySelectorAll('.sticker-item');
      expect(survivingTiles[0]).toBe(tiles[1]);
      expect(survivingTiles[1]).toBe(tiles[2]);
      expect(detail.componentInstance['pack']()).toBe(originalPack);
    },
  );

  it.each([false, true])('syncs a reopened detail before its next removal (read pending: %s)', async (readPending) => {
    const remaining = { ...sticker, id: encodeId('112') };
    const originalPack = { ...pack, stickers: [sticker, remaining], stickerCount: 2 };
    api.getPack.mockReturnValue(of(originalPack));
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    await picker['selectPack'](pack.id);
    const detail = TestBed.createComponent(StickerPackDetail);
    detail.componentRef.setInput('packId', pack.id);
    detail.detectChanges();
    await detail.whenStable();
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => {},
      onDidDismiss: async () => ({ role: 'destructive' }),
    } as HTMLIonAlertElement);
    const response = new Subject<undefined>();
    api.deletePackSticker.mockReturnValueOnce(response);
    const removal = detail.componentInstance['removeSticker'](sticker);
    await vi.waitFor(() => expect(api.deletePackSticker).toHaveBeenCalled());
    detail.destroy();
    const read = new Subject<StickerPackDetailResponse>();
    if (readPending) api.getPack.mockReturnValueOnce(read);
    const reopened = TestBed.createComponent(StickerPackDetail);
    reopened.componentRef.setInput('packId', pack.id);
    reopened.detectChanges();
    await reopened.whenStable();
    response.next(undefined);
    await removal;
    if (readPending) read.next(originalPack);
    await reopened.whenStable();
    expect(reopened.componentInstance['pack']()?.stickers).toEqual([remaining]);
    expect(picker['stickers']()).toEqual([remaining]);
    await reopened.componentInstance['removeSticker'](remaining);
    expect(picker['stickers']()).toEqual([]);
    expect(picker['packs']()[0].stickerCount).toBe(0);
  });

  it('does not subtract a delayed removal from a library that already includes it', async () => {
    const remaining = { ...sticker, id: encodeId('112') };
    const originalPack = { ...pack, stickers: [sticker, remaining], stickerCount: 2, previewSticker: sticker };
    api.getPack.mockReturnValue(of(originalPack));
    const detail = TestBed.createComponent(StickerPackDetail);
    detail.componentRef.setInput('packId', pack.id);
    detail.detectChanges();
    await detail.whenStable();
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => {},
      onDidDismiss: async () => ({ role: 'destructive' }),
    } as HTMLIonAlertElement);
    const response = new Subject<undefined>();
    api.deletePackSticker.mockReturnValueOnce(response);
    const removal = detail.componentInstance['removeSticker'](sticker);
    await vi.waitFor(() => expect(api.deletePackSticker).toHaveBeenCalled());
    detail.destroy();
    // The server has deleted the membership, but the DELETE response has not arrived.
    const currentPack = { ...originalPack, stickers: [remaining], stickerCount: 1, previewSticker: remaining };
    api.getMySubscribedPacks.mockReturnValue(of({ packs: [currentPack] }));
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    const read = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(read);
    response.next(undefined);
    await removal;
    expect(picker['packs']()[0].stickerCount).toBe(1);
    expect(picker['packs']()[0].previewSticker?.id).toBe(remaining.id);
    read.next(currentPack);
    await fixture.whenStable();
    expect(picker['packs']()[0].stickerCount).toBe(1);
    expect(picker['contents']().get(pack.id)?.stickers).toEqual([remaining]);
  });

  it('replaces a removed cover in an unloaded pack and keeps it after opening the pack', async () => {
    const remaining = {
      ...sticker,
      id: encodeId('112'),
      media: { ...sticker.media, url: 'https://example.test/remaining.png' },
    };
    const originalPack = { ...pack, stickers: [sticker, remaining], stickerCount: 2, previewSticker: sticker };
    api.getPack.mockReturnValue(of(originalPack));
    api.getMySubscribedPacks.mockReturnValue(of({ packs: [originalPack] }));
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    const detail = TestBed.createComponent(StickerPackDetail);
    detail.componentRef.setInput('packId', pack.id);
    detail.detectChanges();
    await detail.whenStable();
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => {},
      onDidDismiss: async () => ({ role: 'destructive' }),
    } as HTMLIonAlertElement);
    const currentPack = { ...originalPack, stickers: [remaining], stickerCount: 1, previewSticker: remaining };
    api.getPack.mockReturnValue(of(currentPack));
    const reads = api.getPack.mock.calls.length;
    await detail.componentInstance['removeSticker'](sticker);
    await fixture.whenStable();
    expect(api.getPack).toHaveBeenCalledTimes(reads + 1);
    expect(picker['packs']()[0].previewSticker?.id).toBe(remaining.id);
    expect(fixture.nativeElement.querySelector('.pack-tab img')?.getAttribute('src')).toBe(remaining.media.url);
    await picker['selectPack'](pack.id);
    expect(picker['packs']()[0].previewSticker?.id).toBe(remaining.id);
  });

  it.each([false, true])('retains removal across an overlapping library read (initial: %s)', async (initial) => {
    const response = new Subject<{ packs: StickerPackDetailResponse[] }>();
    let picker: StickerPicker;
    let pending: Promise<void> | undefined;
    if (initial) {
      api.getMyOwnedPacks.mockReturnValueOnce(response);
      const fixture = TestBed.createComponent(StickerPicker);
      fixture.componentRef.setInput('embedded', true);
      fixture.detectChanges();
      await fixture.whenStable();
      picker = fixture.componentInstance;
    } else {
      const { fixture } = await render();
      picker = fixture.componentInstance;
      api.getMyOwnedPacks.mockReturnValueOnce(response);
      pending = picker['load']();
    }
    api.getPack.mockReturnValue(of({ ...pack, stickers: [], stickerCount: 0, previewSticker: undefined }));
    TestBed.inject(StickerUpdates).stickerRemoved.next({ pack, stickerId: sticker.id });
    response.next({ packs: [pack] });
    if (pending) await pending;
    await vi.waitFor(() => expect(picker['busy']()).toBe(false));
    expect(picker['packs']()[0].stickerCount).toBe(0);
    expect(picker['packs']()[0].previewSticker).toBeUndefined();
  });

  it.each([false, true])(
    'keeps refreshed removal metadata across a stale library response (pack first: %s)',
    async (packFirst) => {
      const remaining = { ...sticker, id: encodeId('112') };
      const added = { ...sticker, id: encodeId('113') };
      const originalPack = { ...pack, stickers: [sticker, remaining], stickerCount: 2, previewSticker: sticker };
      const otherPack = { ...originalPack, id: encodeId('114') };
      api.getMySubscribedPacks.mockReturnValue(of({ packs: [originalPack, otherPack] }));
      const { fixture } = await render();
      const picker = fixture.componentInstance;
      const libraryRead = new Subject<{ packs: StickerPackDetailResponse[] }>();
      api.getMySubscribedPacks.mockReturnValueOnce(libraryRead);
      const libraryPending = picker['load']();
      const packRead = new Subject<StickerPackDetailResponse>();
      api.getPack.mockReturnValueOnce(packRead);
      const updates = TestBed.inject(StickerUpdates);
      const reads = api.getPack.mock.calls.length;
      updates.stickerRemoved.next({ pack: originalPack, stickerId: sticker.id });
      const packPending = picker['loadGroup'](pack.id);
      updates.added.next({ pack: originalPack, sticker: added });
      expect(api.getPack).toHaveBeenCalledTimes(reads + 1);
      const completePack = async () => {
        packRead.next({ ...originalPack, stickers: [remaining], stickerCount: 1, previewSticker: remaining });
        await packPending;
      };
      if (packFirst) await completePack();
      libraryRead.next({ packs: [originalPack, otherPack] });
      await libraryPending;
      if (!packFirst) {
        expect(picker['packs']()[0].previewSticker?.id).not.toBe(sticker.id);
        await completePack();
      }
      expect(picker['packs']()[0].stickerCount).toBe(2);
      expect(picker['packs']()[0].previewSticker?.id).toBe(remaining.id);
      expect(picker['contents']().get(pack.id)?.stickers).toEqual([remaining, added]);
      expect(picker['packs']()[1].previewSticker?.id).toBe(sticker.id);
    },
  );

  it('retains confirmed edits and empty creations across a delayed library response', async () => {
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    fixture.componentRef.setInput('grouped', true);
    const response = new Subject<{ packs: StickerPackDetailResponse[] }>();
    api.getMyOwnedPacks.mockReturnValueOnce(response);
    const pending = picker['load']();
    const updated = { ...pack, name: 'New name', stickerCount: 0, stickers: [], previewSticker: undefined };
    const created = { ...updated, id: encodeId('120') };
    const updates = TestBed.inject(StickerUpdates);
    updates.changed.next(updated);
    updates.changed.next(created);
    const added = { ...sticker, id: encodeId('121') };
    updates.added.next({ pack: updated, sticker: added });
    response.next({ packs: [pack] });
    await pending;
    expect(picker['packs']().map(({ id, name, stickerCount }) => ({ id, name, stickerCount }))).toEqual([
      { id: pack.id, name: 'New name', stickerCount: 1 },
      { id: created.id, name: 'New name', stickerCount: 0 },
    ]);
    expect(picker['contents']().get(pack.id)?.stickers).toEqual([added]);
    expect(picker['contents']().get(created.id)?.stickers).toEqual([]);
  });

  it('reacts to pack order changes and rollback while retaining the active group and scroll anchor', async () => {
    const order = signal([
      { stickerPackId: pack.id, lastUsedOn: 2 },
      { stickerPackId: secondPack.id, lastUsedOn: 1 },
    ]);
    preferences.packOrder.mockImplementation(order);
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    await picker['selectPack'](pack.id);
    await fixture.whenStable();
    fixture.detectChanges();
    const sections = fixture.nativeElement.querySelectorAll('.sticker-group');
    const group = sections[1];
    const tile = group.querySelector('.sticker-item');
    const viewport: HTMLElement = fixture.nativeElement.querySelector('.sticker-library');
    Object.defineProperty(group, 'offsetTop', { get: () => (picker['packs']()[0].id === pack.id ? 100 : 400) });
    picker['scroll'].jump(pack.id);
    fixture.detectChanges();
    expect(viewport.scrollTop).toBe(100);
    const reads = api.getPack.mock.calls.length;
    order.set([
      { stickerPackId: pack.id, lastUsedOn: 2 },
      { stickerPackId: secondPack.id, lastUsedOn: 3 },
    ]);
    fixture.detectChanges();
    expect(picker['packs']().map((item) => item.id)).toEqual([secondPack.id, pack.id]);
    expect(fixture.nativeElement.querySelectorAll('.sticker-group')[2]).toBe(group);
    expect(group.querySelector('.sticker-item')).toBe(tile);
    expect(picker['activeId']()).toBe(pack.id);
    expect(viewport.scrollTop).toBe(400);
    order.set([
      { stickerPackId: pack.id, lastUsedOn: 2 },
      { stickerPackId: secondPack.id, lastUsedOn: 1 },
    ]);
    fixture.detectChanges();
    expect(picker['packs']().map((item) => item.id)).toEqual([pack.id, secondPack.id]);
    expect(viewport.scrollTop).toBe(100);
    expect(api.getPack).toHaveBeenCalledTimes(reads);
  });

  it('adds a created sticker to an open pack and preserves it across a delayed pack read', async () => {
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    await picker['selectPack'](pack.id);
    fixture.detectChanges();
    const original = fixture.nativeElement.querySelector('.sticker-item');
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response);
    const pending = picker['selectPack'](pack.id);
    const added = { ...sticker, id: encodeId('109') };
    TestBed.inject(StickerUpdates).added.next({ pack, sticker: added });
    fixture.detectChanges();
    expect(picker['stickers']()).toEqual([sticker, added]);
    expect(fixture.nativeElement.querySelector('.sticker-item')).toBe(original);
    response.next(pack);
    await pending;
    expect(picker['stickers']()).toEqual([sticker, added]);
    expect(picker['pack']()?.stickerCount).toBe(2);
    expect(api.getPack).toHaveBeenCalledTimes(2);
  });

  it('keeps a newly created pack when an older library response arrives', async () => {
    const { fixture } = await render();
    const response = new Subject<{ packs: never[] }>();
    api.getMyOwnedPacks.mockReturnValueOnce(response);
    const pending = fixture.componentInstance['load']();
    const newPack = { ...pack, id: encodeId('120'), stickerCount: 0 };
    TestBed.inject(StickerUpdates).added.next({ pack: newPack, sticker });
    response.next({ packs: [] });
    await pending;
    expect(fixture.componentInstance['packs']().find((item) => item.id === newPack.id)?.stickerCount).toBe(1);
  });

  async function render(embedded = true, selectable = true) {
    const fixture = TestBed.createComponent(StickerPicker);
    fixture.componentRef.setInput('embedded', embedded);
    fixture.componentRef.setInput('selectable', selectable);
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.sticker-item')).not.toBeNull();
    });
    const button = fixture.nativeElement.querySelector('.sticker-item') as HTMLButtonElement;
    const pointer = (type: string) =>
      button.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          isPrimary: true,
          pointerType: 'touch',
          clientX: 100,
          clientY: 100,
        }),
      );
    return { fixture, button, pointer, selected };
  }

  const secondPack = { ...pack, id: encodeId('110'), name: 'Coffee', ownerUid: 2 };
  async function renderGroups() {
    api.getMySubscribedPacks.mockReturnValueOnce(of({ packs: [pack, secondPack] }));
    api.getPack.mockImplementation((id?: SnowflakeID) => of(id === secondPack.id ? secondPack : pack));
    const result = await render();
    result.fixture.componentRef.setInput('grouped', true);
    result.fixture.detectChanges();
    await result.fixture.whenStable();
    intersections.get(result.fixture.nativeElement.querySelector('.sticker-group'))!();
    result.fixture.detectChanges();
    return result;
  }

  it('loads only approaching groups and sends using the clicked group instead of the highlighted group', async () => {
    preferences.autoSortPacksEnabled.mockReturnValue(true);
    const { fixture, selected } = await renderGroups();
    const picker = fixture.componentInstance;
    const sections = fixture.nativeElement.querySelectorAll('.sticker-group');
    expect(
      [...fixture.nativeElement.querySelectorAll('.group-title')].map((el) => (el as HTMLElement).textContent?.trim()),
    ).toEqual(['收藏', 'Tea', 'Coffee']);
    expect(api.getPack).not.toHaveBeenCalled();
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response);
    intersections.get(sections[1])!();
    intersections.get(sections[1])!();
    expect(api.getPack).toHaveBeenCalledTimes(1);
    picker['selectPack'](secondPack.id);
    fixture.detectChanges();
    await fixture.whenStable();
    response.next(pack);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(picker['activeId']()).toBe(secondPack.id);
    sections[1].querySelector('.sticker-item').click();
    expect(selected).toHaveBeenCalledWith(sticker);
    expect(preferences.upsertPackOrderItem).toHaveBeenCalledWith({
      stickerPackId: pack.id,
      lastUsedOn: expect.any(Number),
    });
    preferences.upsertPackOrderItem.mockClear();
    sections[0].querySelector('.sticker-item').click();
    expect(preferences.upsertPackOrderItem).not.toHaveBeenCalled();
  });

  it('jumps to a group, tracks scrolling, and retains the current grid and data across layouts', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    const sections = fixture.nativeElement.querySelectorAll('.sticker-group');
    const scroll = fixture.nativeElement.querySelector('.sticker-library');
    [0, 200, 500].forEach((offset, index) =>
      Object.defineProperty(sections[index], 'offsetTop', { configurable: true, value: offset }),
    );
    picker['selectPack'](secondPack.id);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(500);
    scroll.scrollTop = 250;
    scroll.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(picker['activeId']()).toBe(pack.id);
    expect(fixture.nativeElement.querySelectorAll('.pack-tab')[1].classList.contains('selected')).toBe(true);
    intersections.get(sections[1])!();
    await fixture.whenStable();
    fixture.detectChanges();
    const grid = sections[1].querySelector('.sticker-grid');
    const tile = grid.querySelector('.sticker-item');
    fixture.componentRef.setInput('grouped', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.sticker-grid')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.sticker-grid')).toBe(grid);
    expect(fixture.nativeElement.querySelector('.sticker-item')).toBe(tile);
    fixture.componentRef.setInput('grouped', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.sticker-grid')[1]).toBe(grid);
    expect(api.getPack).toHaveBeenCalledTimes(2);
  });

  it('anchors the same tile through row reflow and ignores resize-generated scroll events', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    await picker['loadGroup'](pack.id);
    fixture.detectChanges();
    const scroll: HTMLElement = fixture.nativeElement.querySelector('.sticker-library');
    const sections = fixture.nativeElement.querySelectorAll('.sticker-group');
    let width = 360;
    Object.defineProperty(scroll, 'clientWidth', { get: () => width });
    picker['scroll']['scrollWidth'] = width;
    intersections.get(sections[1])!();
    fixture.detectChanges();
    Object.defineProperty(sections[1], 'offsetTop', { get: () => (picker.grouped() ? 200 : 0) });
    Object.defineProperty(sections[2], 'offsetTop', { get: () => 3000 });
    const tile: HTMLElement = sections[1].querySelector('.sticker-item');
    vi.spyOn(tile, 'getBoundingClientRect').mockImplementation(() => {
      const top = (picker.grouped() ? 1200 : 400) - scroll.scrollTop;
      return { top, bottom: top + 80 } as DOMRect;
    });
    scroll.scrollTop = 1210;
    scroll.dispatchEvent(new Event('scroll'));
    expect(picker['activeId']()).toBe(pack.id);
    width = 800;
    scroll.scrollTop = 700; // The browser clamps the old pixel position as the grid gets shorter.
    scroll.dispatchEvent(new Event('scroll'));
    fixture.componentRef.setInput('grouped', false);
    fixture.detectChanges();
    expect(scroll.scrollTop).toBe(410);
    scroll.dispatchEvent(new Event('scroll'));
    width = 360;
    fixture.componentRef.setInput('grouped', true);
    fixture.detectChanges();
    expect(scroll.scrollTop).toBe(1210);
    expect(fixture.nativeElement.querySelectorAll('.sticker-grid')[1].querySelector('.sticker-item')).toBe(tile);
  });

  it('keeps the pack heading anchored when favorites above it grow', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    const sections = fixture.nativeElement.querySelectorAll('.sticker-group');
    const viewport: HTMLElement = fixture.nativeElement.querySelector('.sticker-library');
    let favoritesHeight = 100;
    Object.defineProperty(sections[1], 'offsetTop', { get: () => favoritesHeight });
    picker['selectPack'](pack.id);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(viewport.scrollTop).toBe(100);
    viewport.dispatchEvent(new Event('scroll'));
    await picker['favorite']({ ...sticker, id: encodeId('199') });
    favoritesHeight = 188;
    fixture.detectChanges();
    expect(viewport.scrollTop).toBe(188);
    expect(picker['activeId']()).toBe(pack.id);
  });

  it('releases distant group media while keeping its data and the active grid across layouts', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    const sections = fixture.nativeElement.querySelectorAll('.sticker-group');
    intersections.get(sections[1])!();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(sections[1].querySelector('.sticker-item')).not.toBeNull();
    picker['selectPack'](secondPack.id);
    intersections.get(sections[1])!(false);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(sections[1].querySelector('.sticker-item')).toBeNull();
    expect(sections[1].querySelector('.group-placeholder').style.getPropertyValue('--placeholder-rows')).toBe('1');
    const tile = sections[2].querySelector('.sticker-item');
    fixture.componentRef.setInput('grouped', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sticker-item')).toBe(tile);
    fixture.componentRef.setInput('grouped', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.sticker-group')[2].querySelector('.sticker-item')).toBe(tile);
    picker['selectPack'](pack.id);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.sticker-group')[1].querySelector('.sticker-item')).not.toBeNull();
    expect(api.getPack).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'removes cached packs and rejects overlapping reads (response already arrived: %s)',
    async (resolved) => {
      const { fixture } = await renderGroups();
      const picker = fixture.componentInstance;
      picker['selectPack'](pack.id);
      await fixture.whenStable();
      const response = new Subject<StickerPackDetailResponse>();
      api.getPack.mockReturnValueOnce(response);
      const pendingPack = picker['loadGroup'](pack.id, true);
      const library = new Subject<{ packs: StickerPackDetailResponse[] }>();
      api.getMySubscribedPacks.mockReturnValueOnce(library);
      const pendingLibrary = picker['load']();
      if (resolved) response.next(pack);
      TestBed.inject(StickerUpdates).removed.next({ id: pack.id, deleted: true });
      expect(response.observed).toBe(false);
      expect(picker['contents']().has(pack.id)).toBe(false);
      library.next({ packs: [pack, secondPack] });
      await Promise.all([pendingPack, pendingLibrary]);
      fixture.detectChanges();
      expect(picker['packs']().map((item) => item.id)).toEqual([secondPack.id]);
      expect(picker['contents']().has(pack.id)).toBe(false);
      expect(picker['activeId']()).toBe(secondPack.id);
      expect(picker['groupErrors']().has(pack.id)).toBe(false);
      expect(fixture.nativeElement.querySelector('.pack-tab[title="Tea"]')).toBeNull();
      // A subsequent library read may reflect a new subscription from another client.
      await picker['load']();
      expect(picker['packs']().map((item) => item.id)).toContain(pack.id);
    },
  );

  it('does not select a deleted pack between caching its response and completing the selection', async () => {
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response);
    const selecting = picker['selectPack'](pack.id);
    response.next(pack);
    await Promise.resolve();
    expect(picker['contents']().has(pack.id)).toBe(true);
    TestBed.inject(StickerUpdates).removed.next({ id: pack.id, deleted: true });
    await selecting;
    expect(picker['activeId']()).toBeUndefined();
    expect(picker['contents']().has(pack.id)).toBe(false);
    expect(picker['busy']()).toBe(false);
  });

  it('removes a confirmed unsubscribe from the library while keeping the explicit detail open', async () => {
    const foreign = { ...pack, ownerUid: 2, isSubscribed: true };
    api.getMySubscribedPacks.mockReturnValueOnce(of({ packs: [foreign] }));
    api.getPack.mockReturnValue(of(foreign));
    const { fixture } = await render();
    fixture.componentRef.setInput('grouped', true);
    fixture.detectChanges();
    const details = await renderDetails();
    await details.componentInstance['subscribe']();
    fixture.detectChanges();
    expect(api.deleteSubscription).toHaveBeenCalledWith(pack.id);
    expect(fixture.componentInstance['packs']()).toEqual([]);
    expect(details.componentInstance['pack']()?.id).toBe(pack.id);
    expect(details.componentInstance['pack']()?.isSubscribed).toBe(false);
    expect(details.componentInstance['chosen']()?.id).toBe(sticker.id);
  });

  it('shows favorite failure feedback outside the scroll groups and rolls back membership', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    picker['selectPack'](secondPack.id);
    await fixture.whenStable();
    api.putFavorite.mockReturnValueOnce(throwError(() => new Error('offline')));
    const previous = picker['contents']().get(undefined);
    await picker['favorite']({ ...sticker, id: encodeId('199') });
    fixture.detectChanges();
    const toast = fixture.nativeElement.querySelector('ion-toast');
    expect(toast.isOpen).toBe(true);
    expect(toast.message).toContain('收藏状态更新失败');
    expect(picker['groups']().every((group) => !group.error)).toBe(true);
    expect(picker['contents']().get(undefined)).toBe(previous);
    expect(picker['activeId']()).toBe(secondPack.id);
    await picker['favorite']({ ...sticker, id: encodeId('199') });
    fixture.detectChanges();
    expect(toast.isOpen).toBe(false);
    expect(picker['contents']().get(undefined)?.stickers[0].id).toBe(encodeId('199'));
  });

  it('retries a failed group in place without reloading or replacing known favorites', async () => {
    const { fixture } = await renderGroups();
    const sections = fixture.nativeElement.querySelectorAll('.sticker-group');
    const favorite = sections[0].querySelector('.sticker-item');
    api.getPack.mockReturnValueOnce(throwError(() => new Error('offline')));
    intersections.get(sections[1])!();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(sections[1].textContent).toContain('加载失败');
    expect(sections[1].querySelector('.sticker-grid').classList.contains('failed')).toBe(true);
    expect(sections[1].querySelectorAll('.sticker-skeleton')).toHaveLength(0);
    expect(sections[1].querySelector('.group-placeholder')).not.toBeNull();
    expect(sections[0].querySelector('.sticker-item')).toBe(favorite);
    sections[1].querySelector('.empty ion-button').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(sections[1].querySelector('.sticker-item')).not.toBeNull();
    expect(api.getPack).toHaveBeenCalledTimes(2);
    expect(api.getMyFavorites).toHaveBeenCalledTimes(1);
  });

  it('keeps favorite changes consistent across groups and a delayed pack response', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    await picker['loadGroup'](pack.id);
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response);
    const pending = picker['loadGroup'](secondPack.id);
    await picker['favorite'](sticker);
    response.next(secondPack);
    await pending;
    expect(picker['groups']().every((group) => group.content?.stickers[0].isFavorited)).toBe(true);
    const failure = new Subject<undefined>();
    api.deleteFavorite.mockReturnValueOnce(failure);
    const removal = picker['favorite']({ ...sticker, isFavorited: true });
    failure.error(new Error('offline'));
    await removal;
    expect(picker['groups']().every((group) => group.content?.stickers[0].isFavorited)).toBe(true);
  });

  it('retries favorites independently while a pack is highlighted', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    picker['selectPack'](pack.id);
    fixture.detectChanges();
    await fixture.whenStable();
    api.getMyFavorites.mockReturnValueOnce(throwError(() => new Error('offline')));
    await picker['load']();
    expect(picker['activeId']()).toBe(pack.id);
    const reads = api.getPack.mock.calls.length;
    await picker['retryGroup'](picker['groups']()[0]);
    expect(api.getMyFavorites).toHaveBeenCalledTimes(3);
    expect(api.getPack).toHaveBeenCalledTimes(reads);
    expect(picker['activeId']()).toBe(pack.id);
  });

  it('cancels an unfinished group read when the picker closes', async () => {
    const { fixture } = await renderGroups();
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response);
    const pending = fixture.componentInstance['loadGroup'](pack.id);
    expect(response.observed).toBe(true);
    fixture.destroy();
    await pending;
    expect(response.observed).toBe(false);
  });

  it('updates favorites membership immediately, rolls back failures, and merges late library reads', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    const added = { ...sticker, id: encodeId('120') };
    const request = new Subject<undefined>();
    api.putFavorite.mockReturnValueOnce(request);
    const adding = picker['favorite'](added);
    expect(picker['groups']()[0].content!.stickers.map((item) => item.id)).toEqual([added.id, sticker.id]);
    request.error(new Error('offline'));
    await adding;
    expect(picker['groups']()[0].content!.stickers).toEqual([sticker]);
    await picker['favorite'](added);
    const favorites = picker['groups']()[0].content!.stickers;
    expect(favorites[0].id).toBe(added.id);
    const removing = picker['favorite'](favorites[0]);
    const stale = new Subject<{ stickers: StickerSummary[] }>();
    api.getMyFavorites.mockReturnValueOnce(stale);
    const reading = picker['load']();
    await removing;
    stale.next({ stickers: favorites });
    await reading;
    expect(picker['groups']()[0].content!.stickers).toEqual([sticker]);
    const addingAgain = picker['favorite'](added);
    const missing = new Subject<{ stickers: StickerSummary[] }>();
    api.getMyFavorites.mockReturnValueOnce(missing);
    const readingAgain = picker['load']();
    await addingAgain;
    missing.next({ stickers: [sticker] });
    await readingAgain;
    expect(picker['groups']()[0].content!.stickers.map((item) => item.id)).toEqual([added.id, sticker.id]);
  });

  it('accepts subsequent server changes after a favorite mutation has completed', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    const added = { ...sticker, id: encodeId('120') };
    await picker['favorite'](added);
    // Another client removes the favorite before this new read.
    api.getMyFavorites.mockReturnValueOnce(of({ stickers: [sticker] }));
    await picker['load']();
    expect(picker['groups']()[0].content!.stickers).toEqual([sticker]);
    await picker['favorite']({ ...added, isFavorited: true });
    // Another client adds it again; the completed local removal must not hide it.
    const restored = { ...added, isFavorited: true };
    api.getMyFavorites.mockReturnValueOnce(of({ stickers: [sticker, restored] }));
    await picker['load']();
    expect(picker['groups']()[0].content!.stickers).toEqual([sticker, restored]);
    api.getPack.mockReturnValueOnce(of({ ...pack, stickers: [restored] }));
    await picker['loadGroup'](pack.id, true);
    expect(picker['groups']()[1].content!.stickers).toEqual([restored]);
  });

  it('restores favorite order and known empty content without displaying loading skeletons', async () => {
    const items = [
      sticker,
      { ...sticker, id: encodeId('120'), isFavorited: true },
      { ...sticker, id: encodeId('121') },
    ];
    api.getMyFavorites.mockReturnValueOnce(of({ stickers: items }));
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    const response = new Subject<undefined>();
    api.deleteFavorite.mockReturnValueOnce(response);
    const removing = picker['favorite'](items[1]);
    expect(picker['stickers']().map((item) => item.id)).toEqual([items[0].id, items[2].id]);
    response.error(new Error('offline'));
    await removing;
    expect(picker['stickers']()).toEqual(items);
    api.getMyFavorites.mockReturnValueOnce(of({ stickers: [items[1]] }));
    await picker['load']();
    const pending = new Subject<undefined>();
    api.deleteFavorite.mockReturnValueOnce(pending);
    const last = picker['favorite'](items[1]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('.sticker-item')).toBeNull();
    expect(fixture.nativeElement.querySelector('.empty')).not.toBeNull();
    pending.next(undefined);
    await last;
  });

  it('deduplicates an inline read with sidebar prefetch and ignores it after choosing another group', async () => {
    api.getMySubscribedPacks.mockReturnValueOnce(of({ packs: [pack, secondPack] }));
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response).mockReturnValueOnce(of(secondPack));
    const first = picker['selectPack'](pack.id);
    fixture.componentRef.setInput('grouped', true);
    fixture.detectChanges();
    await picker['selectPack'](secondPack.id);
    const shared = picker['loadGroup'](pack.id);
    await fixture.whenStable();
    expect(picker['activeId']()).toBe(secondPack.id);
    expect(picker['busy']()).toBe(false);
    response.next(pack);
    await Promise.all([first, shared]);
    expect(picker['activeId']()).toBe(secondPack.id);
    expect(picker['groups']()[1].content!.stickers).toEqual(pack.stickers);
    expect(api.getPack).toHaveBeenCalledTimes(2);
    expect(api.getPack).toHaveBeenNthCalledWith(1, pack.id);
    expect(api.getPack).toHaveBeenNthCalledWith(2, secondPack.id);
    expect(api.getMyFavorites).toHaveBeenCalledTimes(1);
  });

  it('shares sidebar reads with a narrow selection while allowing that latest selection to complete', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response);
    const prefetch = picker['loadGroup'](pack.id);
    fixture.componentRef.setInput('grouped', false);
    fixture.detectChanges();
    const selecting = picker['selectPack'](pack.id);
    response.next(pack);
    await Promise.all([prefetch, selecting]);
    expect(picker['activeId']()).toBe(pack.id);
    expect(picker['busy']()).toBe(false);
    expect(api.getPack).toHaveBeenCalledOnce();
  });

  it('uses one height placeholder per unloaded pack and caps skeletons during a large pack read', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...pack,
      id: encodeId(String(1000 + i)),
      stickerCount: 100,
    }));
    api.getMySubscribedPacks.mockReturnValueOnce(of({ packs: many }));
    const { fixture } = await render();
    fixture.componentRef.setInput('grouped', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.group-placeholder')).toHaveLength(100);
    expect(fixture.nativeElement.querySelectorAll('.sticker-skeleton')).toHaveLength(0);
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response);
    const loading = fixture.componentInstance['loadGroup'](many[0].id);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.sticker-skeleton')).toHaveLength(12);
    expect(fixture.nativeElement.querySelectorAll('.group-placeholder')).toHaveLength(100);
    response.error(new Error('offline'));
    await loading;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.sticker-skeleton')).toHaveLength(0);
    expect(fixture.nativeElement.querySelectorAll('.group-placeholder')).toHaveLength(100);
  });

  it('shows upload failures in the target group and clears them when that upload is retried', async () => {
    const { fixture } = await renderGroups();
    const picker = fixture.componentInstance;
    await picker['loadGroup'](pack.id);
    picker['selectPack'](secondPack.id);
    await fixture.whenStable();
    const post = vi
      .spyOn(TestBed.inject(HttpClient), 'post')
      .mockReturnValueOnce(throwError(() => new Error('offline')));
    const event = {
      target: { files: [new File(['png'], 'tea.png', { type: 'image/png' })], value: '' },
    } as unknown as Event;
    await picker['upload'](event, pack.id);
    await picker['saveUpload']({ name: 'Tea', emoji: '🍵' });
    fixture.detectChanges();
    const sections = fixture.nativeElement.querySelectorAll('.sticker-group');
    expect(sections[0].querySelector('.upload-error')).toBeNull();
    expect(sections[1].querySelector('.upload-error')?.textContent).toContain('添加表情失败');
    expect(sections[2].querySelector('.upload-error')).toBeNull();
    expect(picker['error']()).toBe(false);
    expect(picker['activeId']()).toBe(secondPack.id);
    post.mockReturnValueOnce(of({ ...sticker, id: encodeId('999') }));
    await picker['upload'](event, pack.id);
    await picker['saveUpload']({ name: 'Tea', emoji: '🍵' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.upload-error')).toBeNull();
    expect(picker['activeId']()).toBe(secondPack.id);
  });

  async function renderDetails() {
    const fixture = TestBed.createComponent(StickerPicker);
    fixture.componentRef.setInput('selectable', false);
    fixture.componentRef.setInput('stickerId', sticker.id);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.componentInstance['busy']()).toBe(false);
    });
    return fixture;
  }

  it('opens the whole pack, selects the message sticker and changes selection without sending', async () => {
    const other = { ...sticker, id: encodeId('104'), isFavorited: true };
    api.getPack.mockReturnValueOnce(of({ ...pack, stickers: [other, sticker], stickerCount: 2 }));
    const fixture = await renderDetails();
    expect(api.getSticker).toHaveBeenCalledWith(sticker.id);
    expect(api.getPack).toHaveBeenCalledWith(pack.id);
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('Tea');
    expect(fixture.nativeElement.querySelector('.subtitle').textContent).toContain('2 张贴纸');
    expect(api.getMyFavorites).not.toHaveBeenCalled();
    const items = fixture.nativeElement.querySelectorAll('.sticker-item');
    expect(items).toHaveLength(2);
    expect(items[1].classList.contains('selected')).toBe(true);
    items[0].click();
    fixture.detectChanges();
    expect(items[0].classList.contains('selected')).toBe(true);
    expect(modals.dismiss).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.pack-bar')).toBeNull();
    const favorite = fixture.nativeElement.querySelector('ion-footer ion-button');
    expect(favorite.textContent).toContain('取消收藏');
    expect(favorite.color).toBe('danger');
    favorite.click();
    await fixture.whenStable();
    expect(api.deleteFavorite).toHaveBeenCalledWith(other.id);
    expect(favorite.textContent).toContain('收藏单个');
    expect(favorite.color).toBe('primary');
    favorite.click();
    await fixture.whenStable();
    expect(api.putFavorite).toHaveBeenCalledWith(other.id);
    const subscribe = fixture.nativeElement.querySelectorAll('ion-footer ion-button')[1];
    subscribe.click();
    await fixture.whenStable();
    expect(api.putSubscription).toHaveBeenCalledWith(pack.id);
    expect(subscribe.textContent).toContain('取消订阅');
    expect(subscribe.color).toBe('danger');
    expect(fixture.componentInstance['chosen']()?.isFavorited).toBe(true);
    subscribe.click();
    await fixture.whenStable();
    expect(api.deleteSubscription).toHaveBeenCalledWith(pack.id);
    expect(subscribe.textContent).toContain('订阅整组');
    expect(subscribe.color).toBe('primary');
  });

  it('retries a failed pack lookup without switching to the favorites library', async () => {
    api.getPack.mockReturnValueOnce(throwError(() => new Error('offline')));
    const fixture = await renderDetails();
    expect(fixture.componentInstance['error']()).toBe(true);
    await fixture.componentInstance['retry']();
    expect(fixture.componentInstance['pack']()?.id).toBe(pack.id);
    expect(fixture.componentInstance['chosen']()?.id).toBe(sticker.id);
    expect(api.getMyFavorites).not.toHaveBeenCalled();
  });

  it('keeps an ungrouped sticker available for individual favorites', async () => {
    api.getSticker.mockReturnValueOnce(of({ ...sticker, packs: [] }));
    const fixture = await renderDetails();
    expect(fixture.componentInstance['chosen']()?.id).toBe(sticker.id);
    expect(api.getPack).not.toHaveBeenCalled();
    const actions = fixture.nativeElement.querySelectorAll('ion-footer ion-button');
    expect(actions[0].disabled).toBe(false);
    expect(actions[1].disabled).toBe(true);
  });

  it('shows sticker skeletons instead of a spinner while the library loads', async () => {
    const response = new Subject<{ stickers: StickerSummary[] }>();
    api.getMyFavorites.mockReturnValueOnce(response);
    const fixture = TestBed.createComponent(StickerPicker);
    fixture.componentRef.setInput('embedded', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.sticker-skeleton')).toHaveLength(12);
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    response.next({ stickers: [sticker] });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('.sticker-skeleton')).toHaveLength(0);
    });
    expect(fixture.nativeElement.querySelectorAll('.sticker-item')).toHaveLength(1);
  });

  it('covers each sticker tile until its media paints', async () => {
    const { fixture } = await render();
    const tile: HTMLElement = fixture.nativeElement.querySelector('.sticker-item');
    const media = tile.querySelector('img')!;
    expect(tile.querySelector('.sticker-tile-skeleton')).not.toBeNull();
    expect(media.classList.contains('loaded')).toBe(false);
    media.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(media.classList.contains('loaded')).toBe(true);
  });

  it('emits an already displayed sticker while favorites reload, keeping navigation busy', async () => {
    const { fixture, button, selected } = await render();
    const response = new Subject<{ stickers: StickerSummary[] }>();
    api.getMyFavorites.mockReturnValueOnce(response);
    const tab = fixture.nativeElement.querySelector('.pack-tab') as HTMLButtonElement;
    tab.click();
    fixture.detectChanges();
    expect(tab.disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith(sticker);
    expect(modals.dismiss).not.toHaveBeenCalled();
    response.next({ stickers: [sticker] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(tab.disabled).toBe(false);
    });
  });

  it('sends the displayed sticker from a modal while another pack is loading', async () => {
    const { fixture, button, selected } = await render(false);
    const response = new Subject<StickerPackDetailResponse>();
    api.getPack.mockReturnValueOnce(response);
    fixture.nativeElement.querySelectorAll('.pack-tab')[1].click();
    fixture.detectChanges();
    expect(api.getPack).toHaveBeenCalledExactlyOnceWith(pack.id);
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(modals.dismiss).toHaveBeenCalledExactlyOnceWith(sticker, 'send');
    expect(selected).not.toHaveBeenCalled();
    response.next(pack);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it.each([false, true])('sends while changing favorite status from %s', async (isFavorited) => {
    const item = { ...sticker, isFavorited };
    const { fixture, selected } = await render();
    api.getPack.mockReturnValueOnce(of({ ...pack, stickers: [item] }));
    await fixture.componentInstance['openPack'](pack.id);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.sticker-item') as HTMLButtonElement;
    const response = new Subject<undefined>();
    const request = isFavorited ? api.deleteFavorite : api.putFavorite;
    request.mockReturnValueOnce(response);
    const favorite = fixture.componentInstance['favorite'](item);
    fixture.detectChanges();
    expect(request).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith({ ...item, isFavorited: !isFavorited });
    response.next(undefined);
    await favorite;
    fixture.detectChanges();
    button.click();
    expect(selected).toHaveBeenLastCalledWith({ ...item, isFavorited: !isFavorited });
  });

  it('adds a discovered pack without refreshing the library or losing current tiles', async () => {
    const { fixture } = await render();
    const picker = fixture.componentInstance;
    await picker['selectPack'](pack.id);
    fixture.detectChanges();
    const tile = fixture.nativeElement.querySelector('.sticker-item');
    api.getPack.mockClear();
    api.getMySubscribedPacks.mockClear();
    const added = { ...pack, id: encodeId('999'), isSubscribed: true };
    TestBed.inject(StickerUpdates).subscribed.next(added);
    fixture.detectChanges();
    expect(picker['packs']().map((pack) => pack.id)).toContain(added.id);
    expect(picker['activeId']()).toBe(pack.id);
    expect(fixture.nativeElement.querySelector('.sticker-item')).toBe(tile);
    expect(api.getPack).not.toHaveBeenCalled();
    expect(api.getMySubscribedPacks).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('button[routerLink="/sticker-discovery"]')).not.toBeNull();
    expect(api.postPack).not.toHaveBeenCalled();
  });

  it('preserves an added pack when an older library response arrives', async () => {
    const { fixture } = await render();
    const response = new Subject<{ packs: StickerPackDetailResponse[] }>();
    api.getMySubscribedPacks.mockReturnValueOnce(response);
    const loading = fixture.componentInstance['load']();
    const added = { ...pack, id: encodeId('999'), isSubscribed: true };
    TestBed.inject(StickerUpdates).subscribed.next(added);
    response.next({ packs: [pack] });
    await loading;
    expect(fixture.componentInstance['packs']().map((pack) => pack.id)).toContain(added.id);
  });

  it('keeps favorite state in the pack itself when a later subscription updates its metadata', async () => {
    const { fixture } = await render(false);
    const picker = fixture.componentInstance;
    await picker['openPack'](pack.id);
    await picker['favorite'](sticker);
    expect(picker['pack']()?.stickers).toBe(picker['stickers']());
    expect(picker['stickers']()[0].isFavorited).toBe(true);
    await picker['subscribe']();
    expect(picker['pack']()?.isSubscribed).toBe(true);
    expect(picker['stickers']()[0].isFavorited).toBe(true);
  });

  it('publishes subscriptions from full-pack previews to the discovery list and library', async () => {
    const { fixture } = await render(false);
    const picker = fixture.componentInstance;
    await picker['openPack'](pack.id);
    const subscribed = vi.fn();
    TestBed.inject(StickerUpdates).subscribed.subscribe(subscribed);
    await picker['subscribe']();
    expect(subscribed).toHaveBeenCalledExactlyOnceWith({ ...pack, isSubscribed: true });
    expect(preferences.upsertPackOrderItem).toHaveBeenCalledWith(expect.objectContaining({ stickerPackId: pack.id }));
  });

  it('sends while subscribing to a pack', async () => {
    const { fixture } = await render(false);
    fixture.componentRef.setInput('packId', pack.id);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance['pack']()?.id).toBe(pack.id));
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.sticker-item') as HTMLButtonElement;
    const response = new Subject<undefined>();
    api.putSubscription.mockReturnValueOnce(response);
    const subscription = fixture.componentInstance['subscribe']();
    fixture.detectChanges();
    expect(api.putSubscription).toHaveBeenCalledExactlyOnceWith(pack.id);
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(modals.dismiss).toHaveBeenCalledExactlyOnceWith(sticker, 'send');
    response.next(undefined);
    await subscription;
  });

  it.each([true, false])('does not send in browse mode with embedded=%s, even during a request', async (embedded) => {
    const { fixture, button, selected } = await render(embedded, false);
    const response = new Subject<undefined>();
    api.putFavorite.mockReturnValueOnce(response);
    const favorite = fixture.componentInstance['favorite'](sticker);
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    button.click();
    expect(selected).not.toHaveBeenCalled();
    expect(modals.dismiss).not.toHaveBeenCalled();
    response.next(undefined);
    await favorite;
  });

  it('keeps a long press from sending and allows the next tap during a request', async () => {
    const { fixture, button, pointer, selected } = await render();
    const response = new Subject<undefined>();
    api.putFavorite.mockReturnValueOnce(response);
    const favorite = fixture.componentInstance['favorite'](sticker);
    vi.useFakeTimers();
    pointer('pointerdown');
    vi.advanceTimersByTime(400);
    pointer('pointerup');
    button.click();
    expect(fixture.componentInstance['menu']()?.sticker).toEqual(sticker);
    expect(selected).not.toHaveBeenCalled();
    fixture.componentInstance['menu'].set(undefined);
    pointer('pointerdown');
    pointer('pointerup');
    button.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith(sticker);
    response.next(undefined);
    await favorite;
  });
  it('restores a favorite immediately after a failed optimistic removal', async () => {
    const item = { ...sticker, isFavorited: true };
    api.getMyFavorites.mockReturnValueOnce(of({ stickers: [item] }));
    const { fixture } = await render();
    const response = new Subject<undefined>();
    api.deleteFavorite.mockReturnValueOnce(response);
    const picker = fixture.componentInstance;
    const operation = picker['favorite'](item);
    expect(picker['stickers']()).toEqual([]);
    response.error(new Error('offline'));
    await operation;
    expect(picker['stickers']()[0]).toEqual(item);
    expect(picker['favoriteFailed']()).toBe(true);
  });

  it('restores a pack subscription after a failed optimistic change', async () => {
    const { fixture } = await render(false);
    const picker = fixture.componentInstance;
    await picker['openPack'](pack.id);
    const previous = picker['pack']()!;
    const response = new Subject<undefined>();
    (previous.isSubscribed ? api.deleteSubscription : api.putSubscription).mockReturnValueOnce(response);
    const operation = picker['subscribe']();
    expect(picker['pack']()?.isSubscribed).toBe(!previous.isSubscribed);
    response.error(new Error('offline'));
    await operation;
    expect(picker['pack']()).toEqual(previous);
    expect(picker['error']()).toBe(true);
  });

  it('records pack usage only inside the auto-sort window while sending', async () => {
    preferences.autoSortPacksEnabled.mockReturnValue(true);
    const { fixture } = await render();
    await fixture.componentInstance['openPack'](pack.id);
    fixture.componentInstance['send'](sticker);
    const item = { stickerPackId: pack.id, lastUsedOn: expect.any(Number) };
    expect(preferences.upsertPackOrderItem).toHaveBeenCalledWith(item);
    expect(preferences.syncPackOrder).toHaveBeenCalledWith([{ ...item, isAutoSort: true }]);

    preferences.upsertPackOrderItem.mockClear();
    preferences.syncPackOrder.mockClear();
    preferences.packOrder.mockReturnValue(
      Array.from({ length: 20 }, (_, index) => ({
        stickerPackId: encodeId(String(900 + index)),
        lastUsedOn: 1000 - index,
      })),
    );
    fixture.componentInstance['libraryPacks'].update((packs) => [
      ...Array.from({ length: 20 }, (_, index) => ({ ...pack, id: encodeId(String(900 + index)) })),
      pack,
    ]);
    fixture.componentInstance['send'](sticker);
    expect(preferences.upsertPackOrderItem).not.toHaveBeenCalled();
  });

  it('records favorite usage and re-sorts the favorites view', async () => {
    preferences.autoSortFavoritesEnabled.mockReturnValue(true);
    const other = { ...sticker, id: encodeId('104') };
    api.getMyFavorites.mockReturnValueOnce(of({ stickers: [sticker, other] }));
    const { fixture, button, selected } = await render();
    preferences.favoriteStickerOrder.mockReturnValue([{ stickerId: other.id, lastUsedOn: Date.now() }]);
    button.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith(sticker);
    expect(preferences.upsertFavoriteStickerOrderItem).toHaveBeenCalledWith({
      stickerId: sticker.id,
      lastUsedOn: expect.any(Number),
    });
    expect(fixture.componentInstance['stickers']().map((item) => item.id)).toEqual([other.id, sticker.id]);
  });
});
