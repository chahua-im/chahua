const PROFILE_UID_QUERY_PARAM = 'uid';

/** Parse `?uid=` into a positive safe integer, or null when absent/malformed. */
export function parseProfileUid(search: string): number | null {
  const raw = new URLSearchParams(search).get(PROFILE_UID_QUERY_PARAM)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;

  const uid = Number(raw);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

let pendingProfileUid: number | null = null;

export function requestProfileDeepLink(uid: number): void {
  pendingProfileUid = uid;
}

export function consumePendingProfileDeepLink(): number | null {
  const uid = pendingProfileUid;
  pendingProfileUid = null;
  return uid;
}
