import { expectTypeOf } from 'vitest';
import { decodeId, encodeId, type SnowflakeID } from './snowflake-id';
import { mergeMessages } from '../messages/message-merge';
import { testMessage } from './testing';

describe('Snowflake IDs', () => {
  it('requires encoded IDs instead of arbitrary numbers', () => {
    expectTypeOf(encodeId('1')).toEqualTypeOf<SnowflakeID>();
    expectTypeOf<number>().not.toExtend<SnowflakeID>();
    expectTypeOf<string>().not.toExtend<SnowflakeID>();
    expectTypeOf(testMessage.id).toEqualTypeOf<SnowflakeID>();
  });

  it('orders adjacent IDs beyond Number precision and across the complete positive i64 range', () => {
    const max = (1n << 63n) - 1n;
    const ids = new Set([0n, 1n, max - 1n, max]);
    for (let bit = 1n; bit < 63n; bit++) {
      const boundary = 1n << bit;
      ids
        .add(boundary - 1n)
        .add(boundary)
        .add(boundary + 1n);
    }
    let seed = 73n;
    for (let index = 0; index < 1000; index++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & max;
      ids.add(seed);
      if (seed < max) ids.add(seed + 1n);
    }
    const values = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const keys = values.map((id) => encodeId(String(id)));
    expect(keys.every(Number.isFinite)).toBe(true);
    expect(keys.every(Boolean)).toBe(true);
    expect(keys.map(decodeId)).toEqual(values.map(String));
    expect(new Set(keys).size).toBe(values.length);
    expect(keys.every((key, index) => index === 0 || key > keys[index - 1])).toBe(true);
    expect([...keys].reverse().sort((a, b) => a - b)).toEqual(keys);
  });

  it('merges numeric IDs without replacing an existing message with its echo', () => {
    const existing = { ...testMessage, id: encodeId('9007199254740993'), message: 'already loaded' };
    const newer = { ...testMessage, id: encodeId('4611686018427387904') };
    const older = { ...testMessage, id: encodeId('9007199254740992') };
    const latest = { ...testMessage, id: encodeId('9223372036854775807') };
    const result = mergeMessages([newer, existing], [latest, older, { ...existing, message: 'echo' }]);
    expect(result).toEqual([older, existing, newer, latest]);
    expect(result[1]).toBe(existing);
  });
});
