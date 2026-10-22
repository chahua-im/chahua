import { MessageType, type MessageResponse, type ForwardedMessagesPreviewResponse } from '../../generated/models';
import type { OutgoingMessage } from './message-outbox';
import type { SnowflakeID } from '../api/snowflake-id';
import { ForwardPlaceholder } from './forward-placeholder';
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

export function forwardPlaceholders(sources: readonly ForwardSource[]): ReadonlyMap<SnowflakeID, ForwardPlaceholder> {
  const replacements = new Map<SnowflakeID, ForwardPlaceholder>();
  for (const source of sources) {
    const message = forwardSourceMessage(source);
    if (!message) continue;
    if ('delivery' in source && !source.published() && message.messageType === MessageType.audio) {
      replacements.set(message.id, ForwardPlaceholder.PendingAudio);
    } else if (
      sources.length > 1 &&
      message.messageType === MessageType.forwarded &&
      message.forwardedPreview?.containsForwardedMessages
    ) {
      replacements.set(message.id, ForwardPlaceholder.NestedForward);
    }
  }
  return replacements;
}

/** Optimistic content only; the request still sends the original source IDs. */
export function placeholderMessage(message: MessageResponse, reason: ForwardPlaceholder): MessageResponse {
  return {
    ...message,
    messageType: MessageType.placeholder,
    message: reason,
    hasAttachments: false,
    attachments: [],
    sticker: undefined,
    mentions: [],
    forwardedBundleId: undefined,
    forwardedPreview: undefined,
  };
}

export enum ForwardSelectionError {
  Unavailable = 'messages.forward.unavailable',
}

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
