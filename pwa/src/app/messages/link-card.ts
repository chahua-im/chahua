import { LinkPreviewStatus, MessageType, type MessageMetadataResponse } from '../../generated/models';

/** Detect a lone URL with a ready preview for compact sharing summaries. */
export function messageLinkCard(message: {
  messageType: MessageType;
  message?: string;
  isDeleted?: boolean;
  attachments: readonly unknown[];
  sticker?: unknown;
  metadata?: MessageMetadataResponse;
}) {
  if (message.isDeleted || message.messageType !== MessageType.text || message.attachments.length || message.sticker)
    return;
  const text = message.message?.trim();
  const previews = message.metadata?.linkPreviews;
  if (!text || !/^https?:\/\/\S+$/i.test(text) || previews?.length !== 1) return;
  const preview = previews[0];
  if (preview.status !== LinkPreviewStatus.ready) return;
  try {
    return new URL(text).href === new URL(preview.url).href ? preview : undefined;
  } catch {
    // Invalid URL text remains visible as an ordinary message.
    return;
  }
}
