import { findCodeRegions } from '../../markdown/code-regions';

export interface MentionSpan {
  start: number;
  end: number;
  uid: number;
}
export interface EditableText {
  text: string;
  mentions: MentionSpan[];
}
export function displayText(wire: string, names: ReadonlyMap<number, string>): EditableText {
  let text = '';
  let last = 0;
  const mentions: MentionSpan[] = [];
  for (const match of wire.matchAll(/@\[uid:(\d+)\]/g)) {
    text += wire.slice(last, match.index);
    const start = text.length;
    const uid = Number(match[1]);
    text += '@' + (names.get(uid) || 'User ' + uid);
    mentions.push({ start, end: text.length, uid });
    last = match.index + match[0].length;
  }
  return { text: text + wire.slice(last), mentions };
}

/**
 * Serializes mentions back to wire macros. Mentions inside code regions stay
 * verbatim — a code mention renders as plain text and must never trigger a
 * backend reminder.
 */
export function wireText(value: EditableText): string {
  if (!value.mentions.length) return value.text;
  const regions = findCodeRegions(value.text);
  let text = '';
  let last = 0;
  for (const mention of value.mentions) {
    if (regions.some((region) => mention.start >= region.start && mention.start < region.end)) continue;
    text += value.text.slice(last, mention.start) + '@[uid:' + mention.uid + ']';
    last = mention.end;
  }
  return text + value.text.slice(last);
}

function indexOfClosestSubstring(haystack: string, needle: string, hint: number, from: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let index = haystack.indexOf(needle, from);
  while (index !== -1) {
    const distance = Math.abs(index - hint);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return best;
}

/**
 * Re-anchors mention spans (stored as absolute offsets into previous.text)
 * after the text has been edited into nextText.
 *
 * Edits entirely before or after a span shift it; edits touching the mention's
 * own span drop it — unless the mention text survives verbatim inside the
 * rewritten middle (e.g. wrapping `__@alice__` in emphasis), in which case the
 * span is re-located by searching for the text.
 */
function relocateMentions(previous: EditableText, nextText: string): MentionSpan[] {
  const previousText = previous.text;
  const entries = previous.mentions;
  if (!entries.length || previousText === nextText) return entries;

  const maxAnchor = Math.min(previousText.length, nextText.length);
  let prefix = 0;
  while (prefix < maxAnchor && previousText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < maxAnchor - prefix &&
    previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const changeStart = prefix;
  const changeEnd = previousText.length - suffix;
  const delta = nextText.length - previousText.length;
  const changedNew = nextText.slice(changeStart, nextText.length - suffix);

  const relocated: MentionSpan[] = [];
  let searchStart = 0;
  for (const entry of entries) {
    if (entry.end <= changeStart) {
      relocated.push(entry);
    } else if (entry.start >= changeEnd) {
      relocated.push({ ...entry, start: entry.start + delta, end: entry.end + delta });
    } else if (entry.start >= changeStart && entry.end <= changeEnd) {
      const raw = previousText.slice(entry.start, entry.end);
      const hint = entry.start - changeStart;
      const found = indexOfClosestSubstring(changedNew, raw, hint, searchStart);
      if (found !== -1) {
        relocated.push({ ...entry, start: changeStart + found, end: changeStart + found + raw.length });
        searchStart = found + raw.length;
      }
    }
  }
  return relocated;
}

/** Retain mention identity when an edit leaves the visible mention intact. */
export function editText(previous: EditableText, text: string): EditableText {
  return { text, mentions: relocateMentions(previous, text) };
}
