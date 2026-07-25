import { kvGet, kvSet } from './db';
import { fromBase64Url } from './base64url';

let cachedClientId: string | null = null;

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Decode JWT payload without verification to extract the `cid` claim. */
function extractCidFromJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(fromBase64Url(parts[1]));
    return typeof payload.cid === 'string' && payload.cid.length > 0 ? payload.cid : null;
  } catch {
    return null;
  }
}

/**
 * Sync accessor — returns cached clientId.
 * Only needed for unauthenticated requests (when no JWT is available).
 */
export function getOrCreateClientId(): string {
  if (cachedClientId) return cachedClientId;
  cachedClientId = generateClientId();
  return cachedClientId;
}

/**
 * Sync update — called after JWT is available to align clientId with JWT's `cid` claim.
 */
export async function syncClientIdFromJwt(jwtToken: string): Promise<void> {
  const cid = extractCidFromJwt(jwtToken);
  if (cid) {
    cachedClientId = cid;
    await kvSet('client_id', cid);
  }
}

/**
 * Async init — reads from IDB, falls back to generating a new one.
 * If JWT is available, `syncClientIdFromJwt` should be called after to override with `cid`.
 */
export async function initializeClientId(): Promise<string> {
  const idbValue = await kvGet<string>('client_id');
  if (idbValue && idbValue.length > 0) {
    cachedClientId = idbValue;
    return cachedClientId;
  }

  cachedClientId = generateClientId();
  await kvSet('client_id', cachedClientId);
  return cachedClientId;
}
