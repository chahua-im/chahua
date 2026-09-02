import { afterEach, describe, expect, it } from 'vitest';
import { consumePendingProfileDeepLink, parseProfileUid, requestProfileDeepLink } from './profileDeepLink';

afterEach(() => {
  consumePendingProfileDeepLink();
});

describe('profile deep links', () => {
  it('parses a positive decimal uid while ignoring other query parameters', () => {
    expect(parseProfileUid('?uid=42&token=x')).toBe(42);
  });

  it.each(['?uid=0', '?uid=-1', '?uid=1.5', '?uid=abc', ''])('rejects invalid uid %s', (search) => {
    expect(parseProfileUid(search)).toBeNull();
  });

  it('consumes a requested uid exactly once', () => {
    requestProfileDeepLink(7);

    expect(consumePendingProfileDeepLink()).toBe(7);
    expect(consumePendingProfileDeepLink()).toBeNull();
  });
});
