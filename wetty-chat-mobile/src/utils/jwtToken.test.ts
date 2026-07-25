import { beforeEach, describe, expect, it, vi } from 'vitest';

const { kvGet, kvSet, kvDelete, syncClientIdFromJwt, cookies } = vi.hoisted(() => ({
  kvGet: vi.fn(),
  kvSet: vi.fn(() => Promise.resolve()),
  kvDelete: vi.fn(() => Promise.resolve()),
  syncClientIdFromJwt: vi.fn(() => Promise.resolve()),
  cookies: {} as Record<string, string>,
}));

vi.mock('@/utils/db', () => ({ kvGet, kvSet, kvDelete }));
vi.mock('./clientId', () => ({ syncClientIdFromJwt }));
vi.mock('js-cookie', () => ({
  default: {
    get: (key: string) => cookies[key],
    set: (key: string, value: string) => {
      cookies[key] = value;
    },
    remove: (key: string) => {
      delete cookies[key];
    },
  },
}));
import { captureJwtTokenFromUrl, clearJwtToken, commitJwtToken, loadStoredJwtToken } from './jwtToken';

describe('JWT storage ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(cookies)) delete cookies[key];
    vi.stubGlobal('window', {
      history: { state: null, replaceState: vi.fn() },
    });
    const cache = {
      put: vi.fn(),
      delete: vi.fn(() => Promise.resolve(true)),
      match: vi.fn(() => Promise.resolve(undefined)),
    };
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) });
  });

  it('prefers IDB and reconciles stale cookie and cache replicas', async () => {
    const cachePut = vi.fn();
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({
        put: cachePut,
        delete: vi.fn(() => Promise.resolve(true)),
        match: vi.fn(() => Promise.resolve(new Response('stale-cache'))),
      }),
    });
    kvGet.mockResolvedValueOnce('idb-token');
    cookies.jwt_token = 'stale-cookie';
    await expect(loadStoredJwtToken()).resolves.toBe('idb-token');
    expect(cookies.jwt_token).toBe('idb-token');
    expect(cachePut).toHaveBeenCalledWith('jwt_token', expect.any(Response));
    expect(syncClientIdFromJwt).toHaveBeenCalledWith('idb-token');
  });

  it('imports a cache token when IDB and cookie are empty', async () => {
    const cacheToken = 'cache-token';
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({
        put: vi.fn(),
        delete: vi.fn(() => Promise.resolve(true)),
        match: vi.fn(() => Promise.resolve(new Response(cacheToken))),
      }),
    });
    kvGet.mockResolvedValueOnce(undefined);
    await expect(loadStoredJwtToken()).resolves.toBe(cacheToken);
    expect(kvSet).toHaveBeenCalledWith('jwt_token', cacheToken);
  });

  it('commits IDB before client identity and publication', async () => {
    const events: string[] = [];
    kvSet.mockImplementationOnce(async () => {
      events.push('idb');
    });
    syncClientIdFromJwt.mockImplementationOnce(async () => {
      events.push('cid');
    });
    await commitJwtToken('new-token');
    expect(events).toEqual(['idb', 'cid']);
    expect(cookies.jwt_token).toBe('new-token');
  });

  it('clears every token replica before deleting IDB', async () => {
    const events: string[] = [];
    const cacheDelete = vi.fn(async () => {
      events.push('cache');
      return true;
    });
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({
        put: vi.fn(),
        delete: cacheDelete,
        match: vi.fn(() => Promise.resolve(undefined)),
      }),
    });
    kvDelete.mockImplementationOnce(async () => {
      events.push('idb');
    });
    cookies.jwt_token = 'token';
    await clearJwtToken();
    expect(events).toEqual(['cache', 'idb']);
    expect(cacheDelete).toHaveBeenCalledWith('jwt_token');
    expect(cookies.jwt_token).toBeUndefined();
  });

  it('deletes IDB even when Cache Storage clearing fails', async () => {
    vi.stubGlobal('caches', {
      open: vi.fn().mockRejectedValue(new Error('cache unavailable')),
    });
    await expect(clearJwtToken()).rejects.toThrow('cache unavailable');
    expect(kvDelete).toHaveBeenCalledWith('jwt_token');
  });

  it('captures only token from a URL and preserves the rest', () => {
    const url = new URL('https://example.test/landing?token=raw&invite=code&x=1#hash');
    expect(captureJwtTokenFromUrl(url)).toBe('raw');
    expect(url.searchParams.get('token')).toBeNull();
    expect(url.searchParams.get('invite')).toBe('code');
    expect(url.hash).toBe('#hash');
    expect(window.history.replaceState).toHaveBeenCalled();
  });

  it('rejects empty commits', async () => {
    await expect(commitJwtToken('  ')).rejects.toThrow('empty JWT');
  });
});
