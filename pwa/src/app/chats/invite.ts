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
  const input = value.trim();
  if (/^[^/?#:\s]+$/.test(input)) return input;
  try {
    const url = new URL(input, location.origin);
    return url.pathname.match(/^\/chats\/join\/([^/]+)\/?$/)?.[1] ?? '';
  } catch {
    return '';
  }
}
