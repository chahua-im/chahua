import { IonContent, IonPage } from '@ionic/react';
import { useEffect } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { parseProfileUid, requestProfileDeepLink } from '@/utils/profileDeepLink';

export const PROFILE_DEEP_LINK_RETURN_PATH = '/chats';

export default function ProfileDeepLinkPage() {
  const location = useLocation();
  const history = useHistory();

  useEffect(() => {
    const uid = parseProfileUid(location.search);
    if (uid != null) requestProfileDeepLink(uid);
    else console.warn('[app] profile deep link missing a valid uid', location.search);
    history.replace(PROFILE_DEEP_LINK_RETURN_PATH);
  }, [history, location.search]);

  return (
    <IonPage>
      <IonContent fullscreen={true} />
    </IonPage>
  );
}
