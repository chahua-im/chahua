import { MessageType, type MessageResponse, type ThreadSubscriptionStatusResponse } from '../../generated/models';

/** Matches the server's push policy using the membership information already available locally. */
export function shouldNotify(
  message: MessageResponse,
  uid: number,
  chat: { archived?: boolean; mutedUntil?: string } | undefined,
  thread: ThreadSubscriptionStatusResponse | undefined,
  now = Date.now(),
): boolean {
  if (message.sender.uid === uid || message.isDeleted || message.messageType === MessageType.system) return false;
  if (!message.replyRootId && message.replyToMessage?.sender.uid === uid) return true;
  if (chat?.archived) return false;
  const mentioned = message.mentions?.some((mention) => mention.uid === uid) ?? false;
  if (message.replyRootId) return mentioned || !!(thread?.subscribed && !thread.archived);
  return mentioned || !(Date.parse(chat?.mutedUntil ?? '') > now);
}

/** System notifications need plain text, including expanded mentions and media-only messages. */
export function notificationText(message: MessageResponse): string {
  if (message.messageType === MessageType.invite) return '[邀请]';
  if (message.message?.trim()) {
    return message.message.replace(
      /@\[uid:(\d+)\]/g,
      (_, uid: string) => '@' + (message.mentions?.find((mention) => mention.uid === Number(uid))?.username ?? uid),
    );
  }
  switch (message.messageType) {
    case MessageType.sticker:
      return message.sticker?.emoji ?? '[表情]';
    case MessageType.audio:
      return '[语音]';
    case MessageType.file:
      return '[文件]';
  }
  const kind = message.attachments[0]?.kind;
  return kind?.startsWith('image/') ? '[图片]' : kind?.startsWith('video/') ? '[视频]' : '[消息]';
}
