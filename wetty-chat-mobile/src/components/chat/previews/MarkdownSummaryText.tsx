import { Fragment } from 'react';
import { isFeatureEnabled } from '@/features';
import { messageHasMarkdown } from '@/utils/markdown/detect';
import { renderMarkdownPreview } from '@/utils/markdown/preview';
import { truncatePreview } from '@/utils/messagePreview';

interface MarkdownSummaryTextProps {
  /** Formatted preview text (`@username` mentions, literal `[图片]` labels). */
  text: string;
  /**
   * Legacy plain-text truncation cap. On the Markdown path it is never applied
   * — long text is clipped by the parent's single-line CSS instead, so `**`
   * markers are never sliced mid-syntax.
   */
  maxLength?: number;
}

/**
 * Single-line summary for chat-list / thread / pin / reply / search previews.
 * Markdown text renders inline-flattened; otherwise the exact legacy plain
 * string (optionally truncated) is returned.
 */
export function MarkdownSummaryText({ text, maxLength }: MarkdownSummaryTextProps) {
  if (!text) return null;

  if (isFeatureEnabled('messageMarkdown') && messageHasMarkdown(text)) {
    return <Fragment>{renderMarkdownPreview(text)}</Fragment>;
  }

  return maxLength === undefined ? text : truncatePreview(text, maxLength);
}
