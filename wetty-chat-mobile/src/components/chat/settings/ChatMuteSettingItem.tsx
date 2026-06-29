import type { ReactNode } from 'react';
import { useIonActionSheet, useIonAlert, useIonToast } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { notifications, notificationsOff } from 'ionicons/icons';
import { useDispatch, useSelector } from 'react-redux';
import { muteChat, unmuteChat } from '@/api/group';
import { setChatArchived, setChatMutedUntil } from '@/store/chatsSlice';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { GroupSettingsActionButton } from './GroupSettingsActionButton';

interface ChatMuteSettingItemProps {
  chatId: string;
  mutedUntil: string | null | undefined;
  archived?: boolean;
}

function isChatMuted(mutedUntil: string | null | undefined): boolean {
  if (!mutedUntil) {
    return false;
  }

  return new Date(mutedUntil) > new Date();
}

function formatMutedUntil(locale: string, mutedUntil: string): string | null {
  const date = new Date(mutedUntil);
  const now = new Date();

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const diffMs = date.getTime() - now.getTime();

  if (diffMs < 24 * 60 * 60 * 1000) {
    return Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  return Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function getMutedUntilLabel(locale: string, mutedUntil: string): ReactNode {
  if (new Date(mutedUntil).getFullYear() >= 9000) {
    return t`indefinitely`;
  }

  const formatted = formatMutedUntil(locale, mutedUntil);

  return (
    <>
      <Trans>until</Trans> <wbr />
      <span style={{ whiteSpace: 'nowrap' }}>{formatted ?? mutedUntil}</span>
    </>
  );
}

export function ChatMuteSettingItem({ chatId, mutedUntil, archived = false }: ChatMuteSettingItemProps) {
  const dispatch = useDispatch();
  const locale = useSelector(selectEffectiveLocale);
  const [presentToast] = useIonToast();
  const [presentActionSheet] = useIonActionSheet();
  const [presentAlert] = useIonAlert();
  const muted = isChatMuted(mutedUntil);

  const handleMute = (durationSeconds: number | null) => {
    const previousMutedUntil = mutedUntil ?? null;
    const optimisticMutedUntil =
      durationSeconds === null
        ? new Date(9999, 11, 31).toISOString()
        : new Date(Date.now() + durationSeconds * 1000).toISOString();
    dispatch(setChatMutedUntil({ chatId, mutedUntil: optimisticMutedUntil }));

    muteChat(chatId, { durationSeconds })
      .then((response) => {
        dispatch(setChatMutedUntil({ chatId, mutedUntil: response.data.mutedUntil }));
        presentToast({ message: t`Notifications muted`, duration: 2000 });
      })
      .catch((error: Error) => {
        dispatch(setChatMutedUntil({ chatId, mutedUntil: previousMutedUntil }));
        presentToast({ message: error.message || t`Failed to mute`, duration: 3000 });
      });
  };

  const handleUnmute = () => {
    const previousMutedUntil = mutedUntil ?? null;

    if (archived) {
      const previousArchived = archived;
      presentAlert({
        header: t`Unarchive chat?`,
        message: t`Unmuting will unarchive this chat. Continue?`,
        buttons: [
          { text: t`Cancel`, role: 'cancel' },
          {
            text: t`Continue`,
            handler: () => {
              dispatch(setChatMutedUntil({ chatId, mutedUntil: null }));
              dispatch(setChatArchived({ chatId, archived: false }));
              void unmuteChat(chatId)
                .then(() => {
                  presentToast({ message: t`Notifications unmuted`, duration: 2000 });
                })
                .catch((error: Error) => {
                  dispatch(setChatMutedUntil({ chatId, mutedUntil: previousMutedUntil }));
                  dispatch(setChatArchived({ chatId, archived: previousArchived }));
                  presentToast({ message: error.message || t`Failed to unmute`, duration: 3000 });
                });
            },
          },
        ],
      });
      return;
    }

    dispatch(setChatMutedUntil({ chatId, mutedUntil: null }));
    unmuteChat(chatId)
      .then(() => {
        presentToast({ message: t`Notifications unmuted`, duration: 2000 });
      })
      .catch((error: Error) => {
        dispatch(setChatMutedUntil({ chatId, mutedUntil: previousMutedUntil }));
        presentToast({ message: error.message || t`Failed to unmute`, duration: 3000 });
      });
  };

  const showMuteActionSheet = () => {
    presentActionSheet({
      header: t`Mute notifications`,
      buttons: [
        { text: t`1 hour`, handler: () => handleMute(3600) },
        { text: t`8 hours`, handler: () => handleMute(28800) },
        { text: t`1 day`, handler: () => handleMute(86400) },
        { text: t`7 days`, handler: () => handleMute(604800) },
        { text: t`Forever`, handler: () => handleMute(null), role: 'destructive' },
        { text: t`Cancel`, role: 'cancel' },
      ],
    });
  };

  if (muted && mutedUntil) {
    return (
      <GroupSettingsActionButton tone="danger" icon={notificationsOff} onClick={handleUnmute}>
        {getMutedUntilLabel(locale, mutedUntil)}
      </GroupSettingsActionButton>
    );
  }

  return (
    <GroupSettingsActionButton icon={notifications} onClick={showMuteActionSheet}>
      <Trans>Mute</Trans>
    </GroupSettingsActionButton>
  );
}
