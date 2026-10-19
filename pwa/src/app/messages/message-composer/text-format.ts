/** Text edits for the composer's bold and italic keyboard shortcuts. */
import type { EditableText, MentionSpan } from './mention-text';

export type InlineFormatKind = 'bold' | 'italic';

export interface TextSelection {
  start: number;
  end: number;
}

export interface TextFormatResult extends EditableText {
  selectionStart: number;
  selectionEnd: number;
}

const WRAP_MARKERS: Record<InlineFormatKind, string> = {
  bold: '**',
  italic: '__',
};

function clampSelection(text: string, selection: TextSelection): TextSelection {
  const max = text.length;
  const rawStart = Number.isFinite(selection.start) ? selection.start : 0;
  const rawEnd = Number.isFinite(selection.end) ? selection.end : rawStart;
  const start = Math.max(0, Math.min(rawStart, max));
  const end = Math.max(start, Math.min(Math.max(rawEnd, rawStart), max));
  return { start, end };
}

/** Keep edge whitespace outside markers and format each selected paragraph separately. */
export function wrapInlineFormat(
  text: string,
  selection: TextSelection,
  kind: InlineFormatKind,
  mentions: readonly MentionSpan[] = [],
): TextFormatResult | null {
  const { start, end } = clampSelection(text, selection);
  if (start === end) return null;
  const marker = WRAP_MARKERS[kind];
  const insertions: number[] = [];
  let offset = start;
  const inserted = text
    .slice(start, end)
    .split(/(\r?\n(?:[ \t]*\r?\n)+)/)
    .map((part, index) => {
      const formatted =
        index % 2
          ? part
          : part.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_match, lead: string, body: string, trail: string) => {
              if (!body) return part;
              insertions.push(offset + lead.length, offset + part.length - trail.length);
              return `${lead}${marker}${body}${marker}${trail}`;
            });
      offset += part.length;
      return formatted;
    })
    .join('');
  const cursor = start + inserted.length;
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    // Formatting only inserts markers: map original offsets directly instead of
    // guessing which occurrence of a repeated display name is the mention.
    mentions: mentions
      .filter((mention) => !insertions.some((at) => at > mention.start && at < mention.end))
      .map((mention) => ({
        ...mention,
        start: mention.start + insertions.filter((at) => at <= mention.start).length * marker.length,
        end: mention.end + insertions.filter((at) => at < mention.end).length * marker.length,
      })),
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

/** Only Ctrl/Cmd+B and Ctrl/Cmd+I are handled by the composer. */
export function shortcutFormatKind(event: { key: string }): InlineFormatKind | null {
  switch (event.key.toLowerCase()) {
    case 'b':
      return 'bold';
    case 'i':
      return 'italic';
    default:
      return null;
  }
}
