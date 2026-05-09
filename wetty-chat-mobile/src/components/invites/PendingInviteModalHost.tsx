import { useEffect, useState } from 'react';
import { isFeatureEnabled } from '@/features';
import { loadPendingInviteFromStorage } from '@/utils/pendingInvite';
import { PendingInviteModal } from './PendingInviteModal';

const PENDING_INVITE_PWA_MODAL_ENABLED = isFeatureEnabled('pendingInvitePwaModal');

export function PendingInviteModalHost() {
  const [inviteCode, setInviteCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!PENDING_INVITE_PWA_MODAL_ENABLED) {
      return;
    }

    loadPendingInviteFromStorage()
      .then((storedInviteCode) => {
        if (!cancelled) {
          setInviteCode(storedInviteCode);
        }
      })
      .catch((error: unknown) => {
        console.warn('Failed loading pending invite', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return <PendingInviteModal inviteCode={inviteCode} onCleared={() => setInviteCode(null)} openChatOnResolved />;
}
