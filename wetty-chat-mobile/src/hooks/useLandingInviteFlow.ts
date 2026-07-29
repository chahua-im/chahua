import { useEffect, useState } from 'react';
import { isFeatureEnabled } from '@/features';
import { getJwtTokenFromQuery } from '@/utils/jwtToken';
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

    const pendingInviteCode = PENDING_INVITE_PWA_MODAL_ENABLED
      ? syncPendingInviteFromLanding(search)
      : parsePendingInviteFromLanding(search);

    // A mounted app reaching /landing?token=... cannot adopt the credential itself:
    // capture, refresh, and commit belong to the pre-render coordinator. Hand it back
    // by navigating the document with the token intact; bootstrap strips it, so the
    // reloaded app takes the ordinary path instead of navigating again.
    //
    // Read the live URL rather than the router's `search`: bootstrap strips the token
    // with history.replaceState, which the router snapshot does not observe, and a
    // stale token there would trigger a pointless second navigation.
    const queryToken = getJwtTokenFromQuery(window.location.search);

    if (isPwa) {
      const entryUrl = new URL(appEntryUrl, window.location.href);
      if (queryToken) entryUrl.searchParams.set('token', queryToken);
      window.location.replace(entryUrl.toString());
    } else if (queryToken) {
      window.location.reload();
    } else {
      queueMicrotask(() => {
        if (!cancelled) {
          setLandingInviteCode(LANDING_INVITE_MODAL_ENABLED ? pendingInviteCode : null);
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [appEntryUrl, isPwa, search]);

  return {
    landingInviteCode,
    clearLandingInvite: () => setLandingInviteCode(null),
  };
}
