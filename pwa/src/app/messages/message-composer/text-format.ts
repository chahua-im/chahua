/**
 * Pure, DOM-free text-editing helpers for the composer's formatting toolbar.
 * ComposeInput maps textarea selections to `TextSelection` and commits the
 * returned text back into the controlled value.
 */

export type InlineFormatKind = 'bold' | 'italic' | 'strike' | 'underline';

export type BlockFormatKind = 'code' | 'quote';

export type TextFormatKind = InlineFormatKind | 'link' | BlockFormatKind;

export interface TextSelection {
  start: number;
  end: number;
}

export interface TextFormatResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const WRAP_MARKERS: Record<InlineFormatKind, readonly [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  underline: ['__', '__'],
};

function clampSelection(text: string, selection: TextSelection): TextSelection {
  const max = text.length;
  const rawStart = Number.isFinite(selection.start) ? selection.start : 0;
  const rawEnd = Number.isFinite(selection.end) ? selection.end : rawStart;
  const start = Math.max(0, Math.min(rawStart, max));
  const end = Math.max(start, Math.min(Math.max(rawEnd, rawStart), max));
  return { start, end };
}

function insertAt(text: string, start: number, end: number, inserted: string): TextFormatResult {
  const next = `${text.slice(0, start)}${inserted}${text.slice(end)}`;
  const cursor = start + inserted.length;
  return { text: next, selectionStart: cursor, selectionEnd: cursor };
}

/**
 * Normalises a toolbar URL. Only `http:`/`https:` survive; anything else has
 * its scheme stripped and is re-prefixed with `https://`, so a crafted
 * `javascript:` URL can never become an anchor href.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:']);

export function normalizeLinkHref(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'https://';
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (SAFE_SCHEMES.has(`${scheme}:`)) return trimmed;
    const rest = trimmed.slice(schemeMatch[0].length);
    return `https://${rest}`;
  }
  return `https://${trimmed}`;
}

/**
 * Wraps the selected range in `**`/`*`/`~~`/`__` markers. Returns `null` on a
 * collapsed selection so a no-selection shortcut never injects stray markers.
 */
export function wrapInlineFormat(
  text: string,
  selection: TextSelection,
  kind: InlineFormatKind,
): TextFormatResult | null {
  const { start, end } = clampSelection(text, selection);
  if (start === end) return null;
  const [open, close] = WRAP_MARKERS[kind];
  return insertAt(text, start, end, `${open}${text.slice(start, end)}${close}`);
}

/**
 * Turns a selection into a fenced code block or a quote (every selected line
 * prefixed with `> `). Needs real content, like the inline formatters.
 */
export function wrapBlockFormat(
  text: string,
  selection: TextSelection,
  kind: BlockFormatKind,
): TextFormatResult | null {
  const { start, end } = clampSelection(text, selection);
  if (start === end) return null;
  const selected = text.slice(start, end);

  if (kind === 'quote') {
    const quoted = selected
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return insertAt(text, start, end, quoted);
  }

  const wrapped = `\`\`\`\n${selected}\n\`\`\``;
  return insertAt(text, start, end, wrapped);
}

/**
 * Turns a selection into `[selection](url)`. With no selection, inserts
 * `[text](url)` and selects the placeholder label so the user can type over it.
 */
export function applyLink(text: string, selection: TextSelection, rawUrl: string): TextFormatResult {
  const { start, end } = clampSelection(text, selection);
  const url = normalizeLinkHref(rawUrl);
  const label = text.slice(start, end);

  if (label) {
    return insertAt(text, start, end, `[${label}](${url})`);
  }

  const inserted = `[text](${url})`;
  const next = `${text.slice(0, start)}${inserted}${text.slice(end)}`;
  const labelStart = start + 1;
  return { text: next, selectionStart: labelStart, selectionEnd: labelStart + 'text'.length };
}

/** Ctrl/Cmd+B / I / D / U / Q shortcuts; `Q` is blockquote, never `link`. */
const SHORTCUT_KIND: Record<string, TextFormatKind> = {
  b: 'bold',
  B: 'bold',
  i: 'italic',
  I: 'italic',
  d: 'strike',
  D: 'strike',
  u: 'underline',
  U: 'underline',
  q: 'quote',
  Q: 'quote',
};

export function shortcutFormatKind(event: { key: string }): TextFormatKind | null {
  return SHORTCUT_KIND[event.key] ?? null;
}
