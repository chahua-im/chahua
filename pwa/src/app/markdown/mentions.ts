import { findCodeRegions } from './code-regions';
import { buildPlaceholder } from './placeholder';

interface MentionWidget {
  uid: number;
}

/**
 * Swaps every mention outside code regions for a markdown-safe placeholder.
 * The returned body is what gets parsed; widgets map placeholder slots back
 * to the original mentions while rendering.
 */
export function extractMentionWidgets(message: string): { body: string; widgets: MentionWidget[] } {
  const regions = findCodeRegions(message);
  const widgets: MentionWidget[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (const match of message.matchAll(/@\[uid:(\d+)\]/g)) {
    // Leave mentions inside code verbatim — carving them would lose the text.
    if (regions.some((region) => match.index! >= region.start && match.index! < region.end)) continue;
    parts.push(message.slice(cursor, match.index));
    widgets.push({ uid: Number(match[1]) });
    parts.push(buildPlaceholder(widgets.length - 1));
    cursor = match.index! + match[0].length;
  }
  if (cursor < message.length) parts.push(message.slice(cursor));
  return { body: parts.join(''), widgets };
}
