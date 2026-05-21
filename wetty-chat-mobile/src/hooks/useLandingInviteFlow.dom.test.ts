import { beforeEach, describe, expect, it, vi } from 'vitest';

const kvSet = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());

vi.mock('@/utils/db', () => ({
  kvSet,
}));

describe('landing auth handoff', () => {
  beforeEach(() => {
    vi.resetModules();
    kvSet.mockClear();
  });

  it('records a JWT token from the landing query string', async () => {
    const { getStoredJwtToken, syncJwtTokenFromLanding } = await import('@/utils/jwtToken');

    const token = syncJwtTokenFromLanding('?token=blah');

    expect(token).toBe('blah');
    expect(getStoredJwtToken()).toBe('blah');
    expect(document.cookie).toContain('jwt_token=blah');
    expect(kvSet).toHaveBeenCalledWith('jwt_token', 'blah');
  });

  it('records the JWT token even when the landing query includes an invite', async () => {
    const { getStoredJwtToken, syncJwtTokenFromLanding } = await import('@/utils/jwtToken');

    const token = syncJwtTokenFromLanding('?token=blah&invite=xxx');

    expect(token).toBe('blah');
    expect(getStoredJwtToken()).toBe('blah');
    expect(document.cookie).toContain('jwt_token=blah');
    expect(kvSet).toHaveBeenCalledWith('jwt_token', 'blah');
  });
});
