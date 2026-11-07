import type { InviteResponse } from '../../generated/models';
import { RpcError, RpcErrorCode } from '../api/rpc-error';

export enum InvitePreviewIssue {
  Invalid = 'invalid',
  Missing = 'missing',
  Inactive = 'inactive',
  Restricted = 'restricted',
}

export function invitePreviewIssue(error: unknown): InvitePreviewIssue | undefined {
  if (!(error instanceof RpcError)) return undefined;
  switch (error.code) {
    case RpcErrorCode.BadRequest:
      return InvitePreviewIssue.Invalid;
    case RpcErrorCode.NotFound:
      return InvitePreviewIssue.Missing;
    case RpcErrorCode.Gone:
      return InvitePreviewIssue.Inactive;
    case RpcErrorCode.Forbidden:
      return InvitePreviewIssue.Restricted;
    default:
      return undefined;
  }
}

export enum InviteStatus {
  Active,
  Expired,
  Revoked,
  Used,
}
export function inviteExpired(invite: InviteResponse, now = Date.now()) {
  return !!invite.revokedAt || (!!invite.expiresAt && Date.parse(invite.expiresAt) <= now);
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
