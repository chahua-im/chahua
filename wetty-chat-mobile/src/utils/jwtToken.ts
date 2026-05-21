import Cookies from 'js-cookie';
import { kvGet, kvSet } from './db';
import { syncClientIdFromJwt } from './clientId';

const JWT_TOKEN_COOKIE_KEY = 'jwt_token';
const JWT_TOKEN_QUERY_PARAM = 'token';
const JWT_TOKEN_COOKIE_OPTIONS = { path: '/', expires: 365 };

let cachedJwtToken: string | null = null;

function normalizeToken(value: string | null | undefined): string | null {
  const token = value?.trim();
  return token ? token : null;
}

export function getJwtTokenFromQuery(search: string): string | null {
  const searchParams = new URLSearchParams(search);
  return normalizeToken(searchParams.get(JWT_TOKEN_QUERY_PARAM));
}

export function getJwtTokenFromCookie(): string | null {
  return normalizeToken(Cookies.get(JWT_TOKEN_COOKIE_KEY));
}

export function setJwtTokenCookie(token: string): void {
  Cookies.set(JWT_TOKEN_COOKIE_KEY, token, JWT_TOKEN_COOKIE_OPTIONS);
}

/** Sync accessor — only valid after `syncJwtTokenToIdb()` has resolved. */
export function getStoredJwtToken(): string {
  return cachedJwtToken ?? getJwtTokenFromCookie() ?? '';
}

/** Write token to both cookie (transport) and IDB (source of truth). */
export async function persistJwtToken(token: string): Promise<void> {
  cachedJwtToken = token;
  setJwtTokenCookie(token);
  syncClientIdFromJwt(token);
  await kvSet('jwt_token', token);
}

/**
 * Bootstrap sync: IDB is source of truth.
 * If IDB is empty, pick up from cookie (web→PWA transport) and persist to IDB.
 */
export async function syncJwtTokenToIdb(): Promise<string> {
  const idbToken = await kvGet<string>('jwt_token');
  if (idbToken) {
    cachedJwtToken = idbToken;
    syncClientIdFromJwt(idbToken);
    // Also ensure cookie stays in sync (transport for future installs)
    if (!getJwtTokenFromCookie()) {
      setJwtTokenCookie(idbToken);
    }
    return idbToken;
  }

  const cookieToken = getJwtTokenFromCookie();
  if (cookieToken) {
    cachedJwtToken = cookieToken;
    syncClientIdFromJwt(cookieToken);
    await kvSet('jwt_token', cookieToken);
    return cookieToken;
  }

  const cacheToken = await GetTokenCacheStorage();
  if (cacheToken) {
    cachedJwtToken = cacheToken;
    syncClientIdFromJwt(cacheToken);
    setJwtTokenCookie(cacheToken);
    await kvSet('jwt_token', cacheToken);
    return cacheToken;
  }

  return '';
}

export function syncJwtTokenFromLanding(search: string): string {
  const queryToken = getJwtTokenFromQuery(search);
  if (queryToken) {
    cachedJwtToken = queryToken;
    setJwtTokenCookie(queryToken);
    syncClientIdFromJwt(queryToken);
    void kvSet('jwt_token', queryToken);
    void SetTokenCacheStorage(queryToken);
    return queryToken;
  }

  // No query token — just return what we have
  return getStoredJwtToken();
}

// for iOS16 compat
async function SetTokenCacheStorage(token: string): Promise<void> {
  try {
    const cache = await caches.open('jwt_token');
    await cache.put('jwt_token', new Response(token));
  } catch (e) {
    console.error('Error inserting into cache', e);
  }
}
async function GetTokenCacheStorage(): Promise<string | undefined> {
  try {
    const cache = await caches.open('jwt_token');
    const response = await cache.match('jwt_token');
    return response?.text();
  } catch {
    console.warn('Failed fetching JWT from cache');
    return undefined;
  }
}
