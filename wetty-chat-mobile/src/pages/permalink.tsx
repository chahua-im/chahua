import { IonContent, IonPage, useIonToast } from '@ionic/react';
import { useEffect, useMemo } from 'react';
import { t } from '@lingui/core/macro';
import { decodePermalink } from '@/utils/permalinkUrl';
import { navigateToNotificationTarget } from '@/utils/notificationTargetNavigator';
import { openPermalinkTarget } from '@/utils/openPermalinkTarget';

interface PermalinkPageProps {
  encoded: string;
}

export default function PermalinkPage({ encoded }: PermalinkPageProps) {
  const [presentToast] = useIonToast();

  const decoded = useMemo(() => {
    try {
      console.debug('[PermalinkPage] attempting decode', { encoded });
      return decodePermalink(encoded);
    } catch (error) {
      console.debug('[PermalinkPage] decode failed', { encoded, error });
      return null;
    }
  }, [encoded]);

  useEffect(() => {
    console.debug('[PermalinkPage] resolved decoded payload', { encoded, decoded });

    if (!decoded) {
      presentToast({ message: t`Invalid link`, duration: 2000, color: 'danger' });
      navigateToNotificationTarget('/chats');
      return;
    }

    const { chatId, messageId } = decoded;

    openPermalinkTarget({ chatId, messageId })
      .then(() => {
        console.debug('[PermalinkPage] permalink target opened', { encoded, chatId, messageId });
      })
      .catch((err) => {
        console.debug('[PermalinkPage] failed to fetch permalink target', {
          encoded,
          chatId,
          messageId,
          status: err?.response?.status,
          err,
        });
        const status = err?.response?.status;
        // 401 is handled by the axios interceptor (auth redirect)
        if (status !== 401) {
          const message =
            status === 404
              ? t`Message not found`
              : status === 403
                ? t`You haven't joined this group`
                : t`Failed to open link`;
          presentToast({ message, duration: 2000, color: 'danger' });
          navigateToNotificationTarget('/chats');
        }
      });
  }, [decoded, encoded, presentToast]);

  return (
    <IonPage>
      <IonContent fullscreen={true} />
    </IonPage>
  );
}
