import { useEffect, useState } from 'react';
import { isFeatureEnabled } from '@/features';
import { syncJwtTokenFromLanding } from '@/utils/jwtToken';
import { parsePendingInviteFromLanding, syncPendingInviteFromLanding } from '@/utils/pendingInvite';

const LANDING_INVITE_MODAL_ENABLED = isFeatureEnabled('landingInviteModal');
const PENDING_INVITE_PWA_MODAL_ENABLED = isFeatureEnabled('pendingInvitePwaModal');

interface UseLandingInviteFlowParams {
  search: string;
  isPwa: boolean;
  appEntryUrl: string;
}

export function useLandingInviteFlow({ search, isPwa, appEntryUrl }: UseLandingInviteFlowParams) {
  const [landingInviteCode, setLandingInviteCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    syncJwtTokenFromLanding(search);
    const pendingInviteCode = PENDING_INVITE_PWA_MODAL_ENABLED
      ? syncPendingInviteFromLanding(search)
      : parsePendingInviteFromLanding(search);

    if (!isPwa) {
      queueMicrotask(() => {
        if (!cancelled) {
          setLandingInviteCode(LANDING_INVITE_MODAL_ENABLED ? pendingInviteCode : null);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    window.location.replace(appEntryUrl);

    return () => {
      cancelled = true;
    };
  }, [appEntryUrl, isPwa, search]);

  return {
    landingInviteCode,
    clearLandingInvite: () => setLandingInviteCode(null),
  };
}
