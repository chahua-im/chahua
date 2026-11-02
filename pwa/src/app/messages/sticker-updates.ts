import { inject, Service } from '@angular/core';
import { defer, finalize, map, Subject } from 'rxjs';
import { RpcApi } from '../../generated/rpc-api';
import type {
  SnowflakeID,
  StickerPackDetailResponse,
  StickerPackSummary,
  StickerSummary,
} from '../../generated/models';

/** Confirmed local changes update already mounted sticker views. */
@Service()
export class StickerUpdates {
  private readonly api = inject(RpcApi);
  readonly favoriteChanged = new Subject<StickerSummary>();
  readonly added = new Subject<{ pack: StickerPackSummary; sticker: StickerSummary }>();
  /** A confirmed creation or edit supplies the current pack without another read. */
  readonly changed = new Subject<StickerPackDetailResponse>();
  /** Discovery already has a summary; load members only when the library needs them. */
  readonly subscribed = new Subject<StickerPackSummary>();
  /** Remove membership from the current pack, without replacing newer content or favorites. */
  readonly stickerRemoved = new Subject<{ pack: StickerPackDetailResponse; stickerId: SnowflakeID }>();
  /** A deleted or unsubscribed pack must leave open libraries, including pending reads. */
  readonly removed = new Subject<{ id: SnowflakeID; deleted: boolean }>();

  getPack(id: SnowflakeID) {
    return defer(() => {
      let changed: StickerPackDetailResponse | undefined;
      const additions: StickerSummary[] = [];
      const removals = new Set<SnowflakeID>();
      const subscription = this.added.subscribe(({ pack, sticker }) => {
        if (pack.id === id) additions.push(sticker);
      });
      subscription.add(
        this.changed.subscribe((pack) => {
          if (pack.id !== id) return;
          changed = pack;
          additions.length = 0;
        }),
      );
      subscription.add(
        this.stickerRemoved.subscribe((event) => {
          if (event.pack.id === id) removals.add(event.stickerId);
        }),
      );
      return this.api.stickers.getPack({ packId: id }).pipe(
        map((pack) => [...removals].reduce(removePackSticker, additions.reduce(appendSticker, changed ?? pack))),
        finalize(() => subscription.unsubscribe()),
      );
    });
  }
}

export function removePackSticker(pack: StickerPackDetailResponse, stickerId: SnowflakeID): StickerPackDetailResponse {
  const stickers = pack.stickers.filter((sticker) => sticker.id !== stickerId);
  if (stickers.length === pack.stickers.length) return pack;
  return {
    ...pack,
    stickers,
    stickerCount: stickers.length,
    previewSticker: pack.previewSticker?.id === stickerId ? stickers[0] : pack.previewSticker,
  };
}

export function appendSticker(pack: StickerPackDetailResponse, sticker: StickerSummary): StickerPackDetailResponse {
  if (pack.stickers.some((item) => item.id === sticker.id)) return pack;
  return {
    ...pack,
    stickerCount: pack.stickerCount + 1,
    previewSticker: pack.previewSticker ?? sticker,
    stickers: [...pack.stickers, sticker],
  };
}
