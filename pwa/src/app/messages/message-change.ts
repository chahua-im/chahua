import {
  ServerWsMessageType,
  type MessagePreview,
  type MessageResponse,
  type ServerWsMessage,
} from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';
import { preserveReactionOwnership } from './reaction-state';

export type MessageChange =
  | (Extract<ServerWsMessage, { type: 'messageUpdated' }> & { restoreToTimeline?: true })
  | (Extract<ServerWsMessage, { type: 'messagesBulkDeleted' }> & {
      removeFromTimeline?: true;
      recallEcho?: true;
      threadRepliesOnly?: true;
    })
  | (Extract<ServerWsMessage, { type: 'messageDeleted' }> & { fromRecallRpc?: true; recallEcho?: true })
  | Extract<ServerWsMessage, { type: 'reactionUpdated' }>;

export function isMessageChange(event: ServerWsMessage): event is MessageChange {
  return (
    event.type === ServerWsMessageType.messageUpdated ||
    event.type === ServerWsMessageType.messageDeleted ||
    event.type === ServerWsMessageType.messagesBulkDeleted ||
    event.type === ServerWsMessageType.reactionUpdated
  );
}

export type PinChange = Extract<
  ServerWsMessage,
  { type: 'pinAdded' | 'pinRemoved' | 'threadPinAdded' | 'threadPinRemoved' }
>;

export function recalledMessageIds(event: MessageChange): readonly SnowflakeID[] | undefined {
  if (event.type === ServerWsMessageType.messagesBulkDeleted) return event.payload.messageIds;
  if (
    event.type === ServerWsMessageType.messageDeleted ||
    (event.type === ServerWsMessageType.messageUpdated && event.payload.isDeleted)
  )
    return [event.payload.id];
  return undefined;
}

export function replaceEditedMessage(current: MessageResponse, next: MessageResponse): MessageResponse {
  const quote = current.replyToMessage;
  const incoming = next.replyToMessage;
  return {
    ...next,
    // A late edit of the reply must not restore the embedded body of an already recalled message.
    replyToMessage: quote?.isDeleted && quote.id === incoming?.id && !incoming.isDeleted ? quote : incoming,
    reactions: preserveReactionOwnership(current.reactions, next.reactions),
  };
}

export function redactDeletedMessage(message: MessageResponse): MessageResponse {
  return {
    ...message,
    isDeleted: true,
    forwardedFrom: undefined,
    forwardedPreview: undefined,
    forwardedBundleId: undefined,
    message: undefined,
    metadata: undefined,
    attachments: [],
    mentions: [],
    sticker: undefined,
  };
}

export function recallConfirmation(message: MessageResponse): MessageChange {
  return {
    type: ServerWsMessageType.messageDeleted,
    fromRecallRpc: true,
    payload: redactRecallConfirmation(message),
  };
}

function redactRecallConfirmation(message: MessageResponse): MessageResponse {
  return { ...redactDeletedMessage(message), hasAttachments: false, reactions: [] };
}

/** MessageSync only removes a recalled root from the timeline once its topic has no live replies. */
export function redactRemovedMessage(message: MessageResponse): MessageResponse {
  return { ...redactDeletedMessage(message), threadInfo: undefined };
}

type ReplyPreview = Omit<MessagePreview, 'clientGeneratedId'>;
type MessageIdLookup = Pick<ReadonlySet<SnowflakeID>, 'has' | 'size'>;

function redactDeletedPreview<T extends ReplyPreview>(quote: T): T {
  return {
    ...quote,
    isDeleted: true,
    message: undefined,
    metadata: undefined,
    systemLinks: undefined,
    forwardedFromName: undefined,
    attachments: [],
    mentions: [],
    sticker: undefined,
  };
}

export function redactRecalledReply<T extends { replyToMessage?: ReplyPreview }>(
  message: T,
  recalledIds: ReadonlySet<SnowflakeID>,
): T {
  const quote = message.replyToMessage;
  const replyToMessage = redactRecalledPreview(quote, recalledIds);
  return replyToMessage === quote ? message : { ...message, replyToMessage };
}

export function redactRecalledPreview<T extends ReplyPreview>(quote: T | undefined, recalledIds: MessageIdLookup) {
  return quote && !quote.isDeleted && recalledIds.has(quote.id) ? redactDeletedPreview(quote) : quote;
}

export function redactRecalledCitations(message: MessageResponse, recalledIds: MessageIdLookup): MessageResponse {
  if (!recalledIds.size) return message;
  const quote = message.replyToMessage;
  const origin = message.forwardedFrom;
  const originalQuote = origin?.originalReplyTo;
  const replyToMessage = redactRecalledPreview(quote, recalledIds);
  const forwardedFrom =
    originalQuote && !originalQuote.isDeleted && recalledIds.has(originalQuote.id)
      ? { ...origin, originalReplyTo: redactDeletedPreview(originalQuote) }
      : origin;
  return replyToMessage === quote && forwardedFrom === origin ? message : { ...message, replyToMessage, forwardedFrom };
}

export function replaceMessageCitation(message: MessageResponse, preview: MessagePreview): MessageResponse {
  const quote = message.replyToMessage;
  return quote?.id === preview.id && !quote.isDeleted && quote !== preview
    ? { ...message, replyToMessage: preview }
    : message;
}

/** Mirrors the server's MessagePreview shape embedded as replyToMessage. */
export function toMessagePreview(message: MessageResponse): MessagePreview {
  return {
    metadata: message.metadata,
    id: message.id,
    clientGeneratedId: message.clientGeneratedId,
    forwardedFromName: message.forwardedFrom?.sender.name,
    createdAt: message.createdAt,
    sender: message.sender,
    message: message.message,
    messageType: message.messageType,
    systemKind: message.systemKind,
    systemLinks: message.systemLinks,
    sticker: message.sticker ? { emoji: message.sticker.emoji } : message.sticker,
    attachments: message.attachments.map(({ kind }) => ({ kind })),
    isDeleted: message.isDeleted,
    mentions: message.mentions ?? [],
  };
}

/** Applies an event to snapshots already held by a chat, including their embedded references. */
export function messageChangePatch(
  event: MessageChange,
  redactBulkDeleted = redactDeletedMessage,
): (message: MessageResponse) => MessageResponse {
  switch (event.type) {
    case ServerWsMessageType.messageUpdated:
    case ServerWsMessageType.messageDeleted: {
      const next = event.payload;
      if (event.type === ServerWsMessageType.messageDeleted || next.isDeleted) {
        const recalled = new Set([next.id]);
        if (event.type === ServerWsMessageType.messageDeleted && event.fromRecallRpc) {
          return (message) =>
            message.id === next.id ? redactRecallConfirmation(message) : redactRecalledCitations(message, recalled);
        }
        let replacement: MessageResponse | undefined;
        return (message) =>
          message.id === next.id
            ? replaceEditedMessage(message, (replacement ??= redactDeletedMessage(next)))
            : redactRecalledCitations(message, recalled);
      }
      let preview: MessagePreview | undefined;
      return (message) => {
        if (message.id === next.id) return replaceEditedMessage(message, next);
        if (message.replyToMessage?.id !== next.id) return message;
        return replaceMessageCitation(message, (preview ??= toMessagePreview(next)));
      };
    }
    case ServerWsMessageType.messagesBulkDeleted: {
      const recalled = new Set(event.payload.messageIds);
      return (message) =>
        recalled.has(message.id) ? redactBulkDeleted(message) : redactRecalledCitations(message, recalled);
    }
    default: {
      const { messageId, reactions } = event.payload;
      return (message) =>
        message.id === messageId
          ? { ...message, reactions: preserveReactionOwnership(message.reactions, reactions) }
          : message;
    }
  }
}
