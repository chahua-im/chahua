import { describe, expect, it } from 'vitest';
import { buildSearchMessagesParams } from './messages';

describe('message search API helpers', () => {
  it('builds compact search query params', () => {
    expect(buildSearchMessagesParams({ q: ' 你好 ', limit: 20, offset: 40 })).toEqual({
      q: '你好',
      limit: 20,
      offset: 40,
    });
  });

  it('omits optional pagination params when unset', () => {
    expect(buildSearchMessagesParams({ q: 'hello' })).toEqual({ q: 'hello' });
  });
});
