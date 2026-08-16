import { useState } from 'react';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { AddFriendModal } from '@/components/social/AddFriendModal';
import { memberSummaryToUser } from '@/utils/userConvert';
import type { User } from '@/api/messages';
import type { MemberSummary } from '@/api/users';

interface AddFriendModalHostProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Hosts the add-friend search modal plus the profile modal it hands off to,
 * so header menus only need to flip `open`.
 */
export function AddFriendModalHost({ open, onClose }: AddFriendModalHostProps) {
  const [profileUser, setProfileUser] = useState<User | null>(null);

  return (
    <>
      <AddFriendModal
        isOpen={open}
        onDismiss={onClose}
        onSelect={(member: MemberSummary) => {
          onClose();
          setProfileUser(memberSummaryToUser(member));
        }}
      />
      <UserProfileModal sender={profileUser} onDismiss={() => setProfileUser(null)} />
    </>
  );
}
