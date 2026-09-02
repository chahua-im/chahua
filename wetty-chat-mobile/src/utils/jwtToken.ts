import Cookies from 'js-cookie';
import { fromBase64Url } from './base64url';
import { syncClientIdFromJwt } from './clientId';
import { kvDelete, kvGet, kvSet } from './db';

const JWT_TOKEN_COOKIE_KEY = 'jwt_token';
const JWT_TOKEN_QUERY_PARAM = 'token';
const JWT_TOKEN_COOKIE_OPTIONS = { path: '/', expires: 365 };
const JWT_TOKEN_CACHE_NAME = 'jwt_token';
const JWT_TOKEN_CACHE_KEY = 'jwt_token';

let cachedJwtToken: string | null = null;

function normalizeToken(value: string | null | undefined): string | null {
  const token = value?.trim();
  return token ? token : null;
}

export function getJwtTokenFromQuery(search: string): string | null {
  const searchParams = new URLSearchParams(search);
  return normalizeToken(searchParams.get(JWT_TOKEN_QUERY_PARAM));
}

/** Decode the `uid` claim without verification, to detect a session owner change. */
export function getJwtUid(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(fromBase64Url(parts[1])) as { uid?: unknown };
    return typeof payload.uid === 'number' && Number.isSafeInteger(payload.uid) ? payload.uid : null;
  } catch {
    return null;
  }
}

export function getJwtTokenFromCookie(): string | null {
  return normalizeToken(Cookies.get(JWT_TOKEN_COOKIE_KEY));
}

export function setJwtTokenCookie(token: string): void {
  Cookies.set(JWT_TOKEN_COOKIE_KEY, token, JWT_TOKEN_COOKIE_OPTIONS);
}

export function getStoredJwtToken(): string {
  return cachedJwtToken ?? getJwtTokenFromCookie() ?? '';
}

async function refreshTokenCache(token: string): Promise<void> {
  try {
    const cache = await caches.open(JWT_TOKEN_CACHE_NAME);
    await cache.put(JWT_TOKEN_CACHE_KEY, new Response(token));
  } catch {
    // Cache Storage is only an iOS 16 compatibility fallback.
  }
}

async function clearTokenCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(JWT_TOKEN_CACHE_NAME);
  await cache.delete(JWT_TOKEN_CACHE_KEY);
}

async function readTokenCache(): Promise<string | null> {
  try {
    const cache = await caches.open(JWT_TOKEN_CACHE_NAME);
    const response = await cache.match(JWT_TOKEN_CACHE_KEY);
    return normalizeToken(response ? await response.text() : null);
  } catch {
    return null;
  }
}

async function adoptToken(token: string, persistIdb: boolean): Promise<string> {
  if (persistIdb) await kvSet('jwt_token', token);
  await syncClientIdFromJwt(token);
  cachedJwtToken = token;
  setJwtTokenCookie(token);
  await refreshTokenCache(token);
  return token;
}

export async function loadStoredJwtToken(): Promise<string> {
  const idbToken = normalizeToken(await kvGet<string>('jwt_token'));
  if (idbToken) return adoptToken(idbToken, false);

  const cookieToken = getJwtTokenFromCookie();
  if (cookieToken) return adoptToken(cookieToken, true);

  const cacheToken = await readTokenCache();
  if (cacheToken) return adoptToken(cacheToken, true);

  return '';
}

export async function commitJwtToken(token: string): Promise<void> {
  const normalized = normalizeToken(token);
  if (!normalized) throw new Error('Cannot commit an empty JWT token');
  await adoptToken(normalized, true);
}

export async function clearJwtToken(): Promise<void> {
  cachedJwtToken = null;
  Cookies.remove(JWT_TOKEN_COOKIE_KEY, { path: '/' });
  // Cache Storage is only an iOS 16 compatibility replica, and it is read only when
  // IndexedDB and the cookie are both empty. Failing to clear it must not abort
  // sign-out, or an unreliable `caches` implementation would trap the user on the
  // failure screen with no way to reach a signed-out state.
  try {
    await clearTokenCache();
  } catch {
    // best-effort
  }
  await kvDelete('jwt_token');
}

export function captureJwtTokenFromUrl(url: URL): string | null {
  const token = normalizeToken(url.searchParams.get(JWT_TOKEN_QUERY_PARAM));
  if (!token) return null;
  url.searchParams.delete(JWT_TOKEN_QUERY_PARAM);
  window.history.replaceState(window.history.state, '', url);
  return token;
}
