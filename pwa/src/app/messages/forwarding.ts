import type { ChatPickerTarget } from '../chats/chat-picker/chat-picker';
import type { ChatStore } from '../chats/chat-store';
import { SpeakingAction } from '../chats/speaking';
import { GroupKind, MessageType, type MessageResponse } from '../../generated/models';
import type { OutgoingMessage } from './message-outbox';
import type { MessageContent } from './message/message';

export function forwardRelationship(store: ChatStore, target: ChatPickerTarget) {
  const uid =
    target.kind === GroupKind.dm ? store.conversationInfo(target.chatId, target.threadId)?.peer?.uid : undefined;
  return uid == null ? undefined : store.relationship(uid);
}

export async function loadForwardTarget(store: ChatStore, target: ChatPickerTarget) {
  let relationship = forwardRelationship(store, target);
  if (!relationship) {
    await store.ensureDetails(target.chatId);
    relationship = forwardRelationship(store, target);
  }
  if (relationship) {
    const release = relationship.activate();
    try {
      await relationship.ensure();
      if (relationship.error()) throw new Error('Could not load private chat permissions');
    } finally {
      release();
    }
  }
}

export function canForwardTo(store: ChatStore, target: ChatPickerTarget) {
  return (
    store.isAccessible(target.chatId, target.threadId) &&
    (target.kind !== GroupKind.dm || forwardRelationship(store, target)?.value()?.canDm === true) &&
    store.canSpeak(
      target.chatId,
      target.threadId ? SpeakingAction.ThreadReply : SpeakingAction.ChatMessage,
      target.kind,
    )
  );
}

export const MAX_FORWARD_MESSAGES = 100;

export type ForwardSource = MessageResponse | OutgoingMessage;

/** The acknowledgement ID is available before an audio message is published. */
export function forwardSourceMessage(source: ForwardSource): MessageResponse | undefined {
  return 'delivery' in source ? (source.cancelled() ? undefined : source.confirmed()) : source;
}

/** Selection needs a server ID, but does not check forwarding restrictions. */
export function canSelect(message: MessageContent): boolean {
  return message.id != null && !message.isDeleted && message.messageType !== MessageType.system;
}

export enum ForwardSelectionError {
  Unavailable = 'messages.forward.unavailable',
  Stale = 'messages.forward.invalid',
  TopicLoadFailed = 'messages.forward.topicLoadFailed',
  TopicUnavailable = 'messages.forward.topicUnavailable',
  TooMany = 'messages.forward.topicTooMany',
  NavigationFailed = 'messages.forward.navigationFailed',
  Restricted = 'messages.forward.restricted',
}

export type ForwardTopic = Required<Pick<ChatPickerTarget, 'chatId' | 'threadId'>>;

export function canForward(message: MessageContent, messageCount = 1): boolean {
  return canSelect(message) && (messageCount > 1 || message.messageType !== MessageType.invite);
}

export function showsForwardOrigin(message: Pick<MessageContent, 'messageType' | 'isDeleted'>): boolean {
  return (
    !message.isDeleted && message.messageType !== MessageType.sticker && message.messageType !== MessageType.forwarded
  );
}
