/**
 * Development user ID used by the gated PWA development-session flow.
 */

const STORAGE_KEY = 'uid';
const DEFAULT_USER_ID = 1;
const MAX_USER_ID = 2_147_483_647;

export function normalizeCurrentUserId(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const uid = Number(raw);
  return Number.isInteger(uid) && uid >= DEFAULT_USER_ID && uid <= MAX_USER_ID ? uid : null;
}

export function getCurrentUserId(): number {
  if (typeof window === 'undefined') return DEFAULT_USER_ID;
  try {
    const uid = normalizeCurrentUserId(sessionStorage.getItem(STORAGE_KEY));
    if (uid !== null) return uid;
    sessionStorage.setItem(STORAGE_KEY, String(DEFAULT_USER_ID));
  } catch {
    // Storage may be unavailable; the established default remains safe.
  }
  return DEFAULT_USER_ID;
}

export function setCurrentUserId(uid: number): void {
  const normalized = normalizeCurrentUserId(uid);
  if (normalized === null) {
    throw new RangeError('User ID must be a positive i32');
  }
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(STORAGE_KEY, String(normalized));
}
