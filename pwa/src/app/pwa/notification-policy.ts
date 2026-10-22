import { placeholderLabel } from '../messages/forward-placeholder';
import {
  GroupKind,
  MessageType,
  type MessageResponse,
  type ThreadSubscriptionStatusResponse,
} from '../../generated/models';

/** Matches the server's push policy using the membership information already available locally. */
export function shouldNotify(
  message: MessageResponse,
  uid: number,
  chat: { kind?: GroupKind; archived?: boolean; mutedUntil?: string } | undefined,
  thread: ThreadSubscriptionStatusResponse | undefined,
  now = Date.now(),
): boolean {
  if (message.sender.uid === uid || message.isDeleted || message.messageType === MessageType.system) return false;
  const directed = chat?.kind === GroupKind.group;
  const replied = directed && message.replyToMessage?.sender.uid === uid;
  if (replied && !message.replyRootId) return true;
  if (chat?.archived) return false;
  const mentioned =
    directed && !message.forwardedFrom && (message.mentions?.some((mention) => mention.uid === uid) ?? false);
  if (message.replyRootId) return mentioned || replied || !!(thread?.subscribed && !thread.archived);
  return mentioned || !(Date.parse(chat?.mutedUntil ?? '') > now);
}

/** System notifications need plain text, including expanded mentions and media-only messages. */
export function notificationText(message: MessageResponse, translate: (key: string) => string): string {
  if (message.isDeleted) return translate('messages.preview.deleted');
  if (message.messageType === MessageType.placeholder) return translate(placeholderLabel(message.message));
  if (message.messageType === MessageType.forwarded) return translate('messages.preview.forwarded');
  if (message.messageType === MessageType.invite) return translate('pwa.notification.invite');
  if (message.message?.trim()) {
    return message.message.replace(
      /@\[uid:(\d+)\]/g,
      (_, uid: string) => '@' + (message.mentions?.find((mention) => mention.uid === Number(uid))?.username ?? uid),
    );
  }
  switch (message.messageType) {
    case MessageType.sticker:
      return message.sticker?.emoji ?? translate('pwa.notification.sticker');
    case MessageType.audio:
      return translate('pwa.notification.audio');
    case MessageType.file:
      return translate('pwa.notification.file');
  }
  const kind = message.attachments[0]?.kind;
  return kind?.startsWith('image/')
    ? translate('pwa.notification.image')
    : kind?.startsWith('video/')
      ? translate('pwa.notification.video')
      : translate('pwa.notification.message');
}
