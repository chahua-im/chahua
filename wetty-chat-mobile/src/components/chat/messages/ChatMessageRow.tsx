import { useState } from 'react';
import { t } from '@lingui/core/macro';
import { type MessageResponse, mentionToUser, type User } from '@/api/messages';
import { InviteMessageModal } from '@/components/invites/InviteMessageModal';
import { ChatBubble } from './ChatBubble';
import { type BubblePropsOverride } from './ChatBubbleBase';
import { MessageDateSeparator } from './MessageDateSeparator';
import { SystemMessage } from './SystemMessage';
import type { ChatRow } from '../virtualScroll/types';

interface ChatMessageRowProps {
  row: ChatRow;
  currentUserId: number | string | null;
  threadId?: string;
  onReply: (message: MessageResponse) => void;
  onJumpToReply: (messageId: string) => void;
  onLongPress: (message: MessageResponse, rect: DOMRect, interactionPos?: { x: number; y: number }) => void;
  onAvatarClick: (sender: User) => void;
  onThreadClick: (message: MessageResponse) => void;
  onReactionToggle: (message: MessageResponse, emoji: string, currentlyReacted: boolean) => void;
  onStickerTap?: (stickerId: string) => void;
}

function isSystemMessage(message: MessageResponse): boolean {
  return message.messageType === 'system';
}

function isInviteMessage(message: MessageResponse): boolean {
  return message.messageType === 'invite';
}

function isStickerMessage(message: MessageResponse): boolean {
  return message.messageType === 'sticker';
}

export function ChatMessageRow({
  row,
  currentUserId,
  threadId,
  onReply,
  onJumpToReply,
  onLongPress,
  onAvatarClick,
  onThreadClick,
  onReactionToggle,
  onStickerTap,
}: ChatMessageRowProps) {
  const [inviteCode, setInviteCode] = useState<string | null>(null);

  if (row.type === 'date') {
    return <MessageDateSeparator label={row.dateLabel} />;
  }

  const msg = row.message;
  const replyToMessage = msg.replyToMessage;
  if (isSystemMessage(msg)) {
    return <SystemMessage senderName={msg.sender.name} message={msg.isDeleted ? t`[Deleted]` : (msg.message ?? '')} />;
  }

  const sharedBubbleProps = {
    senderName: msg.sender.name ?? `User ${msg.sender.uid}`,
    isSent: msg.sender.uid === currentUserId,
    avatarUrl: msg.sender.avatarUrl ?? undefined,
    onReply: () => onReply(msg),
    onReplyTap: replyToMessage && !replyToMessage.isDeleted ? () => onJumpToReply(replyToMessage.id) : undefined,
    onLongPress: (rect: DOMRect, interactionPos?: { x: number; y: number }) => onLongPress(msg, rect, interactionPos),
    showAvatar: row.showAvatar,
    timestamp: msg.createdAt,
    edited: msg.isEdited,
    threadInfo: !threadId ? msg.threadInfo : undefined,
    onThreadClick: () => onThreadClick(msg),
    onAvatarClick: () => onAvatarClick(msg.sender),
    isConfirmed: !msg.id.startsWith('cg_'),
    bubbleProps: { 'data-message-id': msg.id } as BubblePropsOverride,
    replyTo: replyToMessage
      ? {
          senderName: replyToMessage.sender.name ?? `User ${replyToMessage.sender.uid}`,
          preview: replyToMessage,
        }
      : undefined,
  } as const;

  if (isInviteMessage(msg)) {
    const code = msg.message?.trim() ?? '';
    return (
      <>
        <ChatBubble
          {...sharedBubbleProps}
          messageType="invite"
          inviteCode={code}
          showName={row.showName}
          onOpen={() => setInviteCode(code)}
        />
        <InviteMessageModal inviteCode={inviteCode} onDismiss={() => setInviteCode(null)} />
      </>
    );
  }

  if (isStickerMessage(msg)) {
    const stickerUrl = msg.sticker?.media.url ?? '';
    return (
      <ChatBubble
        {...sharedBubbleProps}
        messageType="sticker"
        stickerUrl={stickerUrl}
        onStickerTap={msg.sticker && onStickerTap ? () => onStickerTap(msg.sticker!.id) : undefined}
      />
    );
  }

  return (
    <ChatBubble
      {...sharedBubbleProps}
      messageType={msg.messageType as 'text' | 'audio'}
      senderGender={msg.sender.gender}
      senderGroup={msg.sender.userGroup}
      message={msg.isDeleted ? t`[Deleted]` : (msg.message ?? '')}
      showName={row.showName}
      attachments={msg.attachments}
      reactions={msg.reactions}
      onReactionToggle={(emoji, currentlyReacted) => onReactionToggle(msg, emoji, currentlyReacted)}
      mentions={msg.mentions}
      currentUserUid={typeof currentUserId === 'number' ? currentUserId : null}
      onMentionClick={(uid) => onAvatarClick(mentionToUser(msg.mentions, uid))}
    />
  );
}
