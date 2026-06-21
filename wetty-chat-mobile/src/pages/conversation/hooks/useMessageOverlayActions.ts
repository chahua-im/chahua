import { useMemo } from 'react';
import { t } from '@lingui/core/macro';
import {
  arrowUndo,
  bookmarkOutline,
  chatbubbles,
  copyOutline,
  createOutline,
  heartOutline,
  informationCircleOutline,
  linkOutline,
  pin as pinIcon,
  pinOutline,
  trashOutline,
} from 'ionicons/icons';
import { useDispatch } from 'react-redux';
import { deleteMessage, type MessageResponse } from '@/api/messages';
import type { PinResponse } from '@/api/pins';
import { createPin, deletePin } from '@/api/pins';
import { favoriteSticker } from '@/api/stickers';
import { saveMessage } from '@/api/savedMessages';
import type { MessageOverlayAction } from '@/components/chat/messages/MessageOverlay';
import { messagePatched } from '@/store/messageEvents';
import { buildPermalinkUrl } from '@/utils/permalinkUrl';
import { getOverlayActionPolicy } from '../utils/overlayActionPolicy';

interface AlertButton {
  text: string;
  role?: 'cancel' | 'destructive';
  handler?: () => void;
}

interface AlertOptions {
  header: string;
  message: string;
  buttons: AlertButton[];
}

interface UseMessageOverlayActionsArgs {
  chatId: string;
  message: MessageResponse | null;
  currentUserId: number | null;
  isAdmin: boolean;
  threadId?: string;
  pins: PinResponse[];
  savedMessagesEnabled: boolean;
  presentAlert: (options: AlertOptions) => void;
  showToast: (text: string, duration?: number) => void;
  onReply: (message: MessageResponse) => void;
  onStartThread: (messageId: string) => void;
  onEdit: (message: MessageResponse) => void;
  onOpenReactionDetails: (messageId: string) => void;
}

export function useMessageOverlayActions({
  chatId,
  message,
  currentUserId,
  isAdmin,
  threadId,
  pins,
  savedMessagesEnabled,
  presentAlert,
  showToast,
  onReply,
  onStartThread,
  onEdit,
  onOpenReactionDetails,
}: UseMessageOverlayActionsArgs): MessageOverlayAction[] {
  const dispatch = useDispatch();

  return useMemo(() => {
    if (!message) return [];

    const isOwn = message.sender.uid === currentUserId;
    const existingPin = pins.find((pin) => pin.message.id === message.id);
    const policy = getOverlayActionPolicy({
      messageType: message.messageType,
      text: message.message,
      hasAttachments: (message.attachments?.length ?? 0) > 0,
      isDeleted: message.isDeleted,
      isOptimistic: message.id.startsWith('cg_'),
      hasThreadInfo: message.threadInfo != null,
      isOwn,
      isAdmin,
      isThreadView: threadId != null,
      savedMessagesEnabled,
      isPinned: existingPin != null,
      hasReactions: (message.reactions?.length ?? 0) > 0,
    });
    const actions: MessageOverlayAction[] = [];

    for (const policyAction of policy) {
      switch (policyAction.key) {
        case 'copy':
          actions.push({
            key: 'copy',
            label: t`Copy`,
            icon: copyOutline,
            handler: () => {
              const textToCopy = message.message ?? '';
              if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(textToCopy).catch(console.error);
              } else {
                // Fallback for environments lacking navigator.clipboard.writeText (e.g. insecure contexts or some WebViews)
                const textArea = document.createElement('textarea');
                textArea.value = textToCopy;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                  document.execCommand('copy');
                } catch (err) {
                  console.error('Fallback copy failed', err);
                }
                document.body.removeChild(textArea);
              }
            },
          });
          break;
        case 'copy-link':
          actions.push({
            key: 'copy-link',
            label: t`Link`,
            icon: linkOutline,
            handler: () => {
              navigator.clipboard.writeText(buildPermalinkUrl(chatId, message.id));
            },
          });
          break;
        case 'favorite':
          actions.push({
            key: 'favorite',
            label: t`Fav`,
            icon: heartOutline,
            handler: () => {
              favoriteSticker(message.sticker!.id)
                .then(() => {
                  showToast(t`Sticker added to favorites`, 2000);
                })
                .catch((e: Error) => {
                  showToast(e.message || t`Failed to add sticker to favorites`);
                });
            },
          });
          break;
        case 'save':
          actions.push({
            key: 'save',
            label: t({ message: 'Save', context: 'bookmark a message' }),
            icon: bookmarkOutline,
            handler: () => {
              saveMessage(message.id)
                .then(() => {
                  showToast(t`Message saved`, 2000);
                })
                .catch(() => {
                  showToast(t`Failed to save message`);
                });
            },
          });
          break;
        case 'reply':
          actions.push({
            key: 'reply',
            label: t`Reply`,
            icon: arrowUndo,
            handler: () => {
              onReply(message);
            },
          });
          break;
        case 'thread':
          actions.push({
            key: 'thread',
            label: t`Thread`,
            icon: chatbubbles,
            handler: () => {
              onStartThread(message.id);
            },
          });
          break;
        case 'edit':
          actions.push({
            key: 'edit',
            label: t`Edit`,
            icon: createOutline,
            handler: () => onEdit(message),
          });
          break;
        case 'delete':
          actions.push({
            key: 'delete',
            label: t`Delete`,
            icon: trashOutline,
            role: 'destructive',
            handler: () => {
              presentAlert({
                header: t`Delete Message`,
                message: isOwn
                  ? t`Are you sure you want to delete this message?`
                  : t`Are you sure you want to delete this message from ${message.sender.name ?? 'this user'}?`,
                buttons: [
                  { text: t`Cancel`, role: 'cancel' },
                  {
                    text: t`Delete`,
                    role: 'destructive',
                    handler: () => {
                      const deletedOptimistic = { ...message, isDeleted: true };
                      dispatch(messagePatched({ chatId, messageId: message.id, message: deletedOptimistic }));
                      deleteMessage(chatId, message.id).catch((e: any) => {
                        dispatch(messagePatched({ chatId, messageId: message.id, message }));
                        showToast(e.message || t`Failed to delete message`);
                      });
                    },
                  },
                ],
              });
            },
          });
          break;
        case 'pin':
          actions.push({
            key: 'pin',
            label: existingPin ? t`Unpin` : t`Pin`,
            icon: existingPin ? pinIcon : pinOutline,
            handler: () => {
              presentAlert({
                header: existingPin ? t`Unpin Message` : t`Pin Message`,
                message: existingPin ? t`Would you like to unpin this message?` : t`Pin this message in the group?`,
                buttons: [
                  { text: t`Cancel`, role: 'cancel' },
                  {
                    text: existingPin ? t`Unpin` : t`Pin`,
                    role: existingPin ? 'destructive' : undefined,
                    handler: () => {
                      if (existingPin) {
                        deletePin(chatId, existingPin.id).catch((e: any) => {
                          showToast(e.message || t`Failed to unpin message`);
                        });
                      } else {
                        createPin(chatId, message.id).catch((e: any) => {
                          showToast(e.message || t`Failed to pin message`);
                        });
                      }
                    },
                  },
                ],
              });
            },
          });
          break;
        case 'reaction-details':
          actions.push({
            key: 'reaction-details',
            icon: informationCircleOutline,
            label: t`Details`,
            handler: () => {
              onOpenReactionDetails(message.id);
            },
          });
          break;
      }
    }

    return actions;
  }, [
    chatId,
    currentUserId,
    dispatch,
    isAdmin,
    message,
    onEdit,
    onOpenReactionDetails,
    onReply,
    onStartThread,
    pins,
    presentAlert,
    savedMessagesEnabled,
    showToast,
    threadId,
  ]);
}
