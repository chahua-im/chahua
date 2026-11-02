import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import {
  StickerPackSort,
  StickerPackVisibility,
  type StickerPackDiscoveryItem,
  type StickerPackDiscoveryResponse,
} from '../../../generated/models';
import { encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { SessionStore } from '../../session/session-store';
import { StickerPreferences } from '../../settings/sticker-preferences';
import { StickerUpdates } from '../sticker-updates';
import { StickerDiscovery } from './sticker-discovery';

const pack: StickerPackDiscoveryItem = {
  id: encodeId('101'),
  name: 'Tea',
  ownerUid: 2,
  visibility: StickerPackVisibility.public,
  createdAt: '2026-10-30T00:00:00Z',
  updatedAt: '2026-10-30T00:00:00Z',
  isSubscribed: false,
  stickerCount: 1,
  subscriberCount: 10,
  recentSubscriberCount: 5,
  previewStickers: [
    {
      id: encodeId('102'),
      emoji: '🍵',
      media: {
        id: encodeId('103'),
        contentType: 'image/png',
        size: 12,
        url: 'https://example.test/sticker.png',
      },
    },
  ],
};
const page: StickerPackDiscoveryResponse = {
  packs: [pack],
  hasMore: false,
  recentWindowDays: 30,
  statsUpdatedAt: pack.updatedAt,
};
const createdPack = { ...pack, id: encodeId('900'), ownerUid: 1, isSubscribed: true, stickerCount: 0, stickers: [] };

describe('StickerDiscovery', () => {
  const api = { getPacks: vi.fn(), putSubscription: vi.fn(), postPack: vi.fn() };
  const user = signal<{ uid: number } | undefined>({ uid: 1 });
  const preferences = { upsertPackOrderItem: vi.fn() };

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    api.getPacks.mockReset().mockReturnValue(of(page));
    api.putSubscription.mockReset().mockReturnValue(of(undefined));
    api.postPack.mockReset().mockReturnValue(of(createdPack));
    preferences.upsertPackOrderItem.mockClear();
    user.set({ uid: 1 });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: RpcApi,
          useValue: {
            stickers: {
              listPacks: api.getPacks,
              createPack: api.postPack,
              subscribeToPack: ({ packId }: { packId: SnowflakeID }) => api.putSubscription(packId),
            },
          },
        },
        { provide: SessionStore, useValue: { user } },
        { provide: StickerPreferences, useValue: preferences },
      ],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function render() {
    const fixture = TestBed.createComponent(StickerDiscovery);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, discovery: fixture.componentInstance };
  }

  it('loads trending packs and uses server filters and ranking for searches', async () => {
    const { fixture, discovery } = await render();
    expect(api.getPacks).toHaveBeenCalledExactlyOnceWith({
      q: undefined,
      sort: StickerPackSort.trending,
      limit: 20,
      offset: 0,
    });
    discovery['query'].set(' 茶 ');
    discovery['sort'].set(StickerPackSort.subscribers);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.getPacks).toHaveBeenLastCalledWith({ q: '茶', sort: StickerPackSort.subscribers, limit: 20, offset: 0 });
  });

  it('creates once, synchronizes the library and opens management without refreshing discovery', async () => {
    const { discovery } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const changed = vi.spyOn(TestBed.inject(StickerUpdates).changed, 'next');
    const response = new Subject<typeof createdPack>();
    api.postPack.mockReturnValueOnce(response);
    discovery['createPack']();
    const saving = discovery['savePack']({ name: ' 新包 ', emoji: '' });
    await discovery['savePack']({ name: ' 新包 ', emoji: '' });
    expect(api.postPack).toHaveBeenCalledExactlyOnceWith({ name: '新包' });
    expect(discovery['creating']()).toBe(true);
    response.next(createdPack);
    await saving;
    expect(changed).toHaveBeenCalledExactlyOnceWith(createdPack);
    expect(preferences.upsertPackOrderItem).toHaveBeenCalledWith(
      expect.objectContaining({ stickerPackId: createdPack.id }),
    );
    expect(navigate).toHaveBeenCalledExactlyOnceWith(['/settings/stickers', '900']);
    expect(discovery['createOpen']()).toBe(false);
    expect(discovery['creating']()).toBe(false);
    expect(api.getPacks).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed creation open for retry', async () => {
    const { discovery } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    api.postPack.mockReturnValueOnce(throwError(() => new Error('offline')));
    discovery['createPack']();
    await discovery['savePack']({ name: '新包', emoji: '' });
    expect(discovery['createOpen']()).toBe(true);
    expect(discovery['createFailed']()).toBe(true);
    expect(discovery['creating']()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    await discovery['savePack']({ name: '新包', emoji: '' });
    expect(discovery['createFailed']()).toBe(false);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(['/settings/stickers', '900']);
  });

  it('discards a creation response after switching accounts', async () => {
    const { discovery } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const changed = vi.spyOn(TestBed.inject(StickerUpdates).changed, 'next');
    const response = new Subject<typeof createdPack>();
    api.postPack.mockReturnValueOnce(response);
    const saving = discovery['savePack']({ name: '新包', emoji: '' });
    user.set({ uid: 2 });
    response.next(createdPack);
    await saving;
    expect(changed).not.toHaveBeenCalled();
    expect(preferences.upsertPackOrderItem).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('retains rows during searches and ignores older responses', async () => {
    const { fixture, discovery } = await render();
    const row = fixture.nativeElement.querySelector('.pack');
    const older = new Subject<StickerPackDiscoveryResponse>();
    const latest = new Subject<StickerPackDiscoveryResponse>();
    api.getPacks.mockReturnValueOnce(older).mockReturnValueOnce(latest);
    discovery['query'].set('old');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pack')).toBe(row);
    expect(fixture.nativeElement.querySelector('.pack-skeleton')).toBeNull();
    discovery['query'].set('new');
    fixture.detectChanges();
    latest.next({ ...page, packs: [{ ...pack, name: 'New' }] });
    await fixture.whenStable();
    older.next({ ...page, packs: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(discovery['packs']()[0].name).toBe('New');
    expect(fixture.nativeElement.querySelector('.pack')).toBe(row);
  });

  it('retries a failed next page at the same offset without replacing known rows', async () => {
    api.getPacks.mockReturnValueOnce(of({ ...page, hasMore: true }));
    const { fixture, discovery } = await render();
    const row = fixture.nativeElement.querySelector('.pack');
    api.getPacks.mockReturnValueOnce(throwError(() => new Error('offline')));
    await discovery['load'](true);
    fixture.detectChanges();
    expect(discovery['error']()).toBe(true);
    expect(fixture.nativeElement.querySelector('.pack')).toBe(row);
    api.getPacks.mockReturnValueOnce(of({ ...page, packs: [{ ...pack, id: encodeId('104') }] }));
    await discovery['retry']();
    expect(api.getPacks).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
    expect(discovery['packs']().map((pack) => pack.id)).toEqual([pack.id, encodeId('104')]);
    expect(discovery['cursor']()).toBeUndefined();
  });

  it('keeps the paging spinner active without showing a second progress indicator', async () => {
    api.getPacks.mockReturnValueOnce(of({ ...page, hasMore: true }));
    const { fixture, discovery } = await render();
    const response = new Subject<StickerPackDiscoveryResponse>();
    api.getPacks.mockReturnValueOnce(response);
    const request = discovery['load'](true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll').disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('ion-progress-bar')).toBeNull();
    response.next(page);
    await request;
  });

  it('returns new search results to the top, but preserves scroll when paging or retrying the same query', async () => {
    const { fixture, discovery } = await render();
    const scroll = vi.spyOn(discovery['content']()!, 'scrollToTop').mockResolvedValue();
    const response = new Subject<StickerPackDiscoveryResponse>();
    api.getPacks.mockReturnValueOnce(response);
    discovery['query'].set('Tea');
    fixture.detectChanges();
    expect(scroll).not.toHaveBeenCalled();
    response.next({ ...page, hasMore: true });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0);
    scroll.mockClear();
    await discovery['load'](true);
    await fixture.whenStable();
    await discovery['load']();
    await fixture.whenStable();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('offers clearing an empty search and restores the popular list and input together', async () => {
    const { fixture, discovery } = await render();
    api.getPacks.mockReturnValueOnce(of({ ...page, packs: [] }));
    discovery['query'].set('Missing');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const clear = fixture.nativeElement.querySelector('ion-content ion-button') as HTMLElement;
    expect(clear.textContent).toContain('清除搜索');
    clear.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(discovery['query']()).toBe('');
    expect(fixture.nativeElement.querySelector('ion-searchbar').value).toBe('');
    expect(discovery['packs']()).toEqual(page.packs);
  });

  it('adds once, publishes the summary, and preserves added state across a stale search response', async () => {
    const { discovery } = await render();
    const subscribed = vi.fn();
    TestBed.inject(StickerUpdates).subscribed.subscribe(subscribed);
    const search = new Subject<StickerPackDiscoveryResponse>();
    const mutation = new Subject<void>();
    api.getPacks.mockReturnValueOnce(search);
    api.putSubscription.mockReturnValueOnce(mutation);
    const loading = discovery['load']();
    const adding = discovery['add'](pack);
    await discovery['add'](pack);
    expect(discovery['packs']()[0].isSubscribed).toBe(true);
    expect(api.putSubscription).toHaveBeenCalledExactlyOnceWith(pack.id);
    mutation.next(undefined);
    await adding;
    search.next(page);
    await loading;
    expect(discovery['packs']()[0].isSubscribed).toBe(true);
    expect(subscribed).toHaveBeenCalledExactlyOnceWith({ ...pack, isSubscribed: true });
    expect(preferences.upsertPackOrderItem).toHaveBeenCalledWith(expect.objectContaining({ stickerPackId: pack.id }));
  });

  it('rolls back a failed addition and allows retry', async () => {
    const { discovery } = await render();
    api.putSubscription.mockReturnValueOnce(throwError(() => new Error('offline')));
    await discovery['add'](pack);
    expect(discovery['packs']()[0].isSubscribed).toBe(false);
    expect(discovery['adding']().size).toBe(0);
    expect(discovery['addFailed']()).toBe(true);
    expect(preferences.upsertPackOrderItem).not.toHaveBeenCalled();
    await discovery['add'](discovery['packs']()[0]);
    expect(discovery['packs']()[0].isSubscribed).toBe(true);
  });

  it('preserves a pending addition during a new read but accepts later server subscription changes', async () => {
    const { discovery } = await render();
    const mutation = new Subject<void>();
    api.putSubscription.mockReturnValueOnce(mutation);
    const adding = discovery['add'](pack);
    await discovery['load']();
    expect(discovery['packs']()[0].isSubscribed).toBe(true);
    mutation.next(undefined);
    await adding;
    await discovery['load']();
    expect(discovery['packs']()[0].isSubscribed).toBe(false);
  });

  it('does not re-add subscribed packs', async () => {
    api.getPacks.mockReturnValueOnce(of({ ...page, packs: [{ ...pack, isSubscribed: true }] }));
    const { fixture, discovery } = await render();
    expect(fixture.nativeElement.querySelector('.subscribe-button').disabled).toBe(true);
    await discovery['add'](discovery['packs']()[0]);
    expect(api.putSubscription).not.toHaveBeenCalled();
  });

  it('clears account content and discards late reads and additions after an account switch', async () => {
    const { fixture, discovery } = await render();
    const search = new Subject<StickerPackDiscoveryResponse>();
    const mutation = new Subject<void>();
    const subscribed = vi.fn();
    TestBed.inject(StickerUpdates).subscribed.subscribe(subscribed);
    api.getPacks.mockReturnValueOnce(search);
    api.putSubscription.mockReturnValueOnce(mutation);
    const loading = discovery['load']();
    const adding = discovery['add'](pack);
    user.set(undefined);
    fixture.detectChanges();
    search.next(page);
    mutation.next(undefined);
    await Promise.all([loading, adding]);
    expect(discovery['packs']()).toEqual([]);
    expect(discovery['loading']()).toBe(false);
    expect(subscribed).not.toHaveBeenCalled();
    expect(preferences.upsertPackOrderItem).not.toHaveBeenCalled();
  });

  it('still publishes a successful addition after closing the panel in the same account', async () => {
    const { fixture, discovery } = await render();
    const subscribed = vi.fn();
    TestBed.inject(StickerUpdates).subscribed.subscribe(subscribed);
    const mutation = new Subject<void>();
    api.putSubscription.mockReturnValueOnce(mutation);
    const adding = discovery['add'](pack);
    fixture.destroy();
    mutation.next(undefined);
    await adding;
    expect(subscribed).toHaveBeenCalledExactlyOnceWith({ ...pack, isSubscribed: true });
  });
});
