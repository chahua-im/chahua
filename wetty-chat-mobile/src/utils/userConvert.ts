import type { MemberSummary } from '@/api/users';
import type { User } from '@/api/messages';

/**
 * Adapt a social `MemberSummary` (username-based) to the message-layer `User`
 * (name-based) so the shared UserProfileModal can render friend/block/DM actions
 * for contacts and search results uniformly.
 */
export function memberSummaryToUser(member: MemberSummary): User {
  return {
    uid: member.uid,
    name: member.username,
    avatarUrl: member.avatarUrl ?? null,
    gender: member.gender,
    userGroup: member.userGroup ?? null,
  };
}
