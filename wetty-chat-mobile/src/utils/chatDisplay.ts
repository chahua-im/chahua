import { t } from '@lingui/core/macro';
import type { GroupVisibility } from '@/api/group';
import type { MemberSummary } from '@/api/users';

export function getChatDisplayName(chatId: string | number, name?: string | null, peer?: MemberSummary | null): string {
  // DM chats are named after the peer rather than the (null) group name.
  if (peer?.username) {
    return peer.username;
  }

  const trimmedName = name?.trim();
  if (trimmedName) {
    return trimmedName;
  }

  if (peer) {
    return t`User ${peer.uid}`;
  }

  return t`Chat ${chatId}`;
}

export function getGroupVisibilityLabel(visibility: GroupVisibility): string {
  switch (visibility) {
    case 'private':
      return t`Private`;
    case 'semi_public':
      return t`Semi-Private`;
    case 'public':
    default:
      return t`Public`;
  }
}
