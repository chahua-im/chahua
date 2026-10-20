import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import type { StickerSummary } from '../../generated/models';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { StickerFavorites } from './sticker-favorites';

const sticker = { id: encodeId('9007199254742001') } as StickerSummary;

describe('StickerFavorites', () => {
  let favorites: StickerFavorites;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
      ],
    });
    favorites = TestBed.inject(StickerFavorites);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function load() {
    const loading = favorites.ensure();
    http.expectOne('/_api/stickers/mine/favorites').flush({ stickers: [sticker] });
    await loading;
  }

  it('reads the favorite library once', async () => {
    expect(favorites.loading()).toBe(true);
    await load();
    expect(favorites.loading()).toBe(false);
    expect(favorites.isFavorite(sticker.id)).toBe(true);
    await favorites.ensure();
    http.expectNone('/_api/stickers/mine/favorites');
  });

  it('applies a toggle before the request and reverts it when the request fails', async () => {
    await load();
    const removing = favorites.set(sticker.id, false);
    expect(favorites.isFavorite(sticker.id)).toBe(false);
    const failure = expect(removing).rejects.toBeDefined();
    http
      .expectOne(`/_api/stickers/${decodeId(sticker.id)}/favorite`)
      .flush('', { status: 500, statusText: 'Server Error' });
    await failure;
    expect(favorites.isFavorite(sticker.id)).toBe(true);
  });

  it('favorites a sticker optimistically', async () => {
    await load();
    const adding = favorites.set(encodeId('9007199254742002'), true);
    expect(favorites.isFavorite(encodeId('9007199254742002'))).toBe(true);
    http.expectOne('/_api/stickers/9007199254742002/favorite').flush(null);
    await adding;
  });
});
