declare const snowflakeId: unique symbol;
export type SnowflakeID = number & { readonly [snowflakeId]: true };

const HALF = 1n << 62n;
const BASE = 1n << 52n;
const NEGATIVE_END = (1n << 63n) + BASE + HALF - 1n;
const POSITIVE_OFFSET = HALF - BASE;
const view = new DataView(new ArrayBuffer(8));

/** Losslessly maps non-negative i64 IDs to finite, nonzero numbers in the same order. */
export function encodeId(id: string): SnowflakeID {
  const value = BigInt(id);
  view.setBigUint64(0, value < HALF ? NEGATIVE_END - value : value - POSITIVE_OFFSET);
  return view.getFloat64(0) as SnowflakeID;
}

/** Restore the exact decimal ID at URL and server request boundaries. */
export function decodeId(id: SnowflakeID): string {
  view.setFloat64(0, id);
  const bits = view.getBigUint64(0);
  return String(id < 0 ? NEGATIVE_END - bits : bits + POSITIVE_OFFSET);
}
