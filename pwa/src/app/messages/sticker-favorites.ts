import { Service, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { RpcApi } from '../../generated/rpc-api';
import type { StickerSummary } from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { StickerUpdates } from './sticker-updates';

/**
 * Favorite stickers are user state carried in three places: message payloads, pin snapshots and the
 * sticker picker. The menu uses this set instead of a message snapshot; confirmed changes
 * from every entry point keep it synchronized with mounted sticker views.
 */
@Service()
export class StickerFavorites {
  private readonly api = inject(RpcApi);
  private readonly session = inject(SessionStore);
  private readonly updates = inject(StickerUpdates);
  private readonly ids = signal<ReadonlySet<SnowflakeID> | undefined>(undefined);
  private pending?: Promise<void>;

  constructor() {
    this.updates.favoriteChanged.pipe(takeUntilDestroyed()).subscribe((sticker) => {
      if (this.ids()) this.write(sticker.id, sticker.isFavorited);
    });
  }

  /** Undefined until the list has been read once; the menu keeps the action disabled meanwhile. */
  readonly loading = computed(() => this.ids() === undefined);

  isFavorite(stickerId: SnowflakeID) {
    return this.ids()?.has(stickerId) ?? false;
  }

  ensure(): Promise<void> {
    if (this.ids()) return Promise.resolve();
    this.pending ??= this.load();
    return this.pending;
  }

  async set(sticker: StickerSummary, favorited: boolean) {
    const stickerId = sticker.id;
    const uid = this.session.user()?.uid;
    const previous = this.isFavorite(stickerId);
    this.write(stickerId, favorited);
    try {
      await firstValueFrom(
        favorited ? this.api.stickers.favorite({ stickerId }) : this.api.stickers.unfavorite({ stickerId }),
      );
      if (this.session.user()?.uid === uid) this.updates.favoriteChanged.next({ ...sticker, isFavorited: favorited });
    } catch (error) {
      this.write(stickerId, previous);
      throw error;
    }
  }

  private async load() {
    const changes = new Map<SnowflakeID, boolean>();
    const subscription = this.updates.favoriteChanged.subscribe((sticker) =>
      changes.set(sticker.id, sticker.isFavorited),
    );
    try {
      const list = await firstValueFrom(this.api.stickers.listFavorites());
      const ids = new Set(list.stickers.map((sticker) => sticker.id));
      for (const [id, favorited] of changes) {
        if (favorited) ids.add(id);
        else ids.delete(id);
      }
      this.ids.set(ids);
    } catch {
      // Keep confirmed local changes even when the initial list is unavailable.
      this.ids.set(new Set([...changes].filter(([, favorited]) => favorited).map(([id]) => id)));
    } finally {
      subscription.unsubscribe();
      this.pending = undefined;
    }
  }

  private write(stickerId: SnowflakeID, favorited: boolean) {
    const next = new Set(this.ids() ?? []);
    if (favorited) next.add(stickerId);
    else next.delete(stickerId);
    this.ids.set(next);
  }
}
