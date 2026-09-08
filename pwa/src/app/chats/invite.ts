import type { InviteResponse } from '../../generated/models';
export enum InviteStatus {
  Active,
  Expired,
  Revoked,
  Used,
}
export function inviteStatus(invite: InviteResponse, now = Date.now()) {
  if (invite.revokedAt) return InviteStatus.Revoked;
  if (invite.usedAt) return InviteStatus.Used;
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= now) return InviteStatus.Expired;
  return InviteStatus.Active;
}

export function inviteCode(value: string) {
  try {
    const url = new URL(value);
    return url.searchParams.get('invite') || url.pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {
    return value.trim();
  }
}
