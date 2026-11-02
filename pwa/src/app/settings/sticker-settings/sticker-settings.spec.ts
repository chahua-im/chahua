import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { IonModal } from '@ionic/angular';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { vi } from 'vitest';
import { StickerPackVisibility, type StickerPackSummary } from '../../../generated/models';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { Preferences } from '../preferences';
import { EmojiPanel } from '../../messages/emoji-panel/emoji-panel';
import { StickerPreferences } from '../sticker-preferences';
import { StickerSettings } from './sticker-settings';

const ownedPack: StickerPackSummary = {
  id: encodeId('201'),
  name: '我的包',
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z',
  ownerUid: 1,
  isSubscribed: true,
  visibility: StickerPackVisibility.public,
  stickerCount: 3,
};
const subscribed: StickerPackSummary = { ...ownedPack, id: encodeId('202'), name: '订阅包', ownerUid: 2 };
const other: StickerPackSummary = { ...ownedPack, id: encodeId('203'), name: '另一个包', ownerUid: 3 };
const wirePack = (pack: StickerPackSummary) => ({
  ...pack,
  id: decodeId(pack.id),
  previewSticker: pack.previewSticker && {
    ...pack.previewSticker,
    id: decodeId(pack.previewSticker.id),
    media: { ...pack.previewSticker.media, id: decodeId(pack.previewSticker.media.id) },
  },
});

describe('StickerSettings', () => {
  const preferences = {
    autoSortPacksEnabled: vi.fn(() => false),
    autoSortFavoritesEnabled: vi.fn(() => false),
    packOrder: vi.fn(() => [] as { stickerPackId: SnowflakeID; lastUsedOn: number }[]),
    upsertPackOrderItem: vi.fn(),
    syncPackOrder: vi.fn(async () => true),
  };
  const pinnedReactions = signal<string[]>([]);
  const reactions = {
    pinnedReactions,
    setPinnedReactions: vi.fn((reactions: string[]) => pinnedReactions.set(reactions)),
  };
  const navigate = vi.fn(async () => true);
  let peer: RpcTestPeer;

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.clearAllMocks();
    pinnedReactions.set([]);
    preferences.autoSortPacksEnabled.mockReturnValue(false);
    preferences.autoSortFavoritesEnabled.mockReturnValue(false);
    preferences.packOrder.mockReturnValue([]);
    preferences.syncPackOrder.mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        provideRpcTesting(),
        { provide: StickerPreferences, useValue: preferences },
        { provide: Preferences, useValue: reactions },
        { provide: PanelNavigation, useValue: { back: vi.fn() } },
        { provide: AlertController, useValue: { create: vi.fn() } },
        { provide: Router, useValue: { navigate } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      try {
        TestBed.resetTestingModule();
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }
  });

  function replyPacks() {
    peer.expect('stickers.listOwnedPacks').flush({ packs: [wirePack(ownedPack)] });
    peer.expect('stickers.listSubscribedPacks').flush({ packs: [wirePack(subscribed), wirePack(other)] });
  }

  function page() {
    const fixture = TestBed.createComponent(StickerSettings);
    fixture.detectChanges();
    return fixture;
  }

  async function loaded() {
    const fixture = page();
    replyPacks();
    await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
    return fixture;
  }

  it('keeps loaded rows and their DOM during a failed resume refresh and retry', async () => {
    const fixture = await loaded();
    fixture.detectChanges();
    const list = fixture.nativeElement.querySelector('ion-reorder-group');
    const row = list.querySelector('ion-item');
    fixture.componentInstance.panelResume();
    fixture.detectChanges();
    const owned = peer.expect('stickers.listOwnedPacks');
    const subscriptions = peer.expect('stickers.listSubscribedPacks');
    expect(fixture.nativeElement.querySelector('ion-reorder-group')).toBe(list);
    owned.error(1503);
    subscriptions.error(1503);
    await vi.waitFor(() => expect(fixture.componentInstance['loadError']()).toBe(true));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-reorder-group')).toBe(list);
    expect(list.querySelector('ion-item')).toBe(row);
    expect(fixture.nativeElement.querySelector('app-load-error')).not.toBeNull();
    const retry = fixture.componentInstance['load']();
    replyPacks();
    await retry;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-reorder-group')).toBe(list);
    expect(list.querySelector('ion-item')).toBe(row);
    expect(fixture.nativeElement.querySelector('app-load-error')).toBeNull();
  });

  it('merges owned and subscribed packs, sorting by usage order and flagging owned', async () => {
    preferences.packOrder.mockReturnValue([
      { stickerPackId: other.id, lastUsedOn: 100 },
      { stickerPackId: ownedPack.id, lastUsedOn: 50 },
    ]);
    const component = (await loaded()).componentInstance;
    expect(component['ownedIds']()).toEqual(new Set([ownedPack.id]));
    expect(component['orderedPacks']().map((pack) => pack.id)).toEqual([other.id, ownedPack.id, subscribed.id]);
  });

  it('opens the shared add-packs panel from the settings entry', async () => {
    const fixture = await loaded();
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const label = root.querySelector('ion-label[color="primary"]');
    expect(label).not.toBeNull();
    label!.closest('ion-item')!.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(['/sticker-discovery']);
    peer.expectNone('stickers.createPack');
    expect(fixture.nativeElement.querySelector('app-sticker-editor')).toBeNull();
  });

  it('includes newly subscribed packs when returning from discovery', async () => {
    const component = (await loaded()).componentInstance;
    const added = { ...subscribed, id: encodeId('301'), name: '新订阅包' };
    component.panelResume();
    expect(component['orderedPacks']()).toHaveLength(3);
    peer.expect('stickers.listOwnedPacks').flush({ packs: [wirePack(ownedPack)] });
    peer.expect('stickers.listSubscribedPacks').flush({ packs: [subscribed, other, added].map(wirePack) });
    await vi.waitFor(() => expect(component['loading']()).toBe(false));
    expect(component['orderedPacks']().map((pack) => pack.id)).toContain(added.id);
  });

  it('exposes a failed reorder and retries the same intended order', async () => {
    preferences.syncPackOrder.mockResolvedValueOnce(false);
    const component = (await loaded()).componentInstance;
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

  it('computes midpoint order values when packs are reordered', async () => {
    preferences.packOrder.mockReturnValue([
      { stickerPackId: ownedPack.id, lastUsedOn: 100 },
      { stickerPackId: subscribed.id, lastUsedOn: 50 },
    ]);
    const component = (await loaded()).componentInstance;
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
    vi.setSystemTime(0);
    const component = (await loaded()).componentInstance;
    component['lastReorder'] = Date.now();
    component['openPack'](subscribed);
    expect(navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(301);
    component['openPack'](subscribed);
    expect(navigate).toHaveBeenCalledWith(['/settings/stickers', '202']);
  });

  it('removes individual pinned emoji and caps unique additions at five', async () => {
    const component = (await loaded()).componentInstance;
    pinnedReactions.set(['👍', '❤️']);
    component['addPinned']('👍');
    expect(pinnedReactions()).toEqual(['👍', '❤️']);
    for (const emoji of ['😂', '🍵', '🎉', '😮']) component['addPinned'](emoji);
    expect(pinnedReactions()).toEqual(['👍', '❤️', '😂', '🍵', '🎉']);
    component['removePinned']('❤️');
    expect(pinnedReactions()).toEqual(['👍', '😂', '🍵', '🎉']);
  });

  it('uses the shared panel to add pinned reactions and handles back and backdrop dismissal', () => {
    vi.spyOn(IonModal.prototype, 'isOpen', 'set').mockImplementation(() => {});
    const fixture = TestBed.createComponent(StickerSettings);
    const component = fixture.componentInstance;
    component['reactions'].setPinnedReactions(['👍']);
    component['choosingPinned'].set(true);
    fixture.detectChanges();
    replyPacks();
    fixture.debugElement.query(By.directive(IonModal)).nativeElement.dispatchEvent(new CustomEvent('ionMount'));
    fixture.detectChanges();
    const panel = fixture.debugElement.query(By.directive(EmojiPanel)).componentInstance as EmojiPanel;
    panel.chosen.emit('🍵');
    expect(component['reactions'].pinnedReactions()).toEqual(['👍', '🍵']);
    expect(component['choosingPinned']()).toBe(true);
    panel.back.emit();
    expect(component['choosingPinned']()).toBe(false);
    component['choosingPinned'].set(true);
    panel.dismissed.emit();
    expect(component['choosingPinned']()).toBe(false);
    component['choosingPinned'].set(true);
    for (const emoji of ['😂', '❤️', '🎉']) panel.chosen.emit(emoji);
    expect(component['choosingPinned']()).toBe(false);
    expect(component['reactions'].pinnedReactions()).toHaveLength(5);
  });
});
