/**
 * Placeholder protocol that lets interactive widgets (`@[uid:N]`, invite
 * links, `/m/…` permalinks) survive a Markdown parse. The caller swaps each
 * widget for an invisible `\uFFF0<index>\uFFF1` sequence before parsing and
 * restores it while rendering text tokens. Widgets are carved only outside
 * code spans/fences, since code content renders verbatim and never reaches the
 * restore hook.
 */
const OPEN = 0xfff0;
const CLOSE = 0xfff1;

export const PLACEHOLDER_OPEN = String.fromCharCode(OPEN);
export const PLACEHOLDER_CLOSE = String.fromCharCode(CLOSE);

export interface PlaceholderSpan {
  index: number;
  start: number;
  end: number;
}

export function buildPlaceholder(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`placeholder index must be a non-negative safe integer, got ${index}`);
  }
  return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
}

export function containsPlaceholder(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === OPEN) return true;
  }
  return false;
}

export function findPlaceholders(text: string): PlaceholderSpan[] {
  const spans: PlaceholderSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== OPEN) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let index = 0;
    let digits = 0;
    while (j < text.length) {
      const code = text.charCodeAt(j);
      if (code >= 0x30 && code <= 0x39) {
        index = index * 10 + (code - 0x30);
        digits += 1;
        j += 1;
      } else {
        break;
      }
    }
    if (digits > 0 && j < text.length && text.charCodeAt(j) === CLOSE) {
      spans.push({ index, start: i, end: j + 1 });
      i = j + 1;
    } else {
      i = j;
    }
  }
  return spans;
}

/**
 * Splits text into plain chunks and placeholder spans so a renderer can
 * interleave restored components with the surrounding text.
 */
export function splitByPlaceholders(text: string): ReadonlyArray<string | PlaceholderSpan> {
  if (text.length === 0) return [];
  const parts: Array<string | PlaceholderSpan> = [];
  let last = 0;
  for (const span of findPlaceholders(text)) {
    if (span.start > last) parts.push(text.slice(last, span.start));
    parts.push(span);
    last = span.end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
