import { TestBed } from '@angular/core/testing';
import type { StickerSummary } from '../../generated/models';
import { RpcErrorCode } from '../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../api/rpc-testing';
import { decodeId, encodeId } from '../api/snowflake-id';
import { StickerFavorites } from './sticker-favorites';
import { StickerUpdates } from './sticker-updates';

const sticker = { id: encodeId('9007199254742001') } as StickerSummary;

describe('StickerFavorites', () => {
  let favorites: StickerFavorites;
  let peer: RpcTestPeer;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...provideRpcTesting()] });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    favorites = TestBed.inject(StickerFavorites);
  });

  afterEach(() => peer.verify());

  async function load() {
    const loading = favorites.ensure();
    peer.expect('stickers.listFavorites').flush({ stickers: [{ id: decodeId(sticker.id) }] });
    await loading;
  }

  it('reads the favorite library once', async () => {
    expect(favorites.loading()).toBe(true);
    await load();
    expect(favorites.loading()).toBe(false);
    expect(favorites.isFavorite(sticker.id)).toBe(true);
    await favorites.ensure();
    peer.expectNone('stickers.listFavorites');
  });

  it('applies a toggle before the request and reverts it when the request fails', async () => {
    await load();
    const removing = favorites.set(sticker, false);
    expect(favorites.isFavorite(sticker.id)).toBe(false);
    peer.expect('stickers.unfavorite', { stickerId: decodeId(sticker.id) }).error(RpcErrorCode.Internal);
    await expect(removing).rejects.toBeDefined();
    expect(favorites.isFavorite(sticker.id)).toBe(true);
  });

  it('favorites a sticker optimistically', async () => {
    await load();
    const id = encodeId('9007199254742002');
    const adding = favorites.set({ ...sticker, id }, true);
    expect(favorites.isFavorite(id)).toBe(true);
    peer.expect('stickers.favorite', { stickerId: decodeId(id) }).flush(null);
    await adding;
  });

  it.each([true, false])(
    'preserves confirmed picker favorites across a delayed initial read (%s)',
    async (favorited) => {
      const loading = favorites.ensure();
      const read = peer.expect('stickers.listFavorites');
      TestBed.inject(StickerUpdates).favoriteChanged.next({ ...sticker, isFavorited: favorited });
      expect(favorites.loading()).toBe(true);
      read.flush({ stickers: favorited ? [] : [{ id: decodeId(sticker.id) }] });
      await loading;
      expect(favorites.isFavorite(sticker.id)).toBe(favorited);
    },
  );

  it('retains confirmed favorites if the initial read fails', async () => {
    const loading = favorites.ensure();
    TestBed.inject(StickerUpdates).favoriteChanged.next({ ...sticker, isFavorited: true });
    peer.expect('stickers.listFavorites').error(RpcErrorCode.Internal);
    await loading;
    expect(favorites.isFavorite(sticker.id)).toBe(true);
  });
});
