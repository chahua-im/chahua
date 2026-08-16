import { useEffect, useRef, useState } from 'react';
import { IonToast } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch } from '@/store';
import { fetchIncomingRequests, selectIncomingRequests, setContactsPanelOpen } from '@/store/socialSlice';
import { appHistory } from '@/utils/navigationHistory';
import { useIsDesktop } from '@/hooks/platformHooks';
import { isFeatureEnabled } from '@/features';

const TOAST_DURATION_MS = 6000;

/**
 * Global friend-request alert. Watches the incoming request list and shows a
 * toast whenever a request that has not been seen before appears - whether it
 * arrived via the friendRequestReceived WS event (which triggers a refetch)
 * or via the always-refetch-on-open contacts page. The "View" action jumps
 * straight to the contacts list (route on mobile, sidebar on desktop).
 */
export function FriendRequestNotifier() {
  const dispatch = useDispatch<AppDispatch>();
  const incoming = useSelector(selectIncomingRequests);
  const isDesktop = useIsDesktop();
  const [toastText, setToastText] = useState<string | null>(null);
  const seenIdsRef = useRef<Set<string> | null>(null);
  const bootFetchSettledRef = useRef(false);

  useEffect(() => {
    // Fetch once at boot so pre-existing pending requests light up the
    // Friends segment badge without waiting for a WS event or a contacts
    // visit. Boot-time requests are badge-only, never toasted.
    if (isFeatureEnabled('friends')) {
      dispatch(fetchIncomingRequests());
    }
  }, [dispatch]);

  useEffect(() => {
    const ids = new Set(incoming.map((r) => r.id));
    const seen = seenIdsRef.current;
    if (seen == null) {
      // First observation (empty list at mount): mark as seen silently.
      seenIdsRef.current = ids;
      return;
    }
    if (!bootFetchSettledRef.current) {
      // Result of the boot fetch (or a list change racing it): swallow so a
      // pre-existing request never toasts on every reload.
      bootFetchSettledRef.current = true;
      seenIdsRef.current = ids;
      return;
    }
    const fresh = incoming.filter((r) => !seen.has(r.id));
    seenIdsRef.current = ids;
    if (fresh.length > 0) {
      const name = fresh[0].from.username || t`User ${fresh[0].from.uid}`;
      setToastText(
        fresh.length > 1
          ? t`Received friend requests from ${name} and others`
          : t`Received a friend request from ${name}`,
      );
    }
  }, [incoming]);

  const openContacts = () => {
    setToastText(null);
    if (isDesktop) {
      dispatch(setContactsPanelOpen(true));
    } else {
      appHistory.push('/contacts');
    }
  };

  if (!isFeatureEnabled('friends')) {
    return null;
  }

  return (
    <IonToast
      isOpen={toastText != null}
      message={toastText ?? undefined}
      position="top"
      duration={TOAST_DURATION_MS}
      buttons={[
        {
          text: t`View`,
          role: 'info',
          handler: openContacts,
        },
        {
          text: t`Dismiss`,
          role: 'cancel',
          handler: () => setToastText(null),
        },
      ]}
      onDidDismiss={() => setToastText(null)}
    />
  );
}
