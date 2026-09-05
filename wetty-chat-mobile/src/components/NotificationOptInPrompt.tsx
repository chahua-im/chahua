import { useEffect, useRef } from 'react';
import { useIonAlert, useIonToast } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { getPushNotificationErrorMessage, usePushNotifications } from '@/hooks/usePushNotifications';

const OOBE_STORAGE_KEY = 'oobe';

export function NotificationOptInPrompt() {
  const [presentAlert] = useIonAlert();
  const [presentToast] = useIonToast();
  const presented = useRef(false);
  const { isSubscribed, isCheckingSubscription, subscribeToPush } = usePushNotifications();

  useEffect(() => {
    if (presented.current || isCheckingSubscription || isSubscribed || localStorage.getItem(OOBE_STORAGE_KEY)) {
      return;
    }

    presented.current = true;
    const completeOobe = () => localStorage.setItem(OOBE_STORAGE_KEY, '1');

    void presentAlert({
      header: t`Enable message notifications`,
      message: t`You can change this later in Settings.`,
      backdropDismiss: false,
      buttons: [
        { text: t`Not now`, role: 'cancel', handler: completeOobe },
        {
          text: t`Enable`,
          handler: () => {
            completeOobe();
            void subscribeToPush().then((result) => {
              if (!result.ok) {
                presentToast({
                  message: getPushNotificationErrorMessage(result.code),
                  duration: 3000,
                  position: 'bottom',
                });
              }
            });
          },
        },
      ],
    });
  }, [isCheckingSubscription, isSubscribed, presentAlert, presentToast, subscribeToPush]);

  return null;
}
