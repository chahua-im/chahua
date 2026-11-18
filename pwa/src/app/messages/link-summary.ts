import { LinkPreviewStatus, MessageType, type MessageMetadataResponse } from '../../generated/models';
import { markdownEngine } from '../markdown/engine';

/** Summarize a lone bare URL or empty-label Markdown link, using ready preview metadata when available. */
export function messageLinkSummary(message: {
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
  if (!text) return;
  let url = text;
  if (!/^https?:\/\/\S+$/i.test(url)) {
    if (!text.startsWith('[](')) return;
    const tokens = markdownEngine.parse(text, {});
    const inline = tokens.length === 3 && tokens[1].type === 'inline' ? tokens[1].children : undefined;
    if (inline?.length !== 2 || inline[0].type !== 'link_open' || inline[1].type !== 'link_close') return;
    const href = inline[0].attrGet('href');
    if (typeof href !== 'string' || !/^https?:\/\/\S+$/i.test(href)) return;
    url = href;
  }
  const previews = message.metadata?.linkPreviews;
  if (previews?.length !== 1) return { url };
  const preview = previews[0];
  if (preview.status !== LinkPreviewStatus.ready) return { url };
  try {
    const target = new URL(preview.url);
    if (new URL(url).href === target.href) return { url, title: preview.title || target.hostname };
  } catch {
    // Invalid or unmatched preview metadata leaves the URL visible.
  }
  return { url };
}
