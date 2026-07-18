import {
  getChatBaseFont,
  getChatBubbleMaxWidth,
  getMessageLayoutStats,
  parseChatBubbleContentToRichItems,
} from '@/utils/chatTextMeasure';
import type { MessageResponse } from '@/api/messages';
import type { ChatRow } from './types';

/** Estimate the rendered height of a single message's bubble row. */
function estimateMessageHeight(message: MessageResponse, chatFontSizeStyle: string): number {
  if (message.isDeleted) return 48;

  let estimate = message.attachments?.length || message.sticker ? 220 : 76;

  if (message.messageType === 'text' && !message.attachments?.length && !message.sticker && message.message) {
    try {
      const fontSizeNum = parseInt(chatFontSizeStyle) || 14;
      const baseFont = getChatBaseFont(chatFontSizeStyle);
      const items = parseChatBubbleContentToRichItems(message.message, message.mentions, baseFont);
      const maxWidth = getChatBubbleMaxWidth();
      const stats = getMessageLayoutStats(items, maxWidth);
      const lineHeight = fontSizeNum * 1.4;
      estimate = stats.lineCount * lineHeight + 60;
    } catch {
      /* ignore measure errors */
    }
  }

  if (message.replyToMessage) {
    estimate += 26;
  }

  return Math.min(estimate, 3000);
}

export function estimateRowHeight(row: ChatRow, chatFontSizeStyle: string): number {
  if (row.type === 'date') return 32;

  // Group rows: sum the estimated height of each message in the group. Each
  // message is its own bubble row inside the SenderGroup, so the group's height
  // is the sum of its members (plus small inter-bubble margins absorbed by the
  // per-message estimate).
  return row.messages.reduce((sum, message) => sum + estimateMessageHeight(message, chatFontSizeStyle), 0);
}
