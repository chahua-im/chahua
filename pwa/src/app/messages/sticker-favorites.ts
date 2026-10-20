import { Service, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { StickersService } from '../../generated/endpoints/stickers/stickers.service';
import type { SnowflakeID } from '../api/snowflake-id';

/**
 * Favorite stickers are user state carried in three places: message payloads, pin snapshots and the
 * sticker picker. The menu owns the toggle, so it reads and writes this shared set instead of the copy
 * inside one message snapshot.
 */
@Service()
export class StickerFavorites {
  private readonly stickers = inject(StickersService);
  private readonly ids = signal<ReadonlySet<SnowflakeID> | undefined>(undefined);
  private pending?: Promise<void>;

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

  async set(stickerId: SnowflakeID, favorited: boolean) {
    const previous = this.isFavorite(stickerId);
    this.write(stickerId, favorited);
    try {
      await firstValueFrom(favorited ? this.stickers.putFavorite(stickerId) : this.stickers.deleteFavorite(stickerId));
    } catch (error) {
      this.write(stickerId, previous);
      throw error;
    }
  }

  private async load() {
    try {
      const list = await firstValueFrom(this.stickers.getMyFavorites());
      this.ids.set(new Set(list.stickers.map((sticker) => sticker.id)));
    } catch {
      // Favorites are cosmetic; an unreadable list leaves every sticker unfavorited but usable.
      this.ids.set(new Set());
    } finally {
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
