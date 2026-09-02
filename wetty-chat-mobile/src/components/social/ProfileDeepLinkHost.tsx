import { IonToast } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { useEffect, useState } from 'react';
import type { User } from '@/api/messages';
import { usersApi } from '@/api/users';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { consumePendingProfileDeepLink } from '@/utils/profileDeepLink';
import { memberSummaryToUser } from '@/utils/userConvert';

export function ProfileDeepLinkHost() {
  const [uid] = useState(() => consumePendingProfileDeepLink());
  const [sender, setSender] = useState<User | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (uid == null) return;

    let cancelled = false;

    usersApi
      .searchMembers({ q: String(uid), limit: 1 })
      .then((response) => {
        if (cancelled) return;

        const member = response.members.find((candidate) => candidate.uid === uid);
        if (member) setSender(memberSummaryToUser(member));
        else setNotFound(true);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });

    return () => {
      cancelled = true;
    };
  }, [uid]);

  return (
    <>
      <UserProfileModal sender={sender} onDismiss={() => setSender(null)} />
      <IonToast
        isOpen={notFound}
        message={t`User not found`}
        duration={3000}
        position="bottom"
        onDidDismiss={() => setNotFound(false)}
      />
    </>
  );
}
