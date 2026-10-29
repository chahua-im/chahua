import { inject, Service } from '@angular/core';
import { defer, finalize, map, Subject } from 'rxjs';
import { RpcApi } from '../../generated/rpc-api';
import type {
  SnowflakeID,
  StickerPackDetailResponse,
  StickerPackSummary,
  StickerSummary,
} from '../../generated/models';

/** Local creations update already mounted pack views without refetching them. */
@Service()
export class StickerUpdates {
  private readonly api = inject(RpcApi);
  readonly added = new Subject<{ pack: StickerPackSummary; sticker: StickerSummary }>();

  getPack(id: SnowflakeID) {
    return defer(() => {
      const additions: StickerSummary[] = [];
      const subscription = this.added.subscribe(({ pack, sticker }) => {
        if (pack.id === id) additions.push(sticker);
      });
      return this.api.stickers.getPack({ packId: id }).pipe(
        map((pack) => additions.reduce(appendSticker, pack)),
        finalize(() => subscription.unsubscribe()),
      );
    });
  }
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
