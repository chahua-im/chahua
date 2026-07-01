import { t } from '@lingui/core/macro';
import { mentionToUser, type MessageResponse, type User } from '@/api/messages';
import { MessageOverlay, type MessageOverlayAction } from '@/components/chat/messages/MessageOverlay';
import { UserProfileModal } from '@/components/chat/profiles/UserProfileModal';
import { ReactionDetailsModal } from '@/components/chat/reactions/ReactionDetailsModal';
import { StickerPreviewModal } from '@/components/chat/compose/StickerPreviewModal';
import { PinListModal } from '@/components/chat/pins/PinListModal';

interface OverlayMessageState {
  message: MessageResponse;
  sourceRect: DOMRect;
  interactionPos?: { x: number; y: number };
}

interface ConversationOverlayHostProps {
  chatId: string;
  currentUserId: number | null;
  isAdmin: boolean;
  profileSender: User | null;
  onDismissProfile: () => void;
  onProfileSenderChange: (sender: User | null) => void;
  reactionDetail: { messageId: string; emoji?: string } | null;
  onDismissReactionDetail: () => void;
  stickerPreviewId: string | null;
  onDismissStickerPreview: () => void;
  pinListOpen: boolean;
  onDismissPinList: () => void;
  onSelectPin: (messageId: string) => void;
  onSelectThread: (messageId: string) => void;
  overlayMessage: OverlayMessageState | null;
  overlayActions: MessageOverlayAction[];
  quickReactionEmojis: string[];
  onReactionToggle: (message: MessageResponse, emoji: string, currentlyReacted: boolean) => void;
  onCloseOverlay: () => void;
}

export function ConversationOverlayHost({
  chatId,
  currentUserId,
  isAdmin,
  profileSender,
  onDismissProfile,
  onProfileSenderChange,
  reactionDetail,
  onDismissReactionDetail,
  stickerPreviewId,
  onDismissStickerPreview,
  pinListOpen,
  onDismissPinList,
  onSelectPin,
  onSelectThread,
  overlayMessage,
  overlayActions,
  quickReactionEmojis,
  onReactionToggle,
  onCloseOverlay,
}: ConversationOverlayHostProps) {
  const msg = overlayMessage?.message;

  return (
    <>
      <UserProfileModal sender={profileSender} onDismiss={onDismissProfile} chatId={chatId} canManage={isAdmin} />
      <ReactionDetailsModal
        chatId={chatId}
        messageId={reactionDetail?.messageId ?? null}
        initialEmoji={reactionDetail?.emoji}
        onDismiss={onDismissReactionDetail}
        onAvatarClick={onProfileSenderChange}
      />
      <StickerPreviewModal stickerId={stickerPreviewId} onDismiss={onDismissStickerPreview} />
      <PinListModal
        chatId={chatId}
        isOpen={pinListOpen}
        onDismiss={onDismissPinList}
        onSelectPin={onSelectPin}
        onSelectThread={onSelectThread}
      />
      {overlayMessage && msg
        ? (() => {
            const sharedOverlayProps = {
              senderName: msg.sender.name ?? `User ${msg.sender.uid}`,
              isSent: msg.sender.uid === currentUserId,
              showName: true,
              timestamp: msg.createdAt,
              edited: msg.isEdited,
              isConfirmed: !msg.id.startsWith('cg_'),
              messageId: msg.id,
              replyTo: msg.replyToMessage
                ? {
                    senderName: msg.replyToMessage.sender.name ?? `User ${msg.replyToMessage.sender.uid}`,
                    preview: msg.replyToMessage,
                  }
                : undefined,
              sourceRect: overlayMessage.sourceRect,
              interactionPos: overlayMessage.interactionPos,
              actions: overlayActions,
              reactions: msg.isDeleted
                ? undefined
                : {
                    emojis: quickReactionEmojis,
                    currentMessageReactions: msg.reactions?.map((r) => r.emoji) ?? [],
                    onReact: (emoji: string) => {
                      onReactionToggle(msg, emoji, !!msg.reactions?.some((r) => r.emoji === emoji && r.reactedByMe));
                    },
                  },
              onClose: onCloseOverlay,
              mentions: msg.mentions ?? undefined,
              currentUserUid: currentUserId,
              onMentionClick: (uid: number) => onProfileSenderChange(mentionToUser(msg.mentions, uid)),
            } as const;

            if (msg.messageType === 'sticker') {
              return (
                <MessageOverlay
                  messageType="sticker"
                  stickerUrl={msg.sticker?.media.url ?? ''}
                  {...sharedOverlayProps}
                />
              );
            }

            if (msg.messageType === 'invite') {
              return (
                <MessageOverlay messageType="invite" inviteCode={msg.message?.trim() ?? ''} {...sharedOverlayProps} />
              );
            }

            return (
              <MessageOverlay
                messageType={msg.messageType as 'text' | 'audio'}
                message={msg.isDeleted ? t`[Deleted]` : (msg.message ?? '')}
                attachments={msg.attachments}
                {...sharedOverlayProps}
              />
            );
          })()
        : null}
    </>
  );
}
