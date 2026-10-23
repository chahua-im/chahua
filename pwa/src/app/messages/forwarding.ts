import { MessageType, type MessageResponse, type ForwardedMessagesPreviewResponse } from '../../generated/models';
import type { OutgoingMessage } from './message-outbox';
import type { MessageContent } from './message/message';

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
  TopicUnavailable = 'messages.forward.topicUnavailable',
  TooMany = 'messages.forward.topicTooMany',
  LoadFailed = 'messages.forward.topicLoadFailed',
  NavigationFailed = 'messages.forward.navigationFailed',
}

export type ForwardSourcesResult = { sources: readonly ForwardSource[] } | { error: ForwardSelectionError };

/** Reads the current sources when a target is chosen, so a growing topic is sent as it is then. */
export type ForwardSourcesLoader = () => Promise<ForwardSourcesResult>;

export function canForward(message: MessageContent): boolean {
  return (
    message.id != null &&
    !message.isDeleted &&
    message.messageType !== MessageType.system &&
    message.messageType !== MessageType.invite
  );
}

export function showsForwardOrigin(message: Pick<MessageContent, 'messageType' | 'isDeleted'>): boolean {
  return (
    !message.isDeleted && message.messageType !== MessageType.sticker && message.messageType !== MessageType.forwarded
  );
}

export function forwardPreview(messages: readonly MessageResponse[]): ForwardedMessagesPreviewResponse {
  return {
    total: messages.length,
    containsForwardedMessages: messages.some((message) => message.messageType === MessageType.forwarded),
    messages: messages.slice(0, 3).map((message) => ({
      originalMessageId: message.id,
      originalChatId: message.chatId,
      originalCreatedAt: message.createdAt,
      sender: message.sender,
      messageType: message.messageType,
      message: message.message,
      attachments: message.attachments,
      sticker: message.sticker,
      mentions: message.mentions,
    })),
  };
}
