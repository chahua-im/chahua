import { clearPendingInviteCode } from '@/utils/pendingInvite';
import { InviteMessageModal } from './InviteMessageModal';

interface PendingInviteModalProps {
  inviteCode: string | null;
  onCleared: () => void;
  openChatOnResolved?: boolean;
}

export function PendingInviteModal({ inviteCode, onCleared, openChatOnResolved = false }: PendingInviteModalProps) {
  const clearInvite = () => {
    onCleared();
    void clearPendingInviteCode();
  };

  return (
    <InviteMessageModal
      inviteCode={inviteCode}
      onDismiss={clearInvite}
      onResolved={openChatOnResolved ? undefined : clearInvite}
      showAlreadyMemberOpenChatAction={false}
    />
  );
}
