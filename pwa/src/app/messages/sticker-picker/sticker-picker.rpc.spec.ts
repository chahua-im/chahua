import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { AlertController, ModalController } from '@ionic/angular';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import {
  StickerPackVisibility,
  type StickerPackDetailResponse,
  type StickerPackSummary,
  type StickerSummary,
} from '../../../generated/models';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { StickerPreferences } from '../../settings/sticker-preferences';
import { StickerUpdates } from '../sticker-updates';
import { StickerPicker } from './sticker-picker';

const sticker: StickerSummary = {
  id: encodeId('101'),
  createdAt: '2026-09-08T00:00:00Z',
  emoji: '🍵',
  isFavorited: false,
  media: { id: encodeId('102'), contentType: 'image/png', size: 12, url: 'https://example.test/sticker.png' },
};
const pack: StickerPackDetailResponse = {
  id: encodeId('103'),
  name: 'Tea',
  createdAt: sticker.createdAt,
  updatedAt: sticker.createdAt,
  ownerUid: 1,
  isSubscribed: false,
  visibility: StickerPackVisibility.public,
  stickerCount: 1,
  stickers: [sticker],
};
const wireSticker = { ...sticker, id: '101', media: { ...sticker.media, id: '102' } };
const wirePack = { ...pack, id: '103', stickers: [wireSticker] };
const wireSummary = (value: StickerPackSummary) => ({
  ...value,
  id: decodeId(value.id),
  previewSticker: value.previewSticker && {
    ...value.previewSticker,
    id: decodeId(value.previewSticker.id),
    media: { ...value.previewSticker.media, id: decodeId(value.previewSticker.media.id) },
  },
});

describe('StickerPicker selection during RPC requests', () => {
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
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideChahuaBaseUrl('/_api'),
        provideRpcTesting(),
        { provide: ModalController, useValue: modals },
        { provide: StickerPreferences, useValue: preferences },
        {
          provide: AlertController,
          useValue: {
            create: async () => ({
              present: async () => {},
              onDidDismiss: async () => ({ role: 'confirm', data: { values: { name: 'Tea' } } }),
            }),
          },
        },
      ],
    });
  });

  afterEach(() => {
    try {
      TestBed.inject(RpcTestPeer).verify();
    } finally {
      try {
        TestBed.resetTestingModule();
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    }
  });

  function peer() {
    const rpc = TestBed.inject(RpcTestPeer);
    rpc.authenticate();
    return rpc;
  }

  function replyLibrary(rpc: RpcTestPeer, favorites: StickerSummary[] = [sticker]) {
    rpc.expect('stickers.listFavorites').flush({
      stickers: favorites.map((item) => ({
        ...item,
        id: decodeId(item.id),
        media: { ...item.media, id: decodeId(item.media.id) },
      })),
    });
    rpc.expect('stickers.listSubscribedPacks').flush({ packs: [wireSummary(pack)] });
    rpc.expect('stickers.listOwnedPacks').flush({ packs: [] });
  }

  async function render(embedded = true, selectable = true, favorites: StickerSummary[] = [sticker]) {
    const rpc = peer();
    const fixture = TestBed.createComponent(StickerPicker);
    fixture.componentRef.setInput('embedded', embedded);
    fixture.componentRef.setInput('selectable', selectable);
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    fixture.detectChanges();
    replyLibrary(rpc, favorites);
    await fixture.whenStable();
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.nativeElement.querySelector('.sticker-item')).not.toBeNull());
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
    return { fixture, rpc, button, pointer, selected };
  }

  async function renderDetails(rpc = peer()) {
    const fixture = TestBed.createComponent(StickerPicker);
    fixture.componentRef.setInput('selectable', false);
    fixture.componentRef.setInput('stickerId', sticker.id);
    fixture.detectChanges();
    rpc.expect('stickers.get', { stickerId: '101' }).flush({ ...wireSticker, packs: [wireSummary(pack)] });
    (await rpc.expectAsync('stickers.getPack', { packId: '103' })).flush(wirePack);
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance['busy']()).toBe(false));
    fixture.detectChanges();
    return { fixture, rpc };
  }

  it('keeps local additions when an older pack RPC response arrives', async () => {
    const { fixture, rpc } = await renderDetails();
    const picker = fixture.componentInstance;
    const pending = picker['openPack'](pack.id);
    const response = rpc.expect('stickers.getPack', { packId: decodeId(pack.id) });
    const added = { ...sticker, id: encodeId('109') };
    TestBed.inject(StickerUpdates).added.next({ pack, sticker: added });
    expect(picker['stickers']()).toEqual([sticker, added]);
    response.flush(wirePack);
    await pending;
    expect(picker['stickers']()).toEqual([sticker, added]);
    expect(picker['pack']()?.stickerCount).toBe(2);
  });

  it('keeps a newly added pack when an older library RPC response arrives', async () => {
    const { fixture, rpc } = await render();
    const pending = fixture.componentInstance['load']();
    const newPack = { ...pack, id: encodeId('120'), stickerCount: 0 };
    TestBed.inject(StickerUpdates).added.next({ pack: newPack, sticker });
    replyLibrary(rpc);
    await pending;
    expect(fixture.componentInstance['packs']().find((item) => item.id === newPack.id)?.stickerCount).toBe(1);
  });

  it('opens the whole pack, selects the message sticker and changes selection without sending', async () => {
    const rpc = peer();
    const other = { ...sticker, id: encodeId('104'), isFavorited: true };
    const { fixture } = await renderDetails(rpc);
    const picker = fixture.componentInstance;
    picker['setContent']({ ...pack, stickers: [other, sticker], stickerCount: 2 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('Tea');
    expect(fixture.nativeElement.querySelector('.subtitle').textContent).toContain('2 张贴纸');
    rpc.expectNone('stickers.listFavorites');
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
    const unfavorite = picker['favorite'](other);
    rpc.expect('stickers.unfavorite', { stickerId: '104' }).flush(null);
    await unfavorite;
    fixture.detectChanges();
    expect(favorite.textContent).toContain('收藏单个');
    expect(favorite.color).toBe('primary');
    const refavorite = picker['favorite'](picker['chosen']()!);
    rpc.expect('stickers.favorite', { stickerId: '104' }).flush(null);
    await refavorite;
    fixture.detectChanges();
    const subscribe = fixture.nativeElement.querySelectorAll('ion-footer ion-button')[1];
    const subscribing = picker['subscribe']();
    rpc.expect('stickers.subscribeToPack', { packId: '103' }).flush(null);
    await subscribing;
    fixture.detectChanges();
    expect(subscribe.textContent).toContain('取消订阅');
    expect(subscribe.color).toBe('danger');
    expect(picker['chosen']()?.isFavorited).toBe(true);
    const unsubscribing = picker['subscribe']();
    rpc.expect('stickers.unsubscribeFromPack', { packId: '103' }).flush(null);
    await unsubscribing;
    fixture.detectChanges();
    expect(subscribe.textContent).toContain('订阅整组');
    expect(subscribe.color).toBe('primary');
  });

  it('retries a failed pack lookup without switching to the favorites library', async () => {
    const rpc = peer();
    const fixture = TestBed.createComponent(StickerPicker);
    fixture.componentRef.setInput('selectable', false);
    fixture.componentRef.setInput('stickerId', sticker.id);
    fixture.detectChanges();
    rpc.expect('stickers.get', { stickerId: '101' }).flush({ ...wireSticker, packs: [wireSummary(pack)] });
    (await rpc.expectAsync('stickers.getPack', { packId: '103' })).error(1503);
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance['error']()).toBe(true));
    const retry = fixture.componentInstance['retry']();
    rpc.expect('stickers.getPack', { packId: '103' }).flush(wirePack);
    await retry;
    expect(fixture.componentInstance['pack']()?.id).toBe(pack.id);
    expect(fixture.componentInstance['chosen']()?.id).toBe(sticker.id);
    rpc.expectNone('stickers.listFavorites');
  });

  it('keeps an ungrouped sticker available for individual favorites', async () => {
    const rpc = peer();
    const fixture = TestBed.createComponent(StickerPicker);
    fixture.componentRef.setInput('selectable', false);
    fixture.componentRef.setInput('stickerId', sticker.id);
    fixture.detectChanges();
    rpc.expect('stickers.get', { stickerId: '101' }).flush({ ...wireSticker, packs: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['chosen']()?.id).toBe(sticker.id);
    rpc.expectNone('stickers.getPack');
    const actions = fixture.nativeElement.querySelectorAll('ion-footer ion-button');
    expect(actions[0].disabled).toBe(false);
    expect(actions[1].disabled).toBe(true);
  });

  it('shows sticker skeletons instead of a spinner while the library loads', async () => {
    const rpc = peer();
    const fixture = TestBed.createComponent(StickerPicker);
    fixture.componentRef.setInput('embedded', true);
    fixture.detectChanges();
    const favorites = rpc.expect('stickers.listFavorites');
    rpc.expect('stickers.listSubscribedPacks').flush({ packs: [wireSummary(pack)] });
    rpc.expect('stickers.listOwnedPacks').flush({ packs: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.sticker-skeleton')).toHaveLength(12);
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    favorites.flush({ stickers: [wireSticker] });
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
    const { fixture, rpc, button, selected } = await render();
    const tab = fixture.nativeElement.querySelector('.pack-tab') as HTMLButtonElement;
    tab.click();
    fixture.detectChanges();
    const favorites = rpc.expect('stickers.listFavorites');
    rpc.expect('stickers.listSubscribedPacks').flush({ packs: [wireSummary(pack)] });
    rpc.expect('stickers.listOwnedPacks').flush({ packs: [] });
    expect(tab.disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith(sticker);
    expect(modals.dismiss).not.toHaveBeenCalled();
    favorites.flush({ stickers: [wireSticker] });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(tab.disabled).toBe(false);
    });
  });

  it('sends the displayed sticker from a modal while another pack is loading', async () => {
    const { fixture, rpc, button, selected } = await render(false);
    fixture.nativeElement.querySelectorAll('.pack-tab')[1].click();
    fixture.detectChanges();
    const request = rpc.expect('stickers.getPack', { packId: '103' });
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(modals.dismiss).toHaveBeenCalledExactlyOnceWith(sticker, 'send');
    expect(selected).not.toHaveBeenCalled();
    request.flush(wirePack);
    await fixture.whenStable();
  });

  it.each([false, true])('sends while changing favorite status from %s', async (isFavorited) => {
    const item = { ...sticker, isFavorited };
    const { fixture, rpc, selected } = await render(true, true, [item]);
    const opening = fixture.componentInstance['openPack'](pack.id);
    rpc.expect('stickers.getPack').flush({ ...wirePack, stickers: [{ ...wireSticker, isFavorited }] });
    await opening;
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.sticker-item') as HTMLButtonElement;
    const favorite = fixture.componentInstance['favorite'](item);
    const request = rpc.expect(isFavorited ? 'stickers.unfavorite' : 'stickers.favorite', { stickerId: '101' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith({ ...item, isFavorited: !isFavorited });
    request.flush(null);
    await favorite;
    fixture.detectChanges();
    button.click();
    expect(selected).toHaveBeenLastCalledWith({ ...item, isFavorited: !isFavorited });
  });

  it('keeps favorite state in the pack itself when a later subscription updates its metadata', async () => {
    const { fixture, rpc } = await render(false);
    const picker = fixture.componentInstance;
    const opened = picker['openPack'](pack.id);
    rpc.expect('stickers.getPack', { packId: '103' }).flush(wirePack);
    await opened;
    const favorite = picker['favorite'](sticker);
    rpc.expect('stickers.favorite', { stickerId: '101' }).flush(null);
    await favorite;
    expect(picker['pack']()?.stickers).toBe(picker['stickers']());
    expect(picker['stickers']()[0].isFavorited).toBe(true);
    const subscription = picker['subscribe']();
    rpc.expect('stickers.subscribeToPack', { packId: '103' }).flush(null);
    await subscription;
    expect(picker['pack']()?.isSubscribed).toBe(true);
    expect(picker['stickers']()[0].isFavorited).toBe(true);
  });

  it('sends while subscribing to a pack', async () => {
    const { fixture, rpc } = await render(false);
    fixture.componentRef.setInput('packId', pack.id);
    fixture.detectChanges();
    const opening = rpc.expect('stickers.getPack', { packId: '103' });
    opening.flush(wirePack);
    await vi.waitFor(() => expect(fixture.componentInstance['busy']()).toBe(false));
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.sticker-item') as HTMLButtonElement;
    const subscription = fixture.componentInstance['subscribe']();
    const request = rpc.expect('stickers.subscribeToPack', { packId: '103' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sticker-skeleton')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(modals.dismiss).toHaveBeenCalledExactlyOnceWith(sticker, 'send');
    request.flush(null);
    await subscription;
  });

  it.each([true, false])('does not send in browse mode with embedded=%s, even during a request', async (embedded) => {
    const { fixture, rpc, button, selected } = await render(embedded, false);
    const favorite = fixture.componentInstance['favorite'](sticker);
    const request = rpc.expect('stickers.favorite', { stickerId: '101' });
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    button.click();
    expect(selected).not.toHaveBeenCalled();
    expect(modals.dismiss).not.toHaveBeenCalled();
    request.flush(null);
    await favorite;
  });

  it('keeps a long press from sending and allows the next tap during a request', async () => {
    const { fixture, rpc, button, pointer, selected } = await render();
    const favorite = fixture.componentInstance['favorite'](sticker);
    const request = rpc.expect('stickers.favorite', { stickerId: '101' });
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
    request.flush(null);
    await favorite;
  });

  it('restores a favorite immediately after a failed optimistic removal', async () => {
    const item = { ...sticker, isFavorited: true };
    const { fixture, rpc } = await render(true, true, [item]);
    const picker = fixture.componentInstance;
    const operation = picker['favorite'](item);
    expect(picker['stickers']()).toEqual([]);
    rpc.expect('stickers.unfavorite', { stickerId: '101' }).error(1503);
    await operation;
    expect(picker['stickers']()[0]).toEqual(item);
    expect(picker['favoriteFailed']()).toBe(true);
  });

  it('restores a pack subscription after a failed optimistic change', async () => {
    const { fixture, rpc } = await render(false);
    const picker = fixture.componentInstance;
    const opening = picker['openPack'](pack.id);
    rpc.expect('stickers.getPack', { packId: '103' }).flush(wirePack);
    await opening;
    const previous = picker['pack']()!;
    const operation = picker['subscribe']();
    expect(picker['pack']()?.isSubscribed).toBe(!previous.isSubscribed);
    rpc.expect('stickers.subscribeToPack', { packId: '103' }).error(1503);
    await operation;
    expect(picker['pack']()).toEqual(previous);
    expect(picker['error']()).toBe(true);
  });

  it('records pack usage only inside the auto-sort window while sending', async () => {
    preferences.autoSortPacksEnabled.mockReturnValue(true);
    const { fixture, rpc } = await render();
    const opening = fixture.componentInstance['openPack'](pack.id);
    rpc.expect('stickers.getPack', { packId: '103' }).flush(wirePack);
    await opening;
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
      ...packs,
    ]);
    fixture.componentInstance['send'](sticker);
    expect(preferences.upsertPackOrderItem).not.toHaveBeenCalled();
  });

  it('records favorite usage and re-sorts the favorites view', async () => {
    preferences.autoSortFavoritesEnabled.mockReturnValue(true);
    const other = { ...sticker, id: encodeId('104') };
    const { fixture, button, selected } = await render(true, true, [sticker, other]);
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
