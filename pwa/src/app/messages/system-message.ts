import { MessageType, SystemMessageKind, type MessageResponse } from '../../generated/models';

type SystemMessage = Pick<MessageResponse, 'messageType' | 'systemKind' | 'message'>;

const labels: Partial<Record<SystemMessageKind, string>> = {
  [SystemMessageKind.member_joined]: 'joined',
  [SystemMessageKind.member_left]: 'left',
  [SystemMessageKind.member_added]: 'added',
  [SystemMessageKind.member_removed]: 'removed',
  [SystemMessageKind.message_pinned]: 'pinned',
  [SystemMessageKind.message_unpinned]: 'unpinned',
  [SystemMessageKind.thread_message_pinned]: 'threadPinned',
  [SystemMessageKind.thread_message_unpinned]: 'threadUnpinned',
  [SystemMessageKind.friend_request_accepted]: 'accepted',
};

export function systemMessagePresentation(message: SystemMessage) {
  if (message.messageType !== MessageType.system || message.systemKind == null) return undefined;
  const kind = labels[message.systemKind];
  if (!kind) return undefined;
  // Keep names from the stored display text. Event identity comes only from systemKind.
  const text = message.message ?? '';
  let target: string | undefined;
  switch (message.systemKind) {
    case SystemMessageKind.member_added:
      target = text.slice('added '.length);
      break;
    case SystemMessageKind.member_removed:
      target = text.slice('removed '.length);
      break;
    case SystemMessageKind.friend_request_accepted:
      target = text.slice('accepted '.length, -"'s friend request".length);
      break;
  }
  return { kind, target };
}

export function isMembershipMessage(message: Pick<MessageResponse, 'messageType' | 'systemKind'>) {
  if (message.messageType !== MessageType.system) return false;
  switch (message.systemKind) {
    case SystemMessageKind.member_joined:
    case SystemMessageKind.member_left:
    case SystemMessageKind.member_added:
    case SystemMessageKind.member_removed:
      return true;
    default:
      return false;
  }
}
