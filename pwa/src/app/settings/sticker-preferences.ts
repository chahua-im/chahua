import { Service, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, filter } from 'rxjs';
import { Connection } from '../api/connection';
import { decodeId, encodeId, type SnowflakeID } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { AccountStorage, AccountStore } from '../storage/account-storage';
import { RpcApi } from '../../generated/rpc-api';
import type { StickerPackOrderItem, UpdateStickerPackOrderItem } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';

const AUTO_SORT_PACKS_KEY = 'autoSortStickerPacks';
const AUTO_SORT_FAVORITES_KEY = 'autoSortFavoriteStickers';
const FAVORITE_ORDER_KEY = 'favoriteStickerOrder';

/** Packs beyond this position in the sorted list are excluded from usage recording. */
export const AUTO_SORT_LIMIT = 20;

export interface FavoriteStickerOrderItem {
  stickerId: SnowflakeID;
  lastUsedOn: number;
}

@Service()
export class StickerPreferences {
  private readonly session = inject(SessionStore);
  private readonly storage = inject(AccountStorage);
  private readonly users = inject(RpcApi);
  readonly autoSortPacksEnabled = computed(() =>
    this.storage.read(AccountStore.Preferences, AUTO_SORT_PACKS_KEY, false),
  );
  readonly autoSortFavoritesEnabled = computed(() =>
    this.storage.read(AccountStore.Preferences, AUTO_SORT_FAVORITES_KEY, false),
  );
  readonly favoriteStickerOrder = computed(() =>
    readFavoriteOrder(this.storage.read(AccountStore.Usage, FAVORITE_ORDER_KEY, [])),
  );
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
    this.storage.set(AccountStore.Preferences, AUTO_SORT_PACKS_KEY, value);
  }

  setAutoSortFavorites(value: boolean) {
    this.storage.set(AccountStore.Preferences, AUTO_SORT_FAVORITES_KEY, value);
  }

  upsertPackOrderItem(item: StickerPackOrderItem) {
    this.session.upsertStickerPackOrderItem(item);
  }

  removePackOrderItem(packId: SnowflakeID) {
    this.session.removeStickerPackOrderItem(packId);
  }

  upsertFavoriteStickerOrderItem(item: FavoriteStickerOrderItem) {
    const normalized = { ...item, lastUsedOn: Math.trunc(item.lastUsedOn) };
    const order = [
      normalized,
      ...this.favoriteStickerOrder().filter((existing) => existing.stickerId !== item.stickerId),
    ];
    this.storage.set(
      AccountStore.Usage,
      FAVORITE_ORDER_KEY,
      order.map(({ stickerId, lastUsedOn }) => ({ stickerId: decodeId(stickerId), lastUsedOn })),
    );
  }

  /** Server owns the pack order; a failed sync is healed by re-reading it. */
  async syncPackOrder(items: UpdateStickerPackOrderItem[]) {
    try {
      await firstValueFrom(this.users.users.updateStickerPackOrder({ order: items }));
      return true;
    } catch {
      try {
        const user = await firstValueFrom(this.users.users.getMe());
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

function readFavoriteOrder(value: unknown): FavoriteStickerOrderItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<SnowflakeID>();
  const items: FavoriteStickerOrderItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry == null) continue;
    const { stickerId, lastUsedOn } = entry as Record<string, unknown>;
    let id: SnowflakeID;
    if (typeof stickerId === 'string' && /^\d+$/.test(stickerId)) {
      try {
        id = encodeId(stickerId);
      } catch {
        continue;
      }
    } else if (typeof stickerId === 'number' && Number.isFinite(stickerId)) {
      id = stickerId as SnowflakeID;
    } else {
      continue;
    }
    if (typeof lastUsedOn !== 'number' || !Number.isFinite(lastUsedOn)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ stickerId: id, lastUsedOn: Math.trunc(lastUsedOn) });
  }
  return items;
}
