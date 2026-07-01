import { useState } from 'react';
import { t } from '@lingui/core/macro';
import { type MessageResponse, mentionToUser, type User } from '@/api/messages';
import { InviteMessageModal } from '@/components/invites/InviteMessageModal';
import { ChatBubble } from './ChatBubble';
import { type BubblePropsOverride } from './ChatBubbleBase';
import { MessageDateSeparator } from './MessageDateSeparator';
import { SenderGroup } from './SenderGroup';
import { SystemMessage } from './SystemMessage';
import { isInviteMessage, isStickerMessage } from './messageTypePredicates';
import type { ChatRow } from '../virtualScroll/types';

/**
 * Message-interaction callbacks shared by ChatMessageRow and MessageBubble.
 * Declared once so a callback signature change propagates to both call sites
 * via the type system instead of two parallel declarations.
 */
export interface ChatMessageHandlers {
  onReply: (message: MessageResponse) => void;
  onJumpToReply: (messageId: string) => void;
  onLongPress: (message: MessageResponse, rect: DOMRect, interactionPos?: { x: number; y: number }) => void;
  onAvatarClick: (sender: User) => void;
  onThreadClick: (message: MessageResponse) => void;
  onReactionToggle: (message: MessageResponse, emoji: string, currentlyReacted: boolean) => void;
  onStickerTap?: (stickerId: string) => void;
}

interface ChatMessageRowProps extends ChatMessageHandlers {
  row: ChatRow;
  currentUserId: number | string | null;
  threadId?: string;
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
  if (row.type === 'date') {
    return <MessageDateSeparator label={row.dateLabel} />;
  }

  const { messages, useStickyAvatar, showName, isSystem } = row;

  // System message groups render without an avatar container.
  if (isSystem) {
    const msg = messages[0];
    return <SystemMessage senderName={msg.sender.name} message={msg.isDeleted ? t`[Deleted]` : (msg.message ?? '')} />;
  }

  const isSent = messages[0].sender.uid === currentUserId;

  return (
    <SenderGroup
      useStickyAvatar={useStickyAvatar}
      isSent={isSent}
      sender={messages[0].sender}
      onAvatarClick={onAvatarClick}
    >
      {messages.map((msg, index) => (
        <MessageBubble
          key={msg.clientGeneratedId || msg.id}
          msg={msg}
          index={index}
          isSent={isSent}
          useStickyAvatar={useStickyAvatar}
          showName={showName}
          threadId={threadId}
          currentUserId={currentUserId}
          onReply={onReply}
          onJumpToReply={onJumpToReply}
          onLongPress={onLongPress}
          onAvatarClick={onAvatarClick}
          onThreadClick={onThreadClick}
          onReactionToggle={onReactionToggle}
          onStickerTap={onStickerTap}
          isLastInGroup={index === messages.length - 1}
        />
      ))}
    </SenderGroup>
  );
}

interface MessageBubbleProps extends ChatMessageHandlers {
  msg: MessageResponse;
  index: number;
  isSent: boolean;
  useStickyAvatar: boolean;
  isLastInGroup: boolean;
  showName: boolean;
  threadId?: string;
  currentUserId: number | string | null;
}

function MessageBubble({
  msg,
  index,
  isSent,
  useStickyAvatar,
  isLastInGroup,
  showName,
  threadId,
  currentUserId,
  onReply,
  onJumpToReply,
  onLongPress,
  onAvatarClick,
  onThreadClick,
  onReactionToggle,
  onStickerTap,
}: MessageBubbleProps) {
  const [inviteCode, setInviteCode] = useState<string | null>(null);

  const replyToMessage = msg.replyToMessage;

  // Sticky avatar (group-level, handled by SenderGroup) vs inline avatar
  // (per-message, shown when showAllAvatars is on) are one concept's two
  // polarities; derive the local render flag from the single upstream value.
  const showInlineAvatar = !useStickyAvatar;

  // Droplet tail points at the adjacent avatar. Inline mode gives every
  // bubble its own avatar; sticky mode rests one group avatar at the last
  // bubble, so only the last bubble carries the tail.
  const showDroplet = showInlineAvatar || (useStickyAvatar && isLastInGroup);

  // Only the group's first bubble shows the sender name.
  const showNameOnBubble = showName && index === 0;

  const sharedBubbleProps = {
    senderName: msg.sender.name ?? `User ${msg.sender.uid}`,
    isSent,
    avatarUrl: msg.sender.avatarUrl ?? undefined,
    onReply: () => onReply(msg),
    onReplyTap: replyToMessage && !replyToMessage.isDeleted ? () => onJumpToReply(replyToMessage.id) : undefined,
    onLongPress: (rect: DOMRect, interactionPos?: { x: number; y: number }) => onLongPress(msg, rect, interactionPos),
    showAvatar: showInlineAvatar,
    timestamp: msg.createdAt,
    edited: msg.isEdited,
    threadInfo: !threadId ? msg.threadInfo : undefined,
    onThreadClick: () => onThreadClick(msg),
    onAvatarClick: () => onAvatarClick(msg.sender),
    isLastInGroup,
    isConfirmed: !msg.id.startsWith('cg_'),
    bubbleProps: { 'data-message-id': msg.id, 'data-bubble-row': '' } as BubblePropsOverride,
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
          showName={showNameOnBubble}
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
      showDroplet={showDroplet}
      messageType={msg.messageType as 'text' | 'audio'}
      senderGender={msg.sender.gender}
      senderGroup={msg.sender.userGroup}
      message={msg.isDeleted ? t`[Deleted]` : (msg.message ?? '')}
      showName={showNameOnBubble}
      attachments={msg.attachments}
      reactions={msg.reactions}
      onReactionToggle={(emoji, currentlyReacted) => onReactionToggle(msg, emoji, currentlyReacted)}
      reactionsInteractive={!msg.isDeleted}
      mentions={msg.mentions}
      currentUserUid={typeof currentUserId === 'number' ? currentUserId : null}
      onMentionClick={(uid) => onAvatarClick(mentionToUser(msg.mentions, uid))}
    />
  );
}
