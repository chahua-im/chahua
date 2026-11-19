import { LinkPreviewStatus, MessageType, type MessageResponse } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { ForwardPlaceholder } from '../forward-placeholder';
import { showsForwardOrigin } from '../forwarding';
import type { MessageContent } from '../message/message';

export interface ForwardPreview {
  source: MessageResponse;
  message: Omit<MessageContent, 'sender'>;
  records?: (MessageResponse & { redacted: boolean })[];
}

export function placeholderReasons(sources: readonly MessageResponse[], byId?: Readonly<Record<string, unknown>>) {
  const reasons: Record<string, ForwardPlaceholder> = {};
  for (const source of sources) {
    const id = decodeId(source.id);
    if (byId) {
      const reason = byId[id];
      if (reason === ForwardPlaceholder.PendingAudio || reason === ForwardPlaceholder.NestedForward)
        reasons[id] = reason;
    } else if (source.audioPending) {
      reasons[id] = ForwardPlaceholder.PendingAudio;
    } else if (sources.length > 1 && source.forwardedPreview?.containsForwardedMessages) {
      reasons[id] = ForwardPlaceholder.NestedForward;
    }
  }
  return reasons;
}

function previewItem(source: MessageResponse, reason: ForwardPlaceholder | undefined): MessageResponse {
  const links = source.metadata?.linkPreviews.filter(
    (link) => link.status === LinkPreviewStatus.ready || link.status === LinkPreviewStatus.disabled,
  );
  return {
    ...source,
    forwardedFrom: undefined,
    canJumpToOriginalReply: undefined,
    forwardedThreadReplyCount: source.forwardedThreadReplyCount ?? source.threadInfo?.replyCount,
    threadInfo: undefined,
    reactions: [],
    isEdited: false,
    metadata: links?.length ? { linkPreviews: links } : undefined,
    ...(reason && {
      messageType: MessageType.placeholder,
      message: reason,
      attachments: [],
      audioPending: undefined,
      hasAttachments: false,
      sticker: undefined,
      mentions: [],
      metadata: undefined,
      forwardedBundleId: undefined,
      forwardedPreview: undefined,
    }),
  };
}

export function buildForwardPreview(
  sources: readonly MessageResponse[],
  reasons = placeholderReasons(sources),
): ForwardPreview {
  const source = sources[0];
  const createdAt = new Date().toISOString();
  if (sources.length === 1) {
    const { sender, ...item } = previewItem(source, reasons[decodeId(source.id)]);
    const forwardedFrom = showsForwardOrigin(source)
      ? (source.forwardedFrom ?? {
          originalChatId: source.chatId,
          originalMessageId: source.id,
          sender,
          originalReplyTo: source.replyToMessage,
        })
      : undefined;
    return {
      source,
      message: {
        ...item,
        createdAt,
        forwardedFrom,
        replyToMessage: undefined,
        replyRootId: undefined,
      },
    };
  }
  const items = sources
    .map((item) =>
      previewItem(
        item,
        item.messageType === MessageType.invite ? ForwardPlaceholder.GroupInvite : reasons[decodeId(item.id)],
      ),
    )
    .sort((a, b) => a.id - b.id);
  const byId = new Map(items.map((item) => [item.id, item]));
  const records = items.map((item) => {
    const quote = item.replyToMessage;
    const internal = quote && byId.get(quote.id);
    let replyToMessage = quote;
    if (internal) replyToMessage = { ...internal, mentions: internal.mentions ?? [] };
    else if (quote?.messageType === MessageType.invite)
      replyToMessage = { ...quote, messageType: MessageType.placeholder, message: ForwardPlaceholder.GroupInvite };
    return { ...item, redacted: !!replyToMessage?.isDeleted, replyToMessage };
  });
  return {
    source,
    records,
    message: {
      chatId: source.chatId,
      createdAt,
      messageType: MessageType.forwarded,
      attachments: [],
      forwardedPreview: {
        total: records.length,
        containsForwardedMessages: records.some((item) => item.forwardedBundleId != null),
        messages: records.slice(0, 3).map((item) => ({
          ...item,
          originalChatId: item.chatId,
          originalMessageId: item.id,
          originalCreatedAt: item.createdAt,
        })),
      },
    },
  };
}
