import { Service, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, filter } from 'rxjs';
import { Connection } from '../api/connection';
import type { SnowflakeID } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { UsersService } from '../../generated/endpoints/users/users.service';
import type { StickerPackOrderItem, UpdateStickerPackOrderItem } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';

const AUTO_SORT_PACKS_KEY = 'chahua.preferences.autoSortStickerPacks';
const AUTO_SORT_FAVORITES_KEY = 'chahua.preferences.autoSortFavoriteStickers';
const FAVORITE_ORDER_KEY = 'chahua.preferences.favoriteStickerOrder';

/** Packs beyond this position in the sorted list are excluded from usage recording. */
export const AUTO_SORT_LIMIT = 20;

export interface FavoriteStickerOrderItem {
  stickerId: SnowflakeID;
  lastUsedOn: number;
}

@Service()
export class StickerPreferences {
  private readonly session = inject(SessionStore);
  private readonly users = inject(UsersService);
  private readonly autoSortPacks = signal(window.localStorage.getItem(AUTO_SORT_PACKS_KEY) === 'true');
  private readonly autoSortFavorites = signal(window.localStorage.getItem(AUTO_SORT_FAVORITES_KEY) === 'true');
  private readonly favoriteOrder = signal(readFavoriteOrder());
  readonly autoSortPacksEnabled = this.autoSortPacks.asReadonly();
  readonly autoSortFavoritesEnabled = this.autoSortFavorites.asReadonly();
  readonly favoriteStickerOrder = this.favoriteOrder.asReadonly();
  readonly packOrder = computed(() => this.session.user()?.stickerPackOrder ?? []);

  constructor() {
    inject(Connection)
      .events$.pipe(
        filter((event) => event.type === ServerWsMessageType.stickerPackOrderUpdated),
        takeUntilDestroyed(),
      )
      .subscribe((event) => this.session.replaceStickerPackOrder(event.payload.order));
  }

  setAutoSortPacks(value: boolean) {
    window.localStorage.setItem(AUTO_SORT_PACKS_KEY, String(value));
    this.autoSortPacks.set(value);
  }

  setAutoSortFavorites(value: boolean) {
    window.localStorage.setItem(AUTO_SORT_FAVORITES_KEY, String(value));
    this.autoSortFavorites.set(value);
  }

  upsertPackOrderItem(item: StickerPackOrderItem) {
    this.session.upsertStickerPackOrderItem(item);
  }

  removePackOrderItem(packId: SnowflakeID) {
    this.session.removeStickerPackOrderItem(packId);
  }

  upsertFavoriteStickerOrderItem(item: FavoriteStickerOrderItem) {
    const normalized = { ...item, lastUsedOn: Math.trunc(item.lastUsedOn) };
    this.favoriteOrder.update((current) => [
      normalized,
      ...current.filter((existing) => existing.stickerId !== item.stickerId),
    ]);
    window.localStorage.setItem(FAVORITE_ORDER_KEY, JSON.stringify(this.favoriteOrder()));
  }

  /** Server owns the pack order; a failed sync is healed by re-reading it. */
  async syncPackOrder(items: UpdateStickerPackOrderItem[]) {
    try {
      await firstValueFrom(this.users.putStickerpackOrder({ order: items }));
      return true;
    } catch {
      try {
        const user = await firstValueFrom(this.users.getMe());
        this.session.replaceStickerPackOrder(user.stickerPackOrder);
      } catch {
        // Keep the local order when offline; the caller can offer to retry the write.
      }
      return false;
    }
  }
}

export function sortStickerPacksByPreference<T extends { id: SnowflakeID }>(
  packs: readonly T[],
  order: readonly StickerPackOrderItem[],
): T[] {
  return sortByKeyedOrder(packs, order, 'stickerPackId');
}

export function sortFavoriteStickersByPreference<T extends { id: SnowflakeID }>(
  stickers: readonly T[],
  order: readonly FavoriteStickerOrderItem[],
): T[] {
  return sortByKeyedOrder(stickers, order, 'stickerId');
}

function sortByKeyedOrder<T extends { id: SnowflakeID }, O extends { lastUsedOn: number }>(
  items: readonly T[],
  order: readonly O[],
  key: keyof O & string,
): T[] {
  const originalIndex = new Map(items.map((item, index) => [item.id, index]));
  const lastUsedById = new Map(order.map((item) => [item[key] as SnowflakeID, item.lastUsedOn]));
  return [...items].sort((a, b) => {
    const aTime = lastUsedById.get(a.id);
    const bTime = lastUsedById.get(b.id);
    if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
    if (aTime != null) return -1;
    if (bTime != null) return 1;
    return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0);
  });
}

function readFavoriteOrder(): FavoriteStickerOrderItem[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(FAVORITE_ORDER_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    const seen = new Set<SnowflakeID>();
    const items: FavoriteStickerOrderItem[] = [];
    for (const entry of value) {
      if (typeof entry !== 'object' || entry == null) continue;
      const { stickerId, lastUsedOn } = entry as Record<string, unknown>;
      if (typeof stickerId !== 'number' || !Number.isFinite(stickerId)) continue;
      if (typeof lastUsedOn !== 'number' || !Number.isFinite(lastUsedOn)) continue;
      if (seen.has(stickerId as SnowflakeID)) continue;
      seen.add(stickerId as SnowflakeID);
      items.push({ stickerId: stickerId as SnowflakeID, lastUsedOn: Math.trunc(lastUsedOn) });
    }
    return items;
  } catch {
    return [];
  }
}
