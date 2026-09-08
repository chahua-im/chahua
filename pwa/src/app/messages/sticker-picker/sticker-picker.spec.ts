import { TestBed } from '@angular/core/testing';
import { AlertController, ModalController } from '@ionic/angular';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { StickersService } from '../../../generated/endpoints/stickers/stickers.service';
import type { StickerPackDetailResponse, StickerSummary } from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { MessageAttachments } from '../message-attachments/message-attachments';
import { StickerPicker } from './sticker-picker';

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
  isSubscribed: false,
  stickerCount: 1,
  stickers: [sticker],
};

describe('StickerPicker selection during requests', () => {
  const api = {
    postPack: vi.fn(() => of({ ...pack, stickers: [] })),
    getMyFavorites: vi.fn(() => of({ stickers: [sticker] })),
    getMySubscribedPacks: vi.fn(() => of({ packs: [pack] })),
    getMyOwnedPacks: vi.fn(() => of({ packs: [] })),
    getPack: vi.fn(() => of(pack)),
    putFavorite: vi.fn(() => of(undefined)),
    deleteFavorite: vi.fn(() => of(undefined)),
    putSubscription: vi.fn(() => of(undefined)),
  };
  const modals = { dismiss: vi.fn().mockResolvedValue(true) };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getMyFavorites.mockReset().mockReturnValue(of({ stickers: [sticker] }));
    api.getMySubscribedPacks.mockReset().mockReturnValue(of({ packs: [pack] }));
    api.getMyOwnedPacks.mockReset().mockReturnValue(of({ packs: [] }));
    api.getPack.mockReset().mockReturnValue(of(pack));
    api.putFavorite.mockReset().mockReturnValue(of(undefined));
    api.deleteFavorite.mockReset().mockReturnValue(of(undefined));
    api.putSubscription.mockReset().mockReturnValue(of(undefined));
    TestBed.configureTestingModule({
      providers: [
        { provide: StickersService, useValue: api },
        { provide: ModalController, useValue: modals },
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
    })
      .overrideComponent(StickerPicker, { remove: { imports: [ContentScrollbars] } })
      .overrideComponent(MessageAttachments, { set: { template: '' } });
  });
  afterEach(() => vi.useRealTimers());

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

  it('emits an already displayed sticker while favorites reload, keeping navigation busy', async () => {
    const { fixture, button, selected } = await render();
    const response = new Subject<{ stickers: StickerSummary[] }>();
    api.getMyFavorites.mockReturnValueOnce(response);
    const tab = fixture.nativeElement.querySelector('.pack-tab') as HTMLButtonElement;
    tab.click();
    fixture.detectChanges();
    expect(tab.disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('ion-spinner')).not.toBeNull();
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
    expect(fixture.nativeElement.querySelector('ion-spinner')).not.toBeNull();
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
    api.getMyFavorites.mockReturnValueOnce(of({ stickers: [item] }));
    const { fixture, button, selected } = await render();
    const response = new Subject<undefined>();
    const request = isFavorited ? api.deleteFavorite : api.putFavorite;
    request.mockReturnValueOnce(response);
    const favorite = fixture.componentInstance['favorite'](item);
    fixture.detectChanges();
    expect(request).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(fixture.nativeElement.querySelector('ion-spinner')).not.toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith(item);
    response.next(undefined);
    await favorite;
    fixture.detectChanges();
    button.click();
    expect(selected).toHaveBeenLastCalledWith({ ...item, isFavorited: !isFavorited });
  });

  it('opens a newly created pack directly from the create response', async () => {
    const { fixture } = await render();
    api.getMyFavorites.mockClear();
    api.getMySubscribedPacks.mockClear();
    api.getMyOwnedPacks.mockClear();
    await fixture.componentInstance['createPack']();
    expect(api.postPack).toHaveBeenCalledWith({ name: 'Tea' });
    expect(fixture.componentInstance['pack']()?.id).toBe(pack.id);
    expect(fixture.componentInstance['stickers']()).toEqual([]);
    expect(api.getPack).not.toHaveBeenCalled();
    expect(api.getMyFavorites).not.toHaveBeenCalled();
    expect(api.getMySubscribedPacks).not.toHaveBeenCalled();
    expect(api.getMyOwnedPacks).not.toHaveBeenCalled();
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

  it('sends while subscribing to a pack', async () => {
    const { fixture, button } = await render(false);
    fixture.componentRef.setInput('packId', pack.id);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const response = new Subject<undefined>();
    api.putSubscription.mockReturnValueOnce(response);
    const subscription = fixture.componentInstance['subscribe']();
    fixture.detectChanges();
    expect(api.putSubscription).toHaveBeenCalledExactlyOnceWith(pack.id);
    expect(fixture.nativeElement.querySelector('ion-spinner')).not.toBeNull();
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
});
