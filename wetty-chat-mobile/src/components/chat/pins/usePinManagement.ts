import { useCallback } from 'react';
import { useIonAlert, useIonToast } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { useSelector } from 'react-redux';
import type { RootState } from '@/store/index';
import { selectChatMeta } from '@/store/chatsSlice';
import { useChatRole } from '@/components/chat/permissions/useChatRole';
import { useDeadDm } from '@/hooks/useDeadDm';
import { deletePin, deleteThreadPin } from '@/api/pins';
import { apiErrorMessage } from '@/api/errors';

interface UsePinManagementResult {
  /** Whether the current user may unpin in this chat (admin, or DM participant of a live DM). */
  canUnpin: boolean;
  /** Confirms and executes an unpin, surfacing failures via a toast. */
  confirmUnpin: (pinId: string) => void;
}

/**
 * Shared pin-management policy for the pin banner and pin list modal: who may
 * unpin, and how a failed unpin is reported. Chat pins and thread pins share
 * one policy; the thread root is resolved from the optional argument.
 */
export function usePinManagement(chatId: string, threadRootId?: string): UsePinManagementResult {
  const [presentAlert] = useIonAlert();
  const [presentToast] = useIonToast();
  const { role } = useChatRole(chatId);
  const chatMetaKind = useSelector((state: RootState) => selectChatMeta(state, chatId)?.kind);
  const peerUid = useSelector((state: RootState) => selectChatMeta(state, chatId)?.peer?.uid);
  const { deadDm } = useDeadDm({ isDm: chatMetaKind === 'dm', peerUid });

  const confirmUnpin = useCallback(
    (pinId: string) => {
      presentAlert({
        header: t`Unpin Message`,
        message: t`Would you like to unpin this message?`,
        buttons: [
          { text: t`Cancel`, role: 'cancel' },
          {
            text: t`Unpin`,
            role: 'destructive',
            handler: () => {
              const unpin = threadRootId ? deleteThreadPin(chatId, threadRootId, pinId) : deletePin(chatId, pinId);
              unpin.catch((err: unknown) => {
                presentToast({
                  message: apiErrorMessage(err, t`Failed to unpin message`),
                  duration: 3000,
                  position: 'bottom',
                  cssClass: 'toast-center',
                });
              });
            },
          },
        ],
      });
    },
    [chatId, threadRootId, presentAlert, presentToast],
  );

  return { canUnpin: (role === 'admin' || chatMetaKind === 'dm') && !deadDm, confirmUnpin };
}
