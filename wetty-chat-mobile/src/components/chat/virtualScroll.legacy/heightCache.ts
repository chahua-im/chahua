/**
 * Persistent height cache keyed by stable row keys.
 * Never pruned — survives core pruning, window switches, and re-expansion.
 */
export class HeightCache {
  private cache = new Map<string, number>();

  get(key: string): number | undefined {
    return this.cache.get(key);
  }

  set(key: string, height: number): void {
    this.cache.set(key, height);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** Sum measured heights for a contiguous range of keys. Returns 0 for any missing key. */
  sumKeys(keys: string[]): number {
    let total = 0;
    for (const key of keys) {
      total += this.cache.get(key) ?? 0;
    }
    return total;
  }

  /** Check if ALL keys in the list have cached heights. */
  hasAll(keys: string[]): boolean {
    for (const key of keys) {
      if (!this.cache.has(key)) return false;
    }
    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
