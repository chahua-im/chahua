import Cookies from 'js-cookie';
import { kvDelete, kvGet, kvSet } from './db';
import { syncClientIdFromJwt } from './clientId';

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
  let cacheError: unknown;
  try {
    await clearTokenCache();
  } catch (error) {
    cacheError = error;
  }
  await kvDelete('jwt_token');
  if (cacheError) throw cacheError;
}

export function captureJwtTokenFromUrl(url: URL): string | null {
  const token = normalizeToken(url.searchParams.get(JWT_TOKEN_QUERY_PARAM));
  if (!token) return null;
  url.searchParams.delete(JWT_TOKEN_QUERY_PARAM);
  window.history.replaceState(window.history.state, '', url);
  return token;
}
